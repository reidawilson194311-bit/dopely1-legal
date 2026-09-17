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
 *   machine show                print the latest scripts in full, for review\n *   machine doctor              check credentials and tooling before a real run
 *
 * Flags: --dry-run  --limit=N  --platforms=a,b  --stages=a,b  --verbose
 */
import { config, applyCliOverrides } from './config.js';
import { run, STAGES } from './machine.js';
import { drain } from './skills/04-poster.js';
import { getStore, TABLES } from './lib/store/index.js';
import { hasFfmpeg, hasDrawtext, findFont } from './lib/video.js';
import { describeWriter } from './lib/writer/index.js';
import { listModels, ping as geminiPing, DEFAULT_MODEL as GEMINI_DEFAULT_MODEL } from './lib/writer/gemini.js';

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

/**
 * Print the scripts in full, so a batch can be read before it is published.
 * `status` counts rows; reviewing the writing needs the writing.
 */
async function show({ limit = 10, table = 'scripts' } = {}) {
  const store = getStore();
  const rows = (await store.list(table)).slice(-limit);
  if (!rows.length) {
    console.log(`\n  nothing in ${table}\n`);
    return;
  }
  for (const r of rows) {
    console.log(`\n${'='.repeat(70)}`);
    console.log(`${r.title || r.id}`);
    console.log(`${'='.repeat(70)}`);
    const line = (k, v) => v && console.log(`${k.padEnd(10)} ${v}`);
    line('pillar', r.pillar);
    line('status', r.status);
    line('youtube', r.youtubeTitle);
    line('source', r.sourceNote);
    line('hashtags', Array.isArray(r.hashtags) ? r.hashtags.join(' ') : r.hashtags);
    if (r.hook) console.log(`\nHOOK\n  ${r.hook}`);
    const beats = typeof r.beats === 'string' ? safeParse(r.beats) : r.beats;
    if (Array.isArray(beats)) {
      console.log('\nBEATS');
      beats.forEach((b, i) => {
        console.log(`  ${i + 1}. ${b.onScreenText || ''}`);
        if (b.voiceover && b.voiceover !== b.onScreenText) console.log(`     vo: ${b.voiceover}`);
      });
    }
    if (r.cta) console.log(`\nCTA\n  ${r.cta}`);
    const caps = typeof r.captions === 'string' ? safeParse(r.captions) : r.captions;
    if (caps && typeof caps === 'object') {
      console.log('\nCAPTIONS');
      for (const [k, v] of Object.entries(caps)) console.log(`  ${k.padEnd(10)} ${v}`);
    }
  }
  console.log('');
}

function safeParse(v) {
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}

async function doctor() {
  const checks = [];
  const need = (label, ok, hint) => checks.push({ label, ok, hint });

  need('APIFY_TOKEN (skill 01)', Boolean(config.research.apifyToken), 'apify.com -> Settings -> API tokens');

  // Skill 02's key depends on which writer is configured.
  const writer = config.copy.provider;
  if (writer === 'gemini') {
    need(`writer: ${await describeWriter()} (skill 02)`,
      Boolean(config.design.geminiApiKey),
      'uses GEMINI_API_KEY - the same key as skill 03, nothing extra to set up');
  } else if (writer === 'openai-compatible') {
    need(`writer: ${await describeWriter()} (skill 02)`,
      Boolean(config.copy.openai.apiKey),
      `set OPENAI_API_KEY (and OPENAI_BASE_URL, currently ${config.copy.openai.baseUrl})`);
  } else if (writer === 'anthropic') {
    need(`writer: ${await describeWriter()} (skill 02)`,
      Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN),
      'export ANTHROPIC_API_KEY=... or run `ant auth login`');
  } else {
    need(`writer: COPY_PROVIDER="${writer}" (skill 02)`, false,
      'expected gemini, openai-compatible or anthropic');
  }

  need('GEMINI_API_KEY (skill 03)', Boolean(config.design.geminiApiKey), 'aistudio.google.com -> Get API key');

  // Presence of a key says nothing about which models it can reach, and a name
  // the key cannot see fails as a bare 404 at generate time. Ask the catalogue.
  if (config.design.geminiApiKey) {
    let models = null;
    try {
      models = await listModels();
    } catch (err) {
      need('Gemini key works', false, `listing models failed: ${err.message}`);
    }
    if (models) {
      const named = new Set(models.map((m) => m.name));
      const supports = (method) =>
        models.filter((m) => m.methods.includes(method)).map((m) => m.name);
      const copyModel = config.copy.model || GEMINI_DEFAULT_MODEL;
      const imageModel = config.design.imageModel;

      need(`Gemini key works (${models.length} models visible)`, true);

      // Being in the catalogue is not the same question as being callable:
      // gemini-2.5-flash is listed and :generateContent still 404s. So the
      // check is a real call, and the catalogue only explains a failure.
      const usable = supports('generateContent');
      const check = async (label, model, envVar) => {
        try {
          await geminiPing(model);
          need(`${label} "${model}" answers`, true);
        } catch (err) {
          need(`${label} "${model}" answers`, false,
            `${err.message}\n       ` +
              (named.has(model)
                ? `it IS in the catalogue${usable.includes(model) ? ' and lists generateContent' : ", but does NOT list generateContent"}`
                : 'it is NOT in the catalogue') +
              `\n       models this key can generate with: ${usable.slice(0, 15).join(', ') || 'none'}` +
              `\n       set ${envVar} to one of these`);
        }
      };

      if (config.copy.provider === 'gemini') await check('copy model', copyModel, 'COPY_MODEL');
      await check('image model', imageModel, 'GEMINI_IMAGE_MODEL');
    }
  }

  const ffmpeg = await hasFfmpeg();
  need('ffmpeg (skill 03)', ffmpeg, 'apt install ffmpeg, or set FFMPEG_PATH');
  if (ffmpeg) {
    need('ffmpeg drawtext filter', await hasDrawtext(), 'needs a build with libfreetype; captions are skipped without it');
    need('bold TTF for captions', Boolean(findFont()), 'set CAPTION_FONT=/path/to/Bold.ttf');
  }

  const provider = config.post.provider;
  if (provider === 'submagic') {
    need('Submagic credentials (skill 04)', Boolean(config.post.submagic.apiKey),
      'set SUBMAGIC_API_KEY');
    need('somewhere to host rendered video', Boolean(config.host.githubToken && config.host.repo),
      'Submagic fetches video from a URL. Actions supplies GITHUB_TOKEN and ' +
        'GITHUB_REPOSITORY automatically; set both if running elsewhere.');
  } else if (provider === 'metricool') {
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

  if (config.store.driver === 'json' && process.env.CI) {
    need('store survives between runs', false,
      'STORE_DRIVER=json writes to ./data, which a fresh CI runner discards - ' +
      'each stage would find an empty store and quietly do nothing. ' +
      'Set STORE_DRIVER=airtable, or run the machine somewhere with a real disk.');
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
  machine show [--limit=N] [--table=scripts|winners|renders|posts]
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
  if (command === 'show') {
    await show({ limit: Number(flags.limit) || 10, table: flags.table || 'scripts' });
    return 0;
  }
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
