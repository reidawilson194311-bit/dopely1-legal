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
import submagic from '../lib/publishers/submagic.js';

const log = logger('04-post');

/** Statuses whose publishAt will never be used, so their slot is free again. */
export const DEAD_POST_STATUS = new Set(['superseded', 'schedule-failed', 'post-failed', 'cancelled']);

const PUBLISHERS = { submagic, metricool, unipile };

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
  platforms = config.post.platforms,
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

export async function post({ limit, platforms = config.post.platforms } = {}) {
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

  // Never double-book a slot across runs - but only a post that is actually
  // going to happen holds one.
  //
  // This counted every row, so a retired or failed post kept a time nothing
  // would ever publish at and pushed the next real one further out. Six
  // superseded rows and two failures filled both of today's YouTube slots and
  // both of tomorrow's, putting the first working video two days away, and the
  // gap would have grown with every dead row.
  //
  // Deliberately an exclusion list rather than an inclusion one: mistaking a
  // live post for a dead one double-books a slot and publishes two videos at
  // the same minute, which is worse than drifting.
  const takenByPlatform = new Map(
    platforms.map((p) => [
      p,
      history
        .filter((e) => e.platform === p && !DEAD_POST_STATUS.has(e.status))
        .map((e) => e.publishAt),
    ]),
  );

  const scheduled = [];
  const errors = [];

  // Plan every row first, provider-agnostic. Which platform goes out when is
  // the machine's decision; how it gets there is the publisher's.
  const planned = [];
  for (const platform of platforms) {
    const slots = nextSlots(platform, renders.length, takenByPlatform.get(platform) || []);
    for (const [i, render] of renders.entries()) {
      const when = slots[i];
      if (!when) {
        log.warn(`no free ${platform} slot inside ${config.post.horizonDays} days`);
        break;
      }
      const caption = composeCaption(render, platform);
      planned.push({
        render,
        when,
        row: {
          id: newId('pst'),
          renderId: render.id,
          scriptId: render.scriptId,
          platform,
          title: render.title,
          caption,
          youtubeTitle: render.youtubeTitle,
          videoPath: render.videoPath,
          uploadedUrl: render.videoUrl || null,
          publishAt: when.toISOString(),
          publishAtLocal: formatLocal(when),
          timezone: config.post.timezone,
          provider: provider?.name || 'local-queue',
          // 'queued' means we still owe this upload; 'scheduled' means the
          // provider owns it from here. Only 'queued' is ever drained.
          status: provider ? 'scheduled' : 'queued',
          externalId: null,
        },
      });
    }
  }

  // A hosted URL outlives the runner that rendered the video; the local path
  // does not. Either is enough to publish from.
  const haveVideo = (render) =>
    Boolean(render.videoUrl) || Boolean(render.videoPath && fs.existsSync(render.videoPath));
  const announce = (row) =>
    log.info(`  ${row.platform.padEnd(9)} ${row.publishAtLocal} ${config.post.timezone}  "${row.title}"`);

  if (provider?.batched) {
    // One upload, one project, every platform in a single call. Three separate
    // projects for one video would triple the account's usage to stagger the
    // posts by a couple of hours.
    const byRender = new Map();
    for (const item of planned) {
      if (!byRender.has(item.render.id)) byRender.set(item.render.id, []);
      byRender.get(item.render.id).push(item);
    }

    for (const group of byRender.values()) {
      const { render } = group[0];
      try {
        if (!haveVideo(render)) {
          throw new Error(
            `rendered video missing: no hosted URL and no file at ${render.videoPath}`,
          );
        }
        const res = await provider.scheduleBatch({
          videoPath: render.videoPath,
          uploadedUrl: render.videoUrl || null,
          title: render.title,
          entries: group.map(({ row }) => ({
            platform: row.platform,
            caption: row.caption,
            youtubeTitle: row.youtubeTitle,
            publishAt: row.publishAt,
          })),
        });
        for (const { row } of group) {
          row.externalId = res.externalId;
          // All platforms in a batch share one publish time.
          if (res.scheduledFor) {
            row.publishAt = res.scheduledFor;
            row.publishAtLocal = formatLocal(new Date(res.scheduledFor));
          } else {
            row.status = 'published';
            row.publishedAt = new Date().toISOString();
          }
          scheduled.push(row);
          announce(row);
        }
      } catch (err) {
        for (const { row } of group) {
          row.status = 'schedule-failed';
          row.error = err.message;
          scheduled.push(row);
        }
        log.error(`  "${render.title}" failed`, err.message);
        errors.push(`${render.title}: ${err.message}`);
      }
    }
  } else {
    for (const { render, when, row } of planned) {
      try {
        if (provider) {
          if (!haveVideo(render)) {
            throw new Error(
              `rendered video missing: no hosted URL and no file at ${render.videoPath}`,
            );
          }
          const payload = {
            platform: row.platform,
            caption: row.caption,
            publishAt: when,
            youtubeTitle: render.youtubeTitle,
            videoPath: render.videoPath,
            uploadedUrl: render.videoUrl || null,
          };
          // Metricool schedules from a hosted URL; Unipile takes the file.
          if (provider.name === 'metricool') {
            payload.videoUrl = await provider.uploadMedia(render.videoPath);
          }
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
        announce(row);
      } catch (err) {
        row.status = 'schedule-failed';
        row.error = err.message;
        scheduled.push(row);
        log.error(`  ${row.platform} scheduling failed`, err.message);
        errors.push(`${row.platform}: ${err.message}`);
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
