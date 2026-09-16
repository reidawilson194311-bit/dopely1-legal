/**
 * SKILL 04 / THE POSTER  -  "It posts itself."
 *
 *   INPUT   takes the finished posts
 *   ENGINE  auto-post - pick your tool, runs on a schedule
 *   OUTPUT  Instagram, TikTok and YouTube. Every day, forever.
 *
 * Nobody approves it. Nobody is home.
 */
import fs from 'node:fs';
import { config } from '../config.js';
import { logger } from '../lib/log.js';
import { getStore, TABLES } from '../lib/store/index.js';
import { nextSlots, formatLocal } from '../lib/schedule.js';
import { newId } from '../lib/id.js';
import { reportBatch } from '../lib/batch.js';
import { rampedRate, rampNote } from '../lib/ramp.js';
import metricool from '../lib/publishers/metricool.js';
import unipile from '../lib/publishers/unipile.js';

const log = logger('04-post');

const PUBLISHERS = { metricool, unipile };

/** Trim a caption to the platform's limit and append its hashtags. */
export function composeCaption(render, platform) {
  const LIMITS = { instagram: 2200, tiktok: 2200, youtube: 5000 };
  const body = render.captions?.[platform] || render.title;
  const tags = (render.hashtags?.[platform] || []).map((t) => `#${String(t).replace(/^#/, '')}`);
  const cta = render.cta ? `\n\n${render.cta}` : '';
  const tail = tags.length ? `\n\n${tags.join(' ')}` : '';
  const full = `${body}${cta}${tail}`;
  const limit = LIMITS[platform] || 2200;
  return full.length <= limit ? full : `${full.slice(0, limit - 1).trimEnd()}…`;
}

/**
 * Publish everything whose slot has come due.
 *
 * Needed because not every publisher can schedule ahead. Metricool takes a
 * publication date and owns the post from that moment; Unipile publishes
 * immediately and has no concept of "later". Without a drain, every Unipile
 * post sat in the table marked done and was never uploaded at all - the
 * schedule existed only on paper.
 *
 * Safe to call as often as you like: it only touches rows that are still
 * 'queued' and already due, and it is the single place a queued row becomes
 * 'published'.
 */
export async function drain({
  store = getStore(),
  platforms = config.platforms,
  now = new Date(),
  // Injectable so the publish path can be tested without a live account -
  // this is the code whose absence meant Unipile never uploaded anything.
  provider = config.dryRun ? null : PUBLISHERS[config.post.provider],
} = {}) {
  if (!provider) return [];

  const due = await store.list(TABLES.POSTS, {
    where: (r) =>
      r.status === 'queued' &&
      platforms.includes(r.platform) &&
      r.publishAt &&
      new Date(r.publishAt).getTime() <= now.getTime(),
    sort: (a, b) => String(a.publishAt).localeCompare(String(b.publishAt)),
  });
  if (!due.length) return [];

  log.info(`draining ${due.length} post(s) whose slot is due`);
  const published = [];
  const errors = [];

  for (const row of due) {
    try {
      if (!row.videoPath || !fs.existsSync(row.videoPath)) {
        throw new Error(`rendered video missing: ${row.videoPath}`);
      }
      const payload = {
        platform: row.platform,
        caption: row.caption,
        youtubeTitle: row.youtubeTitle,
        videoPath: row.videoPath,
        // Due now - tell the publisher to go, not to wait.
        publishAt: now,
      };
      if (provider.name === 'metricool') payload.videoUrl = await provider.uploadMedia(row.videoPath);
      const res = await provider.schedule(payload);
      const patched = await store.patch(TABLES.POSTS, row.id, {
        status: 'published',
        externalId: res.externalId,
        provider: provider.name,
        publishedAt: now.toISOString(),
        error: '',
      });
      published.push(patched || row);
      log.info(`  published ${row.platform.padEnd(9)} "${row.title}"`);
    } catch (err) {
      // Stays 'queued' so the next drain retries it. A transient upload
      // failure must not silently cost us the post.
      await store.patch(TABLES.POSTS, row.id, { error: err.message });
      errors.push(`${row.platform}: ${err.message}`);
      log.error(`  publishing failed, will retry next drain`, err.message);
    }
  }

  reportBatch(log, { attempted: due.length, succeeded: published.length, errors });
  return published;
}

