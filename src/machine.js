/**
 * THE MACHINE  -  the whole thing, one screen.
 *
 *        01 SCRAPE  -  copies what already went viral
 *            |
 *        02 REWORD  -  relaunders the idea
 *            |
 *        03 DESIGN  -  spins up the visuals
 *            |
 *        04 POST    -  auto-posts on a schedule
 *
 *   0 HUMANS. Runs while you sleep.
 *
 * The four skills are deliberately decoupled: each one reads a table, writes a
 * table, and does not care when the previous one ran. That is what lets them
 * run asynchronously - the scraper on a weekly cron, the poster every few
 * hours - and it is what lets one failing stage stall without taking the
 * others down with it.
 */
import { config } from './config.js';
import { logger } from './lib/log.js';
import research from './skills/01-researcher.js';
import researchNews from './skills/01b-news.js';
import write from './skills/02-copywriter.js';
import design from './skills/03-designer.js';
import post from './skills/04-poster.js';
import { getStore, TABLES } from './lib/store/index.js';

const log = logger('machine');

export const STAGES = {
  research: { fn: research, label: '01 SCRAPE' },
  news: { fn: researchNews, label: '01b NEWS ' },
  write: { fn: write, label: '02 REWORD' },
  design: { fn: design, label: '03 DESIGN' },
  post: { fn: post, label: '04 POST' },
};

/**
 * Run stages in order. A stage that throws is logged and the run continues -
 * the next stage simply finds nothing new to do, and the following run picks
 * up where this one stopped, because all the state lives in the store.
 */
export async function run({ stages = Object.keys(STAGES), ...opts } = {}) {
  const started = Date.now();
  const results = {};
  const failures = [];

  log.info(`the machine is running: ${stages.map((s) => STAGES[s].label).join(' -> ')}`);
  if (config.dryRun) log.warn('DRY RUN - no external calls, no money spent, nothing goes live');

  for (const name of stages) {
    const stage = STAGES[name];
    if (!stage) throw new Error(`unknown stage: ${name}`);
    try {
      results[name] = await stage.fn(opts);
    } catch (err) {
      failures.push({ stage: name, error: err.message });
      log.error(`${stage.label} failed`, err.message);
      results[name] = [];
    }
  }

  await summary(results, failures, started);
  return { results, failures };
}

async function summary(results, failures, started) {
  // Every stage failure above was caught and recorded. The summary must not
  // then throw its own way out of run() - if the store is unreachable (a
  // missing credential, say) that is exactly when the operator most needs to
  // see which stages failed, so totals degrade to '-' rather than exploding.
  let totals = { winners: '-', scripts: '-', renders: '-', posts: '-' };
  try {
    const store = getStore();
    const [winners, scripts, renders, posts] = await Promise.all([
      store.count(TABLES.WINNERS),
      store.count(TABLES.SCRIPTS),
      store.count(TABLES.RENDERS),
      store.count(TABLES.POSTS),
    ]);
    totals = { winners, scripts, renders, posts };
  } catch (err) {
    log.warn('could not read totals from the store', err.message);
  }
  const { winners, scripts, renders, posts } = totals;

  log.banner('THE MACHINE', 'Scrape, reword, design, post.');
  const rows = [
    ['01 SCRAPE', results.research?.length ?? '-', winners],
    ['01b NEWS ', results.news?.length ?? '-', winners],
    ['02 REWORD', results.write?.length ?? '-', scripts],
    ['03 DESIGN', results.design?.length ?? '-', renders],
    ['04 POST', results.post?.length ?? '-', posts],
  ];
  console.log('  stage        this run   total');
  for (const [label, run, total] of rows) {
    console.log(`  ${label.padEnd(12)} ${String(run).padStart(6)}   ${String(total).padStart(6)}`);
  }
  console.log(`\n  0 humans. ${((Date.now() - started) / 1000).toFixed(1)}s.`);
  if (failures.length) {
    console.log(`  ${failures.length} stage(s) failed: ${failures.map((f) => f.stage).join(', ')}`);
  }
  console.log('');
}

export default run;
