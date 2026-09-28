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

/**
 * Is this the ACCOUNT refusing, rather than this video?
 *
 * An empty credit balance is not a property of any one video, and treating it
 * as one cost a week of output. Every render the poster tried while SubMagic
 * answered 402 INSUFFICIENT_CREDITS was marked post-failed - and the poster
 * only ever reads ready-to-post, so each of those videos was stranded for good.
 * The daily run went on rendering four more a day, which met the same wall
 * and were stranded in turn. Nothing published from 09-21 to 09-28, and
 * topping up alone would not have brought any of them back.
 *
 * Keyed on the status AND the body: 402 is the honest code for this, but a
 * publisher that reports billing trouble under another status still says so
 * in the body, and missing it means stranding videos again.
 */
export function isAccountBlocked(err) {
  if (!err) return false;
  if (err.status === 402) return true;
  return /INSUFFICIENT_CREDITS|insufficient (api )?credits|payment required/i.test(
    `${err.message || ''} ${err.body || ''}`,
  );
}

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

/**
 * What makes two renders the same video, as far as an audience can tell.
 *
 * A script can be rendered more than once - requeued for a fix, or written
 * twice from two winners that shared an idea - and each render is its own row.
 * Both keys are checked: the script id catches a re-render of one script, the
 * title catches two scripts that came out identical, which a viewer would see
 * as a repost all the same.
 */
export const contentKey = (title) =>
  String(title || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

const keysOf = (row) =>
  [row.scriptId && `s:${row.scriptId}`, row.title && `t:${contentKey(row.title)}`].filter(Boolean);

/** A hosted URL outlives the runner that rendered the video; a local path does
 * not. Either is enough to publish from. */
const haveVideo = (render) =>
  Boolean(render.videoUrl) || Boolean(render.videoPath && fs.existsSync(render.videoPath));

export async function post({
  limit,
  platforms = config.post.platforms,
  store = getStore(),
  // Injectable for the same reason drain's is: the failure this guards against
  // is a live account running dry, which no test should have to reproduce.
  provider = config.dryRun ? null : PUBLISHERS[config.post.provider],
} = {}) {
  log.banner('SKILL 04 / THE POSTER', 'It posts itself.');

  // Publish anything we are already holding before taking on more.
  const drained = await drain({ store, platforms, provider });

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

  // Oldest first, but over the whole queue rather than the first `rate` rows.
  // Renders made before hosting existed have no URL and no surviving file, and
  // picking one used to fail the entire run while publishable rows sat behind
  // it untouched.
  const waiting = await store.list(TABLES.RENDERS, {
    where: (r) => r.status === 'ready-to-post',
    sort: (a, b) => String(a.renderedAt).localeCompare(String(b.renderedAt)),
  });

  for (const r of waiting.filter((x) => !haveVideo(x))) {
    // Retire rather than skip, or every future run pays the same cost to reach
    // the same conclusion. The script stays designed, so a requeue can
    // re-render it whenever it is wanted.
    log.warn(`"${r.title}" has no hosted URL and no local file - needs re-rendering`);
    await store.patch(TABLES.RENDERS, r.id, { status: 'needs-rerender' });
  }

  // Never publish the same video twice to one platform.
  //
  // Recovering a week of renders stranded by an empty SubMagic account brought
  // back two copies each of "How Shazam Recognizes Any Song Instantly" and
  // "Why Ancient Roman Concrete Heals Itself" - both already scheduled to
  // YouTube on 09-21. Nothing checked that a render's content was already out,
  // so a top-up would have reposted both. Render rows are a record of work
  // done, not of what the audience has seen; this asks the posts table, which
  // is.
  const live = new Map(platforms.map((p) => [p, new Set()]));
  for (const e of history) {
    if (DEAD_POST_STATUS.has(e.status) || !live.has(e.platform)) continue;
    for (const k of keysOf(e)) live.get(e.platform).add(k);
  }
  const inBatch = new Map(platforms.map((p) => [p, new Set()]));
  const duePlatforms = new Map();
  const renders = [];
  for (const r of waiting.filter(haveVideo)) {
    const keys = keysOf(r);
    const due = platforms.filter((p) => !keys.some((k) => live.get(p).has(k)));
    if (!due.length) {
      // Already out everywhere it was meant for. Retired so every later run
      // does not pay to reach the same conclusion.
      log.warn(`"${r.title}" is already live on ${platforms.join(', ')} - retiring the duplicate`);
      await store.patch(TABLES.RENDERS, r.id, { status: 'duplicate' });
      continue;
    }
    // A second unposted copy in this same run is only held back, not retired:
    // if the first fails on its own merits, this one is still there to go.
    const fresh = due.filter((p) => !keys.some((k) => inBatch.get(p).has(k)));
    if (!fresh.length || renders.length >= rate) continue;
    for (const p of fresh) for (const k of keys) inBatch.get(p).add(k);
    duePlatforms.set(r.id, fresh);
    renders.push(r);
  }
  if (!renders.length) {
    log.warn('nothing rendered and waiting - run the designer first');
    return drained;
  }
  log.info(`INPUT: ${renders.length} finished posts`);

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
    const due = renders.filter((r) => duePlatforms.get(r.id).includes(platform));
    const slots = nextSlots(platform, due.length, takenByPlatform.get(platform) || []);
    for (const [i, render] of due.entries()) {
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
          // NOT uploadedUrl: that is how the publisher reaches the file, not
          // something about the post. It was written here by mistake and
          // Airtable rejected the whole row for the unknown column - after
          // both videos had already been scheduled, leaving the schedule real
          // and our record of it empty.
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

  const announce = (row) =>
    log.info(`  ${row.platform.padEnd(9)} ${row.publishAtLocal} ${config.post.timezone}  "${row.title}"`);

  // Set when the account itself refuses. Everything from that point on is left
  // exactly as it was - ready-to-post, no failed rows - so the next run after
  // a top-up resumes where this one stopped instead of starting from nothing.
  let blocked = null;

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
        if (isAccountBlocked(err)) {
          blocked = err;
          break;
        }
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
        if (isAccountBlocked(err)) {
          blocked = err;
          break;
        }
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
    // Never attempted - stopped by the account, or no free slot yet. Neither
    // says anything about the video, so it keeps its place in the queue.
    // Marking it post-failed is what stranded a week of renders.
    if (!mine.length) continue;
    const ok = mine.filter((s) => s.status !== 'schedule-failed').length;
    // Measured against the platforms it was due on, not all of them - one
    // already live elsewhere is not a platform this run failed to reach.
    const expected = duePlatforms.get(render.id).length;
    await store.patch(TABLES.RENDERS, render.id, {
      status: ok === expected ? 'posted' : ok > 0 ? 'partially-posted' : 'post-failed',
    });
  }

  const ok = scheduled.filter((s) => s.status !== 'schedule-failed').length;
  log.info(`OUTPUT: ${ok}/${scheduled.length} scheduled across ${platforms.join(', ')}`);

  if (blocked) {
    const done = new Set(scheduled.map((s) => s.renderId));
    const waitingNow = renders.filter((r) => !done.has(r.id)).length;
    // Still a failure - an unattended machine that cannot publish has to say
    // so - but a recoverable one, and the message says which kind.
    throw new Error(
      `the ${provider.name} account refused to publish (${blocked.message}). ` +
        `${waitingNow} video(s) left ready-to-post, nothing lost - ` +
        'the next run resumes once the account can pay',
    );
  }
  reportBatch(log, { attempted: scheduled.length, succeeded: ok, errors });
  return [...drained, ...scheduled];
}

export default post;
