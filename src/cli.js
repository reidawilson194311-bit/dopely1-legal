#!/usr/bin/env node
/**
 * dopely1-shorts-machine
 *
 *   machine run                 the whole loop: scrape -> reword -> design -> post
 *   machine research            01 only
 *   machine write               02 only
 *   machine design              03 only
 *   machine post                04 only
 *   machine status              what is sitting in each table
 *   machine doctor              check credentials and tooling before a real run
 *
 * Flags: --dry-run  --limit=N  --platforms=a,b  --stages=a,b  --verbose
 */
import { config, applyCliOverrides } from './config.js';
import { run, STAGES } from './machine.js';
import { drain } from './skills/04-poster.js';
import { getStore, TABLES } from './lib/store/index.js';
import { hasFfmpeg, hasDrawtext, findFont } from './lib/video.js';

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (const arg of argv) {
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const [key, value] = arg.slice(2).split('=');
    const camel = key.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (value === undefined) flags[camel] = true;
    else if (/^\d+$/.test(value)) flags[camel] = Number(value);
    else if (value.includes(',')) flags[camel] = value.split(',').map((s) => s.trim());
    else flags[camel] = value;
  }
  if (typeof flags.platforms === 'string') flags.platforms = [flags.platforms];
  if (typeof flags.stages === 'string') flags.stages = [flags.stages];
  return { command: positional[0] || 'run', flags };
}

async function status() {
  const store = getStore();
  const groups = {};
  for (const [label, table] of Object.entries(TABLES)) {
    const rows = await store.list(table);
    const byStatus = {};
    for (const r of rows) byStatus[r.status || 'unknown'] = (byStatus[r.status || 'unknown'] || 0) + 1;
    groups[label.toLowerCase()] = { total: rows.length, ...byStatus };
  }
  console.log(`\nstore: ${store.driver}\n`);
  for (const [name, counts] of Object.entries(groups)) {
    const { total, ...rest } = counts;
    const detail = Object.entries(rest).map(([k, v]) => `${k}=${v}`).join('  ') || '(empty)';
    console.log(`  ${name.padEnd(9)} ${String(total).padStart(4)}   ${detail}`);
  }
  console.log('');
}

async function doctor() {
  const checks = [];
  const need = (label, ok, hint) => checks.push({ label, ok, hint });

  need('ANTHROPIC_API_KEY (skill 02)',
    Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN),
    'export ANTHROPIC_API_KEY=... or run `ant auth login`');
  need('APIFY_TOKEN (skill 01)', Boolean(config.research.apifyToken), 'apify.com -> Settings -> API tokens');
  need('GEMINI_API_KEY (skill 03)', Boolean(config.design.geminiApiKey), 'aistudio.google.com -> Get API key');

  const ffmpeg = await hasFfmpeg();
  need('ffmpeg (skill 03)', ffmpeg, 'apt install ffmpeg, or set FFMPEG_PATH');
  if (ffmpeg) {
    need('ffmpeg drawtext filter', await hasDrawtext(), 'needs a build with libfreetype; captions are skipped without it');
    need('bold TTF for captions', Boolean(findFont()), 'set CAPTION_FONT=/path/to/Bold.ttf');
  }

  const provider = config.post.provider;
  if (provider === 'metricool') {
    need('Metricool credentials (skill 04)',
      Boolean(config.post.metricool.token && config.post.metricool.userId && config.post.metricool.blogId),
      'set METRICOOL_USER_TOKEN, METRICOOL_USER_ID, METRICOOL_BLOG_ID');
  } else if (provider === 'unipile') {
    need('Unipile credentials (skill 04)',
      Boolean(config.post.unipile.apiKey && config.post.unipile.dsn),
      'set UNIPILE_API_KEY and UNIPILE_DSN');
  } else {
    need('publisher configured (skill 04)', false,
      'set PUBLISH_PROVIDER=metricool|unipile - without it posts only queue locally');
  }

  if (config.store.driver === 'airtable') {
    need('Airtable credentials',
      Boolean(config.store.airtable.apiKey && config.store.airtable.baseId),
      'set AIRTABLE_API_KEY and AIRTABLE_BASE_ID');
  }

  console.log('');
  for (const c of checks) {
    console.log(`  ${c.ok ? '\x1b[32mok  \x1b[0m' : '\x1b[33mmiss\x1b[0m'} ${c.label}`);
    if (!c.ok) console.log(`       ${c.hint}`);
  }
  const missing = checks.filter((c) => !c.ok).length;
  console.log(
    missing
      ? `\n  ${missing} thing(s) missing. \`machine run --dry-run\` works regardless.\n`
      : '\n  everything is wired. `machine run` will go live.\n',
  );
  return missing === 0;
}

const HELP = `
dopely1-shorts-machine - scrape, reword, design, post. 0 humans.

  machine run [--stages=research,write,design,post]
  machine research | write | design | post
  machine drain     publish held posts whose slot is due (Unipile only)
  machine status
  machine doctor

  --dry-run          no external calls, no spend, nothing goes live
  --limit=N          cap items processed per stage
  --platforms=a,b    instagram,tiktok,youtube
  --verbose          debug logging
`;

async function main() {
  const { command, flags } = parseArgs(process.argv.slice(2));
  if (flags.help || command === 'help') {
    console.log(HELP);
    return 0;
  }
  applyCliOverrides(flags);

  const opts = {};
  if (flags.limit) opts.limit = flags.limit;
  if (flags.platforms) opts.platforms = flags.platforms;

  if (command === 'drain') {
    const published = await drain({ platforms: flags.platforms || config.platforms });
    if (!published.length) console.log('nothing due');
    return 0;
  }
  if (command === 'status') return (await status(), 0);
  if (command === 'doctor') return (await doctor()) ? 0 : 1;

  if (command === 'run') {
    const { failures } = await run({ stages: flags.stages || Object.keys(STAGES), ...opts });
    return failures.length ? 1 : 0;
  }

  if (STAGES[command]) {
    await STAGES[command].fn(opts);
    return 0;
  }

  console.error(`unknown command: ${command}`);
  console.log(HELP);
  return 2;
}

main().then(
  (code) => process.exit(code ?? 0),
  (err) => {
    console.error(`\n${err.stack || err.message}\n`);
    process.exit(1);
  },
);