export async function post({ limit, platforms = config.platforms } = {}) {
  log.banner('SKILL 04 / THE POSTER', 'It posts itself.');
  const store = getStore();

  // Publish anything we are already holding before taking on more.
  const drained = await drain({ store, platforms });

  // The ramp is measured from the first post this machine ever scheduled, so
  // it survives restarts and gaps. An explicit --limit always wins.
  const history = await store.list(TABLES.POSTS);
  const firstPostAt = history.reduce(
    (min, r) => (r.publishAt && (!min || r.publishAt < min) ? r.publishAt : min),
    null,
  );
  const rate =
    limit ??
    rampedRate({
      start: config.post.perRun,
      target: config.post.rampTo,
      days: config.post.rampDays,
      firstPostAt,
    });
  if (limit === undefined) {
    log.info(rampNote({
      start: config.post.perRun,
      target: config.post.rampTo,
      days: config.post.rampDays,
      firstPostAt,
      rate,
    }));
  }

  const renders = await store.list(TABLES.RENDERS, {
    where: (r) => r.status === 'ready-to-post',
    sort: (a, b) => String(a.renderedAt).localeCompare(String(b.renderedAt)),
    limit: rate,
  });
  if (!renders.length) {
    log.warn('nothing rendered and waiting - run the designer first');
    return drained;
  }
  log.info(`INPUT: ${renders.length} finished posts`);

  const provider = config.dryRun ? null : PUBLISHERS[config.post.provider];
  if (!config.dryRun && !provider) {
    log.warn(`PUBLISH_PROVIDER=${config.post.provider} - scheduling locally only, nothing will go live`);
  }

  // Never double-book a slot across runs.
  const takenByPlatform = new Map(
    platforms.map((p) => [p, history.filter((e) => e.platform === p).map((e) => e.publishAt)]),
  );

  const scheduled = [];
  const errors = [];
  for (const platform of platforms) {
    const slots = nextSlots(platform, renders.length, takenByPlatform.get(platform) || []);
    for (const [i, render] of renders.entries()) {
      const when = slots[i];
      if (!when) {
        log.warn(`no free ${platform} slot inside ${config.post.horizonDays} days`);
        break;
      }
      const caption = composeCaption(render, platform);
      const row = {
        id: newId('pst'),
        renderId: render.id,
        scriptId: render.scriptId,
        platform,
        title: render.title,
        caption,
        youtubeTitle: render.youtubeTitle,
        videoPath: render.videoPath,
        publishAt: when.toISOString(),
        publishAtLocal: formatLocal(when),
        timezone: config.post.timezone,
        provider: provider?.name || 'local-queue',
        // 'queued' means we still owe this upload; 'scheduled' means the
        // provider owns it from here. Only 'queued' is ever drained.
        status: provider ? 'scheduled' : 'queued',
        externalId: null,
      };

      try {
        if (provider) {
          if (!render.videoPath || !fs.existsSync(render.videoPath)) {
            throw new Error(`rendered video missing: ${render.videoPath}`);
          }
          const payload = {
            platform,
            caption,
            publishAt: when,
            youtubeTitle: render.youtubeTitle,
            videoPath: render.videoPath,
          };
          // Metricool schedules from a hosted URL; Unipile takes the file.
          if (provider.name === 'metricool') payload.videoUrl = await provider.uploadMedia(render.videoPath);
          const res = await provider.schedule(payload);
          row.externalId = res.externalId;
          if (res.queuedLocally) {
            // The provider cannot schedule ahead (Unipile publishes
            // immediately), so we hold it and drain it when its slot is due.
            row.provider = 'local-queue';
            row.status = 'queued';
          } else if (res.publishedNow) {
            row.status = 'published';
            row.publishedAt = new Date().toISOString();
          }
        }
        scheduled.push(row);
        log.info(`  ${platform.padEnd(9)} ${row.publishAtLocal} ${config.post.timezone}  "${render.title}"`);
      } catch (err) {
        row.status = 'schedule-failed';
        row.error = err.message;
        scheduled.push(row);
        log.error(`  ${platform} scheduling failed`, err.message);
        errors.push(`${platform}: ${err.message}`);
      }
    }
  }

  if (scheduled.length) await store.upsert(TABLES.POSTS, scheduled);

  // A render is only "posted" once every platform it was meant for took it.
  for (const render of renders) {
    const mine = scheduled.filter((s) => s.renderId === render.id);
    const ok = mine.filter((s) => s.status !== 'schedule-failed').length;
    await store.patch(TABLES.RENDERS, render.id, {
      status: ok === platforms.length ? 'posted' : ok > 0 ? 'partially-posted' : 'post-failed',
    });
  }

  const ok = scheduled.filter((s) => s.status !== 'schedule-failed').length;
  log.info(`OUTPUT: ${ok}/${scheduled.length} scheduled across ${platforms.join(', ')}`);
  reportBatch(log, { attempted: scheduled.length, succeeded: ok, errors });
  return [...drained, ...scheduled];
}

export default post;
