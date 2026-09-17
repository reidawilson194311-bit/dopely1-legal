/**
 * SKILL 01 / THE RESEARCHER  -  "It goes shopping."
 *
 *   top accounts (any niche)  ->  Apify scrape  ->  scored winners in the store
 *
 * It does not guess what works. It copies what already did.
 */
import { config } from '../config.js';
import { NICHE } from '../niche.js';
import { logger } from '../lib/log.js';
import { getStore, TABLES } from '../lib/store/index.js';
import { runActor, actorInput } from '../lib/apify.js';
import { normalize } from '../lib/normalize.js';
import { pickWinners } from '../lib/score.js';
import { fakeScrape } from '../lib/fixtures.js';
import { reportBatch } from '../lib/batch.js';

const log = logger('01-research');

async function scrape(platform, handles) {
  const limit = config.research.postsPerAccount;
  if (config.dryRun) {
    log.debug(`dry-run: synthesising ${platform} items`);
    return fakeScrape(platform, handles, limit);
  }
  const actor = config.research.actors[platform];
  const input = actorInput[platform](handles, limit);
  return runActor(actor, input);
}

export async function research({ platforms = config.platforms } = {}) {
  log.banner('SKILL 01 / THE RESEARCHER', 'It goes shopping.');
  const store = getStore();
  const all = [];
  const errors = [];
  let attempted = 0;

  // The three scrapes share nothing, so running them one after another just
  // adds their slowest cases together. Concurrently, the stage costs whichever
  // platform is slowest instead of all three.
  const jobs = platforms
    .map((platform) => ({ platform, handles: NICHE.seedAccounts[platform] || [] }))
    .filter(({ platform, handles }) => {
      if (handles.length) return true;
      log.warn(`no seed accounts for ${platform}, skipping`);
      return false;
    });

  attempted = jobs.length;
  for (const { platform, handles } of jobs) {
    log.info(`scraping ${handles.length} ${platform} accounts`);
  }

  const results = await Promise.all(
    jobs.map(async ({ platform, handles }) => {
      try {
        return { platform, items: await scrape(platform, handles) };
      } catch (err) {
        // One platform failing must not cost us the other two.
        return { platform, error: err };
      }
    }),
  );

  for (const { platform, items, error } of results) {
    if (error) {
      log.error(`${platform} scrape failed, continuing`, error.message);
      errors.push(`${platform}: ${error.message}`);
      continue;
    }
    const posts = items
      .map((item) => {
        try {
          return normalize[platform](item);
        } catch {
          return null;
        }
      })
      .filter((p) => p && p.url && p.views > 0);
    log.info(`${platform}: ${items.length} items -> ${posts.length} usable posts`);
    all.push(...posts);
  }

  // A platform that scraped fine but produced no winners is a normal quiet
  // run. Every platform erroring is a broken stage.
  reportBatch(log, { attempted, succeeded: attempted - errors.length, errors });

  const winners = pickWinners(all, {
    viralMultiple: config.research.viralMultiple,
    minViews: config.research.minViews,
    lookbackDays: config.research.lookbackDays,
    keepTop: config.research.keepTop,
  });

  log.info(`${winners.length} winners cleared ${config.research.viralMultiple}x median` +
    ` and ${config.research.minViews.toLocaleString()} views`);

  // Preserve status on posts we have already written through the pipeline.
  const existing = new Map((await store.list(TABLES.WINNERS)).map((r) => [r.id, r]));
  const rows = winners.map((w) => ({
    ...w,
    niche: NICHE.id,
    status: existing.get(w.id)?.status || 'winner',
    scrapedAt: new Date().toISOString(),
  }));

  await store.upsert(TABLES.WINNERS, rows);
  const fresh = rows.filter((r) => !existing.has(r.id)).length;
  log.info(`saved to ${store.driver}: ${fresh} new, ${rows.length - fresh} refreshed`);

  for (const w of rows.slice(0, 5)) {
    log.debug(`  ${w.viralMultiple}x  ${w.views.toLocaleString().padStart(10)}  ${w.platform.padEnd(9)} ${w.hook.slice(0, 60)}`);
  }

  return rows;
}

export default research;
