/**
 * SKILL 01b / THE NEWS DESK  -  "It reads the wires."
 *
 *   INPUT   independent news feeds
 *   ENGINE  cluster by story, rank by how many outlets carried it
 *   OUTPUT  notable recent events, ready for the copywriter
 *
 * The sibling of skill 01. That one asks "what performed well"; this asks
 * "what actually happened", because news has no view count to sort by.
 *
 * Only headlines, summaries and links are read. Nothing from a feed is
 * republished - the writer works from what happened, and the designer draws
 * the scene rather than reusing anyone's photograph.
 */
import { NICHE } from '../niche.js';
import { config } from '../config.js';
import { logger } from '../lib/log.js';
import { getStore, TABLES } from '../lib/store/index.js';
import { fetchFeed } from '../lib/rss.js';
import { clusterStories, rankStories } from '../lib/cluster.js';
import { findDuplicate, contentTokens } from '../lib/similarity.js';
import { harshMatch } from '../lib/newsfilter.js';
import { reportBatch } from '../lib/batch.js';
import { newId } from '../lib/id.js';

const log = logger('01b-news');

/**
 * A stable id for a headline.
 *
 * Stable for the SAME headline, which is what feeds mostly serve on a re-read.
 * It is deliberately not stemmed: "delayed" and "delays" therefore produce
 * different ids, and that is the safer failure. Stemming hard enough to unify
 * them also collides genuinely different stories onto one id, where the second
 * silently overwrites the first - a story lost without trace, rather than a
 * story checked twice.
 *
 * Catching the same event under rewritten wording is findDuplicate's job
 * below, which compares topics rather than keys and survives a full rewrite.
 */
export function storyId(title) {
  const slug = [...contentTokens(title)].sort().join('-').slice(0, 60);
  return `news_${slug || newId('x')}`;
}

export async function researchNews({ feeds = NICHE.newsFeeds, now = new Date() } = {}) {
  log.banner('SKILL 01b / THE NEWS DESK', 'It reads the wires.');
  const store = getStore();
  const errors = [];

  if (config.dryRun) {
    log.warn('dry-run: not fetching feeds');
    return [];
  }

  // Concurrently, for the reason skill 01 learned the hard way: ten feeds one
  // after another costs the sum of ten timeouts when one outlet is slow.
  log.info(`reading ${feeds.length} feeds`);
  const results = await Promise.all(
    feeds.map(async ({ source, url }) => {
      try {
        return { source, items: await fetchFeed(url, { source }) };
      } catch (err) {
        return { source, error: err };
      }
    }),
  );

  const all = [];
  for (const { source, items, error } of results) {
    if (error) {
      // One dead feed is a quiet day, not a broken stage.
      log.warn(`${source} unavailable`, error.message);
      errors.push(`${source}: ${error.message}`);
      continue;
    }
    log.debug(`  ${source}: ${items.length} items`);
    all.push(...items);
  }

  reportBatch(log, { attempted: feeds.length, succeeded: feeds.length - errors.length, errors });

  const cutoff = now.getTime() - config.news.lookbackHours * 36e5;
  // An item with no date is dropped rather than assumed fresh: feeds carry
  // evergreen pages, and an undated one is exactly what a stale page looks
  // like. Better to miss a story than to report last year's as breaking.
  const recent = all.filter((i) => i.publishedAt && i.publishedAt.getTime() >= cutoff);
  log.info(`${all.length} items -> ${recent.length} inside ${config.news.lookbackHours}h`);

  // Drop violence before clustering, not after. A harsh item left in the pool
  // still pulls its cluster's title and still occupies one of the keepTop
  // slots that a coverable story would have had.
  const dropped = [];
  const safe = recent.filter((i) => {
    const hit = harshMatch(`${i.title} ${i.summary || ''}`);
    if (hit) dropped.push({ title: i.title, hit });
    return !hit;
  });
  if (dropped.length) {
    log.info(`${dropped.length} item(s) dropped as too harsh to cover`);
    for (const d of dropped.slice(0, 5)) log.debug(`  [${d.hit}] ${d.title.slice(0, 66)}`);
  }

  const clusters = clusterStories(safe);
  const stories = rankStories(clusters, {
    minSources: config.news.minSources,
    minInterest: config.news.minInterest,
    minInterestUncorroborated: config.news.minInterestUncorroborated,
    primarySources: feeds.filter((f) => f.primary).map((f) => f.source),
    keepTop: config.news.keepTop,
    now,
  });
  log.info(
    `${clusters.length} distinct stories -> ${stories.length} attested and ` +
      `interesting (${config.news.minSources}+ outlets or primary, ` +
      `interest >= ${config.news.minInterest})`,
  );
  if (!stories.length) return [];

  // Screened again on the merged story, because a cluster's summary is built
  // from several outlets and can carry wording that no single kept item had.
  const coverable = stories.filter((s2) => {
    const hit = harshMatch(`${s2.title} ${s2.summary || ''}`);
    if (hit) log.debug(`  dropped on merge [${hit}] ${s2.title.slice(0, 60)}`);
    return !hit;
  });
  if (!coverable.length) return [];

  // Do not cover the same event twice. Compared against what we have already
  // taken, by topic rather than by headline, since outlets reword freely.
  const existing = await store.list(TABLES.WINNERS);
  const seen = existing.map((w) => ({ text: w.hook || '', tokens: contentTokens(w.hook || '') }));

  const rows = [];
  for (const s of coverable) {
    const dupe = findDuplicate(s.title, seen);
    if (dupe) {
      log.debug(`  already covered: "${s.title.slice(0, 60)}"`);
      continue;
    }
    seen.push({ text: s.title, tokens: contentTokens(s.title) });
    rows.push({
      id: storyId(s.title),
      niche: NICHE.id,
      platform: 'news',
      // The writer reads `hook` as the idea to work from, so the headline goes
      // there - it is what the story IS, not a line to be reused verbatim.
      hook: s.title,
      caption: s.summary,
      url: s.url,
      // Corroboration stands in for views: this is how many outlets ran it.
      views: s.sourceCount,
      viralMultiple: s.sourceCount,
      sourceOutlets: s.sources.join(', '),
      ageHours: s.ageHours,
      status: 'winner',
      scrapedAt: new Date().toISOString(),
    });
  }

  const fresh = rows.filter((r) => !existing.some((e) => e.id === r.id));
  if (rows.length) await store.upsert(TABLES.WINNERS, rows);
  log.info(`saved to ${store.driver}: ${fresh.length} new, ${rows.length - fresh.length} refreshed`);

  // Print the score and what earned it. A ranking nobody can explain is a
  // ranking nobody can correct - if the batch comes back dull, this line says
  // which word list needs the edit.
  //
  // Read off the ranked stories, NOT off the rows: the score is deliberately
  // not a stored column. Airtable rejects the whole write for one unknown
  // field, and this project has paid that toll three times already. A number
  // used to sort one batch and then never read again does not earn a schema
  // migration.
  for (const s of coverable.slice(0, 5)) {
    log.debug(
      `  +${String(s.interest).padStart(2)}  ${String(s.sourceCount).padStart(2)} outlets  ` +
        `${String(s.ageHours).padStart(3)}h  ${s.title.slice(0, 56)}  [${s.bright.slice(0, 4).join(' ')}]`,
    );
  }
  return rows;
}

export default researchNews;
