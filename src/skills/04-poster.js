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

export async function post({ limit = config.post.perRun, platforms = config.platforms } = {}) {
  log.banner('SKILL 04 / THE POSTER', 'It posts itself.');
  const store = getStore();

  const renders = await store.list(TABLES.RENDERS, {
    where: (r) => r.status === 'ready-to-post',
    sort: (a, b) => String(a.renderedAt).localeCompare(String(b.renderedAt)),
    limit,
  });
  if (!renders.length) {
    log.warn('nothing rendered and waiting - run the designer first');
    return [];
  }
  log.info(`INPUT: ${renders.length} finished posts`);

  const provider = config.dryRun ? null : PUBLISHERS[config.post.provider];
  if (!config.dryRun && !provider) {
    log.warn(`PUBLISH_PROVIDER=${config.post.provider} - scheduling locally only, nothing will go live`);
  }

  // Never double-book a slot across runs.
  const existing = await store.list(TABLES.POSTS);
  const takenByPlatform = new Map(
    platforms.map((p) => [p, existing.filter((e) => e.platform === p).map((e) => e.publishAt)]),
  );

  const scheduled = [];
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
        status: 'scheduled',
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
          if (res.queuedLocally) row.provider = 'local-queue';
        }
        scheduled.push(row);
        log.info(`  ${platform.padEnd(9)} ${row.publishAtLocal} ${config.post.timezone}  "${render.title}"`);
      } catch (err) {
        row.status = 'schedule-failed';
        row.error = err.message;
        scheduled.push(row);
        log.error(`  ${platform} scheduling failed`, err.message);
      }
    }
  }

  if (scheduled.length) await store.upsert(TABLES.POSTS, scheduled);

  // A render is only "posted" once every platform it was meant for took it.
  for (const render of renders) {
    const mine = scheduled.filter((s) => s.renderId === render.id);
    const ok = mine.filter((s) => s.status === 'scheduled').length;
    await store.patch(TABLES.RENDERS, render.id, {
      status: ok === platforms.length ? 'posted' : ok > 0 ? 'partially-posted' : 'post-failed',
    });
  }

  const ok = scheduled.filter((s) => s.status === 'scheduled').length;
  log.info(`OUTPUT: ${ok}/${scheduled.length} scheduled across ${platforms.join(', ')}`);
  return scheduled;
}

export default post;
