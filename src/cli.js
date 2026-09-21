#!/usr/bin/env node
/**
 * dopely1-shorts-machine
 *
 *   machine run                 the whole loop: scrape -> reword -> design -> post
 *   machine research            01 only
 *   machine news                01b only - read the wires
 *   machine write               02 only
 *   machine design              03 only
 *   machine post                04 only
 *   machine status              what is sitting in each table
 *   machine show                print the latest scripts in full, for review
 *   machine sweep               re-screen stored news against the current rules
 *   machine requeue             put rows back a stage so it can run again
 *   machine patch               correct one field on one row after review
 *   machine doctor              check credentials and tooling before a real run
 *
 * Flags: --dry-run  --limit=N  --platforms=a,b  --stages=a,b  --verbose
 */
import { config, applyCliOverrides } from './config.js';
import { run, STAGES } from './machine.js';
import { drain } from './skills/04-poster.js';
import { getStore, TABLES } from './lib/store/index.js';
import { harshMatch } from './lib/newsfilter.js';
import { interestScore } from './lib/interest.js';
import { hasFfmpeg, hasDrawtext, findFont } from './lib/video.js';
import { ping as ttsPing } from './lib/tts.js';
import { request } from './lib/http.js';
import SCHEMA, { diffTable } from '../scripts/airtable-schema.js';
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
async function show({ limit = 10, table = 'scripts', status = null } = {}) {
  const store = getStore();
  const all = await store.list(table);
  // Filtering matters most for review: "what is waiting on me" should not
  // mean reading the last ten rows and working it out.
  const rows = (status ? all.filter((r) => r.status === status) : all).slice(-limit);
  if (!rows.length) {
    console.log(`\n  nothing in ${table}${status ? ` with status "${status}"` : ''}\n`);
    return;
  }
  for (const r of rows) {
    console.log(`\n${'='.repeat(70)}`);
    console.log(`${r.title || r.id}`);
    console.log(`${'='.repeat(70)}`);
    console.log(`${'id'.padEnd(10)} ${r.id}`); // `patch` needs this to aim at a row
    const line = (k, v) => v && console.log(`${k.padEnd(10)} ${v}`);
    line('pillar', r.pillar);
    line('status', r.status);
    line('youtube', r.youtubeTitle);
    line('source', r.sourceNote);
    const tags = typeof r.hashtags === 'string' ? safeParse(r.hashtags) : r.hashtags;
    if (Array.isArray(tags)) line('hashtags', tags.join(' '));
    else if (tags && typeof tags === 'object') {
      // Hashtags are per-platform, so the object IS the answer - printing it
      // through String() just gives [object Object].
      console.log('hashtags');
      for (const [k, v] of Object.entries(tags)) {
        console.log(`  ${k.padEnd(10)} ${Array.isArray(v) ? v.join(' ') : v}`);
      }
    } else line('hashtags', tags);
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

/**
 * Put rows back in an earlier state so a later stage can run again.
 *
 * Each stage marks what it consumed, which is what stops the machine redoing
 * work every night. That same mark makes a fixed pipeline unable to re-run over
 * material already reviewed - the only alternative being to pay for fresh
 * scripts that nobody has read.
 */
async function requeue({ table = 'scripts', from = 'designed', to = 'ready-to-design', limit = 10 } = {}) {
  const store = getStore();
  const rows = (await store.list(table, { where: (r) => r.status === from })).slice(0, limit);
  if (!rows.length) {
    console.log(`\n  nothing in ${table} with status "${from}"\n`);
    return 0;
  }
  for (const r of rows) {
    await store.patch(table, r.id, { status: to });
    console.log(`  ${r.title || r.id}: ${from} -> ${to}`);
  }
  console.log(`\n  ${rows.length} row(s) requeued\n`);
  return rows.length;
}

/**
 * Re-screen what is already stored.
 *
 * Both news screens run at INGEST. That leaves everything taken before a screen
 * existed, or before a gap in one was closed, sitting in the table at status
 * "winner" - and the writer reads the table, not the wire. A drone strike with
 * casualties reached a finished script that way, hours after the violence
 * screen went in, because the screen was never asked about rows already there.
 *
 * Fixing the six rows by hand was the wrong shape of fix: the next gap closed
 * leaves a different set behind. This asks the current screens about every
 * stored row, so tightening a word list cleans up after itself.
 *
 * News only. An evergreen winner is a social post that performed well and was
 * never subject to these screens.
 */
async function sweep({ table = 'winners', status = 'winner', to = 'rejected-filtered', apply = false } = {}) {
  const store = getStore();
  const scripts = table === 'scripts';
  const rows = await store.list(table, { where: (r) => r.status === status });
  // A winner marks its origin with `platform`, a script with `pillar`. Testing
  // only one of them silently swept nothing on the scripts table, which is the
  // half of the job that matters after a batch is already written.
  const news = rows.filter((r) => r.platform === 'news' || r.pillar === 'news');

  const failures = [];
  for (const r of news) {
    // A script carries its text in hook/beats; a winner in hook/caption. Both
    // are screened over everything they hold, because the summary is where the
    // casualty count lives even when the headline reads clean.
    const beats = typeof r.beats === 'string' ? safeParse(r.beats) : r.beats;
    const beatText = Array.isArray(beats)
      ? beats.map((b) => `${b.onScreenText || ''} ${b.voiceover || ''}`).join(' ')
      : '';
    const text = `${r.title || ''} ${r.hook || ''} ${r.caption || ''} ${beatText} ${r.sourceNote || ''}`;
    const harsh = harshMatch(text);
    const interest = interestScore(text);
    if (harsh) failures.push({ r, why: `too harsh: ${harsh}` });
    else if (!scripts && interest.score < 1) {
      failures.push({ r, why: `not interesting: ${interest.score}` });
    }
  }

  if (!failures.length) {
    console.log(`\n  ${news.length} news row(s) in ${table}/${status}, all pass\n`);
    return 0;
  }
  for (const { r, why } of failures) {
    if (apply) await store.patch(table, r.id, { status: to });
    console.log(`  ${apply ? '' : '[dry] '}${(r.title || r.hook || r.id).slice(0, 62)}  <- ${why}`);
  }
  console.log(
    `\n  ${failures.length} of ${news.length} retired${apply ? '' : ' (dry run - pass --apply)'}\n`,
  );
  return failures.length;
}

/**
 * Correct one field on one row.
 *
 * Review finds defects in individual scripts - a hook comparing against the
 * wrong thing, a beat whose caption and voiceover disagree. Regenerating the
 * batch to fix one sentence pays for four scripts nobody has read and throws
 * away the three that were fine.
 *
 *   machine patch --table=scripts --id=scr_x --field=hook --value="..."
 *   machine patch --id=scr_x --field=beats.3.onScreenText --value="..."
 */
async function patch({ table = 'scripts', id, field, value } = {}) {
  if (!id || !field) throw new Error('patch needs --id and --field');
  const store = getStore();
  const [row] = await store.list(table, { where: (r) => r.id === id, limit: 1 });
  if (!row) throw new Error(`no row ${id} in ${table}`);

  const [head, ...rest] = field.split('.');
  let next;
  if (!rest.length) {
    next = value;
  } else {
    // beats is stored as JSON in Airtable and as an array in the json store.
    const parsed = typeof row[head] === 'string' ? JSON.parse(row[head]) : row[head];
    const clone = structuredClone(parsed);
    const leaf = rest.pop();
    const target = rest.reduce((o, k) => {
      if (o?.[k] === undefined) throw new Error(`${field} does not exist on ${id}`);
      return o[k];
    }, clone);
    if (target[leaf] === undefined) throw new Error(`${field} does not exist on ${id}`);
    console.log(`  was: ${target[leaf]}`);
    target[leaf] = value;
    next = typeof row[head] === 'string' ? JSON.stringify(clone) : clone;
  }
  if (!rest.length && row[head] === undefined) throw new Error(`${field} does not exist on ${id}`);
  if (!field.includes('.')) console.log(`  was: ${row[head]}`);

  await store.patch(table, id, { [head]: next });
  console.log(`  now: ${value}\n`);
  return true;
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

  // Silent shorts are a legitimate format, but they are rarely what anyone
  // meant to ship - so say which one is about to be produced.
  if (config.design.ttsProvider !== 'none') {
    // Speak for real. A TTS model refuses the text-shaped ping the other two
    // models answer, so checking it that way reports a failure that is not
    // there - and a check that cries wolf is worse than no check.
    try {
      const { bytes } = await ttsPing();
      need(`voiceover: ${config.design.ttsProvider}/${config.design.ttsModel} (${bytes} bytes)`, true);
    } catch (err) {
      need(`voiceover: ${config.design.ttsProvider}/${config.design.ttsModel}`, false, err.message);
    }
  }
  if (config.design.ttsProvider === 'none') {
    need('voiceover (skill 03)', false,
      'TTS_PROVIDER=none renders SILENT video - the scripts\' voiceover lines only ' +
        'set beat timing. Set TTS_PROVIDER=gemini to narrate with the key you already have.');
  }

  const ffmpeg = await hasFfmpeg();
  need('ffmpeg (skill 03)', ffmpeg, 'apt install ffmpeg, or set FFMPEG_PATH');
  if (ffmpeg) {
    need('ffmpeg drawtext filter', await hasDrawtext(), 'needs a build with libfreetype; captions are skipped without it');
    need('bold TTF for captions', Boolean(findFont()), 'set CAPTION_FONT=/path/to/Bold.ttf');
  }

  const provider = config.post.provider;
  if (provider !== 'none') {
    need(`publishing to: ${config.post.platforms.join(', ')}`, true);
  }
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
      'set PUBLISH_PROVIDER=submagic|metricool|unipile - without it posts only queue locally');
  }

  if (config.store.driver === 'json' && process.env.CI) {
    need('store survives between runs', false,
      'STORE_DRIVER=json writes to ./data, which a fresh CI runner discards - ' +
      'each stage would find an empty store and quietly do nothing. ' +
      'Set STORE_DRIVER=airtable, or run the machine somewhere with a real disk.');
  }

  if (config.store.driver === 'airtable') {
    const { apiKey, baseId } = config.store.airtable;
    need('Airtable credentials', Boolean(apiKey && baseId),
      'set AIRTABLE_API_KEY and AIRTABLE_BASE_ID');

    // A field added to a row shape but not to the base fails the whole upsert
    // with UNKNOWN_FIELD_NAME - after the render has already been paid for and
    // encoded. Cheaper to find it here.
    if (apiKey && baseId) {
      try {
        const res = await request(
          `https://api.airtable.com/v0/meta/bases/${baseId}/tables`,
          { headers: { authorization: `Bearer ${apiKey}` }, timeoutMs: 30000, retries: 1 },
        );
        const live = new Map((res?.tables || []).map((t) => [t.name.toLowerCase(), t]));
        const gaps = SCHEMA.flatMap((spec) => {
          const d = diffTable(spec, live.get(spec.name.toLowerCase()));
          return d.missing.map((f) => `${spec.name}.${f.name}`);
        });
        need(`Airtable schema matches the code${gaps.length ? '' : ` (${SCHEMA.length} tables)`}`,
          gaps.length === 0,
          `missing: ${gaps.join(', ')} - run the workflow with setup_airtable to add them`);
      } catch (err) {
        need('Airtable schema matches the code', false, `could not read the base: ${err.message}`);
      }
    }
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
  machine show [--limit=N] [--table=scripts|winners|renders|posts] [--status=S]
  machine sweep [--table=winners|scripts] [--status=S] [--apply]   re-screen stored news
  machine requeue [--table=T] [--from=STATUS] [--to=STATUS] [--limit=N]
  machine patch --id=ID --field=PATH --value=TEXT [--table=T]
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
  if (command === 'patch') {
    await patch({
      table: flags.table || 'scripts',
      id: flags.id,
      field: flags.field,
      value: flags.value,
    });
    return 0;
  }
  if (command === 'sweep') {
    await sweep({
      table: flags.table || 'winners',
      status: flags.status || 'winner',
      to: flags.to || 'rejected-filtered',
      apply: Boolean(flags.apply),
    });
    return 0;
  }
  if (command === 'requeue') {
    await requeue({
      table: flags.table || 'scripts',
      from: flags.from || 'designed',
      to: flags.to || 'ready-to-design',
      limit: Number(flags.limit) || 10,
    });
    return 0;
  }
  if (command === 'show') {
    await show({
      limit: Number(flags.limit) || 10,
      table: flags.table || 'scripts',
      status: flags.status || null,
    });
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
