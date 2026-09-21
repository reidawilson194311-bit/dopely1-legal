import { test } from 'node:test';
import assert from 'node:assert/strict';

import { pickWinners, median, engagementRate } from '../src/lib/score.js';
import { normalize, extractHook } from '../src/lib/normalize.js';
import { overlapRatio, choosePillar, isNewsWinner } from '../src/skills/02-copywriter.js';
import { NICHE } from '../src/niche.js';
import { wrapCaption, buildFilterGraph } from '../src/lib/video.js';
import { composeCaption, drain, DEAD_POST_STATUS } from '../src/skills/04-poster.js';
import { buildPlatforms, batched } from '../src/lib/publishers/submagic.js';
import { wavHeader, pcmRate } from '../src/lib/tts.js';
import { firstAssetUrl } from '../src/lib/images/higgsfield.js';
import { env } from '../src/config.js';
import { createJsonStore } from '../src/lib/store/jsonStore.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { nextSlots, zonedTimeToUtc } from '../src/lib/schedule.js';
import { placeholderPNG, buildPrompt } from '../src/lib/nanobanana.js';
import { estimateDuration } from '../src/lib/tts.js';
import { reportBatch } from '../src/lib/batch.js';
import { harshMatch, isTooHarsh } from '../src/lib/newsfilter.js';
import { interestScore } from '../src/lib/interest.js';
import { rampedRate } from '../src/lib/ramp.js';
import { toGeminiSchema, parseJSON, describeSchema, DeclinedError } from '../src/lib/writer/schema.js';
import { TABLES, diffTable } from '../scripts/airtable-schema.js';
import {
  similarity, contentTokens, findDuplicate, corpusStopwords, DUPLICATE_THRESHOLD,
} from '../src/lib/similarity.js';
import { parseFeed, textOf, linkOf, dateOf, decodeEntities } from '../src/lib/rss.js';
import { clusterStories, rankStories } from '../src/lib/cluster.js';
import { storyId } from '../src/skills/01b-news.js';

// --- 01 researcher ----------------------------------------------------------

test('median ignores zeros and handles even counts', () => {
  assert.equal(median([0, 2, 4, 6]), 4);
  assert.equal(median([10]), 10);
  assert.equal(median([]), 0);
});

test('pickWinners scores against each account, not globally', () => {
  const posts = [
    // A big account posting normally: high views, but not an outlier.
    ...Array.from({ length: 5 }, (_, i) => ({
      platform: 'tiktok', account: 'big', url: `b${i}`, views: 1_000_000,
      likes: 1000, comments: 10, shares: 10, postedAt: new Date().toISOString(),
    })),
    // A smaller account with one genuine breakout.
    ...Array.from({ length: 4 }, (_, i) => ({
      platform: 'tiktok', account: 'small', url: `s${i}`, views: 100_000,
      likes: 100, comments: 1, shares: 1, postedAt: new Date().toISOString(),
    })),
    {
      platform: 'tiktok', account: 'small', url: 'breakout', views: 900_000,
      likes: 90_000, comments: 900, shares: 900, postedAt: new Date().toISOString(),
    },
  ];
  const winners = pickWinners(posts, {
    viralMultiple: 3, minViews: 100_000, lookbackDays: 90, keepTop: 10,
  });
  assert.equal(winners.length, 1, 'only the breakout should qualify');
  assert.equal(winners[0].url, 'breakout');
  assert.equal(winners[0].accountMedian, 100_000);
});

test('pickWinners drops posts older than the lookback window', () => {
  const old = new Date(Date.now() - 200 * 86400000).toISOString();
  const posts = Array.from({ length: 5 }, (_, i) => ({
    platform: 'youtube', account: 'a', url: `u${i}`,
    views: i === 0 ? 5_000_000 : 100_000,
    likes: 1, comments: 0, shares: 0, postedAt: old,
  }));
  assert.equal(
    pickWinners(posts, { viralMultiple: 3, minViews: 1000, lookbackDays: 90, keepTop: 10 }).length,
    0,
  );
});

test('engagementRate is clamped and weights shares highest', () => {
  assert.equal(engagementRate({ views: 0, likes: 5, comments: 0, shares: 0 }), 0);
  assert.equal(engagementRate({ views: 100, likes: 1000, comments: 0, shares: 0 }), 1);
  const a = engagementRate({ views: 1000, likes: 0, comments: 0, shares: 10 });
  const b = engagementRate({ views: 1000, likes: 10, comments: 0, shares: 0 });
  assert.ok(a > b);
});

test('normalizers read each platform native shape', () => {
  const ig = normalize.instagram({
    url: 'https://instagram.com/p/x', ownerUsername: 'facts',
    caption: 'Sharks are older than trees. #facts', videoPlayCount: 2_000_000,
    likesCount: 50_000, commentsCount: 800, timestamp: '2026-01-02T00:00:00Z',
  });
  assert.equal(ig.platform, 'instagram');
  assert.equal(ig.views, 2_000_000);
  assert.equal(ig.hook, 'Sharks are older than trees.');

  const tt = normalize.tiktok({
    webVideoUrl: 'https://tiktok.com/@a/video/1', authorMeta: { name: 'a' },
    text: 'Wild.', playCount: 900_000, diggCount: 10, commentCount: 2, shareCount: 3,
    createTimeISO: '2026-01-02T00:00:00Z',
  });
  assert.equal(tt.views, 900_000);
  assert.equal(tt.account, 'a');

  const yt = normalize.youtube({
    url: 'https://youtube.com/shorts/x', channelName: 'Chan',
    title: 'Why planes are white', viewCount: '1,200,000', date: '2026-01-02T00:00:00Z',
  });
  assert.equal(yt.views, 1_200_000, 'comma-formatted counts must parse');
});

test('normalizers survive missing fields instead of throwing', () => {
  const out = normalize.tiktok({});
  assert.equal(out.views, 0);
  assert.equal(out.caption, '');
  assert.equal(out.platform, 'tiktok');
});

test('extractHook strips urls and hashtags', () => {
  assert.equal(
    extractHook('Sharks are older than trees. Wild stuff https://x.co #facts #wow'),
    'Sharks are older than trees.',
  );
});

// --- 02 copywriter ----------------------------------------------------------

test('overlapRatio flags lifted phrasing but not shared topic', () => {
  const source = 'Your brain deletes memories on purpose to save space';
  assert.equal(overlapRatio(source, source), 1);
  assert.ok(overlapRatio(source, 'It turns out your brain deletes memories on purpose.') > 0.3);
  assert.equal(overlapRatio(source, 'Forgetting is a feature, not a bug.'), 0);
});

// --- 03 designer ------------------------------------------------------------

test('wrapCaption never exceeds the line budget', () => {
  for (const line of wrapCaption('Sharks are older than trees by a hundred million years', 18).split('\n')) {
    assert.ok(line.length <= 18 || !line.includes(' '), `too long: ${line}`);
  }
});

test('buildFilterGraph emits one video chain per beat plus a concat', () => {
  const beats = [
    { imagePath: 'a.png', onScreenText: 'One', durationSec: 3 },
    { imagePath: 'b.png', onScreenText: 'Two', durationSec: 2 },
  ];
  const g = buildFilterGraph({ beats, width: 1080, height: 1920, fps: 30, font: null, tmp: '/tmp' });
  assert.equal(g.length, 3);
  assert.ok(g[0].startsWith('[0:v]'));
  assert.ok(g[0].includes('d=90'), 'beat frames = duration * fps');
  assert.ok(g[1].includes('d=60'));
  assert.equal(g[2], '[v0][v1]concat=n=2:v=1:a=0[vout]');
  assert.ok(!g.some((f) => f.includes('drawtext')), 'no font means no drawtext');
});

test('buildFilterGraph burns one centred drawtext per wrapped line', () => {
  const beats = [{ imagePath: 'a.png', onScreenText: 'Sharks are older than trees by far', durationSec: 3 }];
  const written = [];
  const g = buildFilterGraph({
    beats, width: 1080, height: 1920, fps: 30,
    font: '/f/Bold.ttf', tmp: '/tmp', writeFile: (p, c) => written.push(c),
  });
  const drawtexts = g[0].split('drawtext=').length - 1;
  assert.ok(drawtexts >= 2, 'a long caption wraps to multiple lines');
  assert.equal(drawtexts, written.length);
  assert.ok(g[0].includes('x=(w-text_w)/2'), 'each line is centred on its own width');
  assert.ok(!g[0].includes('text_align'), 'text_align is ffmpeg 7+ only');
  assert.ok(written.every((line) => !line.includes('\n')), 'one line per textfile');
});

test('buildFilterGraph wires voiceover and music into one audio output', () => {
  const beats = [
    { imagePath: 'a.png', durationSec: 3 },
    { imagePath: 'b.png', durationSec: 2 },
  ];
  const withVoice = buildFilterGraph({
    beats, width: 1080, height: 1920, fps: 30, font: null, tmp: '/tmp', voiceIdx: [2, 3],
  });
  assert.ok(withVoice.some((f) => f.includes('concat=n=2:v=0:a=1[voice]')));
  assert.ok(withVoice.some((f) => f.endsWith('[aout]')));

  const withBoth = buildFilterGraph({
    beats, width: 1080, height: 1920, fps: 30, font: null, tmp: '/tmp',
    voiceIdx: [2, 3], musicIdx: 4,
  });
  assert.ok(withBoth.some((f) => f.includes('amix=inputs=2')));

  const silent = buildFilterGraph({
    beats, width: 1080, height: 1920, fps: 30, font: null, tmp: '/tmp',
  });
  assert.ok(!silent.some((f) => f.endsWith('[aout]')), 'no audio inputs means no audio map');
});

test('a partial voiceover is treated as no voiceover', () => {
  const beats = [
    { imagePath: 'a.png', durationSec: 3 },
    { imagePath: 'b.png', durationSec: 2 },
  ];
  // Only one of two beats narrated: concatenating it would desync the video.
  const g = buildFilterGraph({
    beats, width: 1080, height: 1920, fps: 30, font: null, tmp: '/tmp', voiceIdx: [2],
  });
  assert.ok(!g.some((f) => f.includes('[voice]')));
});

test('placeholderPNG writes a decodable PNG', () => {
  const png = placeholderPNG('seed', 32, 64);
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.equal(png.subarray(12, 16).toString(), 'IHDR');
  assert.equal(png.readUInt32BE(16), 32);
  assert.equal(png.readUInt32BE(20), 64);
  assert.ok(png.includes(Buffer.from('IEND')));
});

test('buildPrompt always appends the no-text, no-likeness guardrails', () => {
  const p = buildPrompt('a shark swimming over a forest');
  assert.ok(p.includes('a shark swimming over a forest'));
  assert.ok(/No text/i.test(p));
  assert.ok(/real people/i.test(p));
});

test('estimateDuration has a floor so a three-word beat is not a flash frame', () => {
  assert.ok(estimateDuration('Wild.') >= 2.2);
  assert.ok(estimateDuration('one two three four five six seven eight nine ten eleven twelve') > 4);
});

// --- 04 poster --------------------------------------------------------------

test('composeCaption appends hashtags and respects the platform limit', () => {
  const render = {
    title: 'T',
    captions: { instagram: 'Body text', tiktok: 'x', youtube: 'y' },
    hashtags: { instagram: ['facts', '#didyouknow'], tiktok: [], youtube: [] },
    cta: 'Follow for more.',
  };
  const cap = composeCaption(render, 'instagram');
  assert.ok(cap.startsWith('Body text'));
  assert.ok(cap.includes('Follow for more.'));
  assert.ok(cap.includes('#facts #didyouknow'), 'hashtags are normalised to one leading #');

  const long = composeCaption(
    { ...render, captions: { ...render.captions, instagram: 'x'.repeat(3000) } },
    'instagram',
  );
  assert.ok(long.length <= 2200);
  assert.ok(long.endsWith('…'));
});

test('nextSlots respects lead time, ordering and already-taken slots', () => {
  const now = new Date('2026-06-15T12:00:00Z'); // 08:00 in New York
  const slots = nextSlots('tiktok', 3, [], now);
  assert.equal(slots.length, 3);
  for (const s of slots) assert.ok(s.getTime() > now.getTime());
  for (let i = 1; i < slots.length; i++) {
    assert.ok(slots[i] > slots[i - 1], 'slots come back in chronological order');
  }

  const taken = [slots[0].toISOString()];
  const next = nextSlots('tiktok', 1, taken, now);
  assert.notEqual(next[0].toISOString(), taken[0]);
});

test('zonedTimeToUtc handles daylight saving on both sides of the year', () => {
  // New York is UTC-4 in June and UTC-5 in January.
  assert.equal(zonedTimeToUtc(2026, 6, 15, 9, 0, 'America/New_York').toISOString(), '2026-06-15T13:00:00.000Z');
  assert.equal(zonedTimeToUtc(2026, 1, 15, 9, 0, 'America/New_York').toISOString(), '2026-01-15T14:00:00.000Z');
});

// --- stage failure reporting -----------------------------------------------

const quietLog = () => {
  const warnings = [];
  return { warnings, warn: (m, e) => warnings.push(`${m} ${e ?? ''}`.trim()) };
};

test('a stage with nothing to do is not a failure', () => {
  const log = quietLog();
  reportBatch(log, { attempted: 0, succeeded: 0, errors: [] });
  assert.equal(log.warnings.length, 0);
});

test('a stage where every item errored throws so the run exits non-zero', () => {
  // The bug this guards: an unattended cron cannot tell "nothing to do" from
  // "everything broke" if both just return an empty list.
  assert.throws(
    () => reportBatch(quietLog(), { attempted: 3, succeeded: 0, errors: ['boom', 'boom', 'boom'] }),
    /3 of 3 item\(s\) errored and none succeeded.*boom/,
  );
});

test('a partial failure warns but lets the run keep what it earned', () => {
  const log = quietLog();
  reportBatch(log, { attempted: 5, succeeded: 3, errors: ['boom', 'boom'] });
  assert.equal(log.warnings.length, 1);
  assert.match(log.warnings[0], /2 of 5/);
});

test('deliberate skips are not counted as errors', () => {
  // Skill 02 skips winners that overlap their source too closely. Zero
  // written with zero errors is a clean run, not a broken stage.
  const log = quietLog();
  reportBatch(log, { attempted: 4, succeeded: 0, errors: [] });
  assert.equal(log.warnings.length, 0);
});

// --- posting rate ramp ------------------------------------------------------

const RAMP = { start: 2, target: 4, days: 21 };
const dayN = (first, n) => new Date(Date.parse(first) + n * 86400000);
const FIRST = '2026-01-01T00:00:00Z';

test('the ramp starts at the start rate and ends at the target', () => {
  assert.equal(rampedRate({ ...RAMP, firstPostAt: null }), 2, 'no history is day zero');
  assert.equal(rampedRate({ ...RAMP, firstPostAt: FIRST, now: dayN(FIRST, 0) }), 2);
  assert.equal(rampedRate({ ...RAMP, firstPostAt: FIRST, now: dayN(FIRST, 21) }), 4);
  assert.equal(rampedRate({ ...RAMP, firstPostAt: FIRST, now: dayN(FIRST, 400) }), 4, 'never overshoots');
});

test('the ramp only ever climbs', () => {
  let prev = 0;
  for (let d = 0; d <= 30; d++) {
    const rate = rampedRate({ ...RAMP, firstPostAt: FIRST, now: dayN(FIRST, d) });
    assert.ok(rate >= prev, `rate dropped on day ${d}`);
    assert.ok(rate >= 2 && rate <= 4, `rate out of bounds on day ${d}: ${rate}`);
    prev = rate;
  }
});

test('the ramp is measured from account history, not process start', () => {
  // An account that has been posting for a month is already at full rate on a
  // freshly restarted machine - the ramp must not start over.
  const old = new Date(Date.now() - 60 * 86400000).toISOString();
  assert.equal(rampedRate({ ...RAMP, firstPostAt: old }), 4);
});

test('the ramp degrades safely on nonsense input', () => {
  assert.equal(rampedRate({ ...RAMP, firstPostAt: 'not a date' }), 2);
  assert.equal(rampedRate({ start: 4, target: 2, days: 21, firstPostAt: FIRST }), 4, 'target below start is ignored');
  assert.equal(rampedRate({ start: 2, target: 4, days: 0, firstPostAt: FIRST }), 4);
  assert.equal(rampedRate({ start: 0, target: 4, days: 21, firstPostAt: FIRST }), 1, 'never zero');
});

// --- the drain (the bug that meant Unipile never uploaded anything) --------

function tempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drain-'));
  return createJsonStore({ dataDir: dir });
}

const queuedPost = (over = {}) => ({
  id: 'p1', platform: 'tiktok', title: 'T', caption: 'c',
  videoPath: '/dev/null', status: 'queued',
  publishAt: new Date(Date.now() - 60000).toISOString(),
  ...over,
});

function fakeProvider(behaviour = () => ({ externalId: 'ext-1' })) {
  const calls = [];
  return {
    name: 'fake',
    calls,
    async schedule(payload) {
      calls.push(payload);
      return behaviour(payload);
    },
  };
}

test('drain publishes a queued post whose slot is due', async () => {
  const store = tempStore();
  await store.upsert('posts', [queuedPost()]);
  const provider = fakeProvider();

  const published = await drain({ store, platforms: ['tiktok'], provider });

  assert.equal(provider.calls.length, 1, 'the upload actually happened');
  assert.equal(published.length, 1);
  const row = await store.get('posts', 'p1');
  assert.equal(row.status, 'published');
  assert.equal(row.externalId, 'ext-1');
  assert.ok(row.publishedAt);
});

test('drain leaves a post whose slot has not come yet', async () => {
  const store = tempStore();
  await store.upsert('posts', [
    queuedPost({ publishAt: new Date(Date.now() + 3600000).toISOString() }),
  ]);
  const provider = fakeProvider();

  assert.equal((await drain({ store, platforms: ['tiktok'], provider })).length, 0);
  assert.equal(provider.calls.length, 0);
  assert.equal((await store.get('posts', 'p1')).status, 'queued');
});

test('drain never republishes a post it already sent', async () => {
  const store = tempStore();
  await store.upsert('posts', [queuedPost({ status: 'published' })]);
  const provider = fakeProvider();

  await drain({ store, platforms: ['tiktok'], provider });
  assert.equal(provider.calls.length, 0, 'double-posting is worse than not posting');
});

test('a failed upload stays queued so the next drain retries it', async () => {
  const store = tempStore();
  await store.upsert('posts', [queuedPost()]);
  const flaky = fakeProvider(() => { throw new Error('upstream 503'); });

  // Every item failed, so the stage reports failure rather than reporting success.
  await assert.rejects(() => drain({ store, platforms: ['tiktok'], provider: flaky }), /none succeeded/);

  const row = await store.get('posts', 'p1');
  assert.equal(row.status, 'queued', 'still owed, not silently dropped');
  assert.match(row.error, /upstream 503/);

  // And the retry succeeds.
  const good = fakeProvider();
  await drain({ store, platforms: ['tiktok'], provider: good });
  assert.equal(good.calls.length, 1);
  assert.equal((await store.get('posts', 'p1')).status, 'published');
});

test('drain tells the publisher to go now, not to wait', async () => {
  // The original bug in miniature: passing the future slot time made Unipile
  // hand it back unpublished, forever.
  const store = tempStore();
  const slot = new Date(Date.now() - 120000).toISOString();
  await store.upsert('posts', [queuedPost({ publishAt: slot })]);
  const provider = fakeProvider();
  const now = new Date();

  await drain({ store, platforms: ['tiktok'], provider, now });
  assert.equal(provider.calls[0].publishAt.getTime(), now.getTime());
});

test('drain ignores platforms it was not asked about', async () => {
  const store = tempStore();
  await store.upsert('posts', [queuedPost({ platform: 'instagram' })]);
  const provider = fakeProvider();
  await drain({ store, platforms: ['tiktok'], provider });
  assert.equal(provider.calls.length, 0);
});

// --- the writer seam (skill 02 is provider-agnostic) ------------------------

test('toGeminiSchema strips keys Gemini rejects, keeps the rest', () => {
  // additionalProperties is required for OpenAI strict mode and rejected
  // outright by Gemini, so one schema has to be translated, not duplicated.
  const strict = {
    type: 'object',
    additionalProperties: false,
    $schema: 'http://json-schema.org/draft-07/schema#',
    required: ['hook', 'beats'],
    properties: {
      hook: { type: 'string', description: 'Max 12 words.' },
      pillar: { type: 'string', enum: ['a', 'b'] },
      beats: {
        type: 'array',
        minItems: 3,
        maxItems: 7,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['onScreenText'],
          properties: { onScreenText: { type: 'string' } },
        },
      },
    },
  };
  const g = toGeminiSchema(strict);

  assert.equal(g.additionalProperties, undefined);
  assert.equal(g.$schema, undefined);
  assert.equal(g.properties.beats.items.additionalProperties, undefined, 'strips at every depth');

  // Everything load-bearing survives.
  assert.deepEqual(g.required, ['hook', 'beats']);
  assert.deepEqual(g.properties.pillar.enum, ['a', 'b']);
  assert.equal(g.properties.hook.description, 'Max 12 words.');
  assert.equal(g.properties.beats.maxItems, 7);
  assert.equal(g.properties.beats.minItems, 3);
  assert.equal(g.properties.beats.items.properties.onScreenText.type, 'string');
});

test('toGeminiSchema does not mutate the schema it was given', () => {
  // The same schema object is reused across providers within one run.
  const original = { type: 'object', additionalProperties: false, properties: {} };
  toGeminiSchema(original);
  assert.equal(original.additionalProperties, false);
});

test('parseJSON survives a model that fences its JSON anyway', () => {
  assert.deepEqual(parseJSON('{"a":1}', 'p'), { a: 1 });
  assert.deepEqual(parseJSON('```json\n{"a":1}\n```', 'p'), { a: 1 });
  assert.deepEqual(parseJSON('```\n{"a":1}\n```', 'p'), { a: 1 });
  assert.deepEqual(parseJSON('  \n {"a":1}\n ', 'p'), { a: 1 });
});

test('parseJSON names the provider when it fails', () => {
  assert.throws(() => parseJSON('sorry, I cannot', 'Gemini'), /Gemini returned unparseable JSON/);
  assert.throws(() => parseJSON('', 'Gemini'), /Gemini returned no content/);
});

test('describeSchema gives a fallback provider something to follow', () => {
  const text = describeSchema({ type: 'object', properties: { hook: { type: 'string' } } });
  assert.match(text, /JSON only/);
  assert.match(text, /"hook"/);
});

test('a decline from any provider is one error type skill 02 can catch', () => {
  const err = new DeclinedError('Gemini', 'SAFETY');
  assert.equal(err.name, 'DeclinedError');
  assert.match(err.message, /Gemini declined this request \(SAFETY\)/);
  assert.match(new DeclinedError('The model').message, /The model declined this request$/);
});

// --- the Airtable base schema ----------------------------------------------

test('every table leads with id, because that is what stops rows duplicating', () => {
  // Airtable makes the first field primary and will not change it via the API.
  for (const t of TABLES) {
    assert.equal(t.fields[0].name, 'id', `${t.name} must lead with id`);
    assert.equal(t.fields[0].type, 'singleLineText');
  }
});

test('no table declares the same field twice', () => {
  for (const t of TABLES) {
    const names = t.fields.map((f) => f.name);
    assert.deepEqual([...new Set(names)], names, `${t.name} has duplicate fields`);
  }
});

test('every select field ships its choices', () => {
  // Without choices Airtable rejects the field; with them the base is usable
  // for filtering on day one rather than after the first write.
  for (const t of TABLES) {
    for (const f of t.fields.filter((x) => x.type === 'singleSelect')) {
      assert.ok(f.options?.choices?.length, `${t.name}.${f.name} has no choices`);
      for (const choice of f.options.choices) assert.ok(choice.name, 'choice needs a name');
    }
  }
});

test('the four tables the skills write to are all present', () => {
  assert.deepEqual(TABLES.map((t) => t.name), ['Winners', 'Scripts', 'Renders', 'Posts']);
});

test('diffTable reports a table that does not exist as entirely missing', () => {
  const spec = TABLES[0];
  const d = diffTable(spec, null);
  assert.equal(d.missing.length, spec.fields.length);
  assert.equal(d.wrongType.length, 0);
});

test('diffTable is a no-op against a base that already matches', () => {
  const spec = TABLES[1];
  const d = diffTable(spec, { fields: spec.fields.map((f) => ({ name: f.name, type: f.type })) });
  assert.equal(d.missing.length, 0);
  assert.equal(d.wrongType.length, 0);
  assert.equal(d.primaryOk, true);
});

test('diffTable finds only what is actually missing', () => {
  const spec = TABLES[2];
  const partial = spec.fields.slice(0, 5).map((f) => ({ name: f.name, type: f.type }));
  const d = diffTable(spec, { fields: partial });
  assert.equal(d.missing.length, spec.fields.length - 5);
  assert.ok(!d.missing.some((f) => f.name === 'id'));
});

test('diffTable flags a wrong type rather than silently adding a duplicate', () => {
  const spec = TABLES[0];
  const table = {
    fields: spec.fields.map((f) => (f.name === 'views' ? { name: 'views', type: 'singleLineText' } : { name: f.name, type: f.type })),
  };
  const d = diffTable(spec, table);
  assert.equal(d.missing.length, 0, 'the field exists, so it is not missing');
  assert.deepEqual(d.wrongType, [{ name: 'views', want: 'number', have: 'singleLineText' }]);
});

test('diffTable catches a base whose primary field is not id', () => {
  const spec = TABLES[3];
  const table = { fields: [{ name: 'Name', type: 'singleLineText' }, ...spec.fields.map((f) => ({ name: f.name, type: f.type }))] };
  assert.equal(diffTable(spec, table).primaryOk, false);
});

// --- duplicate topics (a hard gate, not a prompt hint) ---------------------

test('similarity catches a restatement and ignores a shared noun', () => {
  const dupes = [
    ['Most of the dust in your house used to be you', 'House dust is mostly dead human skin cells'],
    ['Sharks existed before trees did', 'Sharks are older than trees by 100 million years'],
    ['The shortest war lasted 38 minutes', 'The shortest war in history was 38 minutes long'],
  ];
  for (const [a, b] of dupes) {
    assert.ok(similarity(a, b) >= DUPLICATE_THRESHOLD, `missed: ${a} ~ ${b}`);
  }

  const distinct = [
    ['Most of the dust in your house used to be you', 'Your brain deletes memories on purpose'],
    // Shares "trees" but is a different claim.
    ['Sharks existed before trees did', 'Trees only evolved 350 million years ago'],
    ['Bananas are radioactive', 'Venus has days longer than its years'],
    ['Airport carpets are ugly for a reason', 'Cleopatra lived closer to the Moon landing'],
  ];
  for (const [a, b] of distinct) {
    assert.ok(similarity(a, b) < DUPLICATE_THRESHOLD, `false positive: ${a} ~ ${b}`);
  }
});

test('similarity is order-blind, because a rewrite reorders everything', () => {
  assert.equal(similarity('dust is mostly dead skin', 'dead skin is mostly dust'), 1);
});

test('similarity is symmetric and safe on empty input', () => {
  const a = 'sharks are older than trees';
  const b = 'trees came after sharks';
  assert.equal(similarity(a, b), similarity(b, a));
  assert.equal(similarity('', a), 0);
  assert.equal(similarity(a, ''), 0);
  assert.equal(similarity('the and but', a), 0, 'stopwords alone carry no topic');
});

test('short words that carry the topic are kept', () => {
  // A 4-letter floor dropped "war", "ice", "sun" - the whole subject.
  assert.ok(contentTokens('the shortest war').has('war'));
  assert.ok(contentTokens('ice is slippery').has('ice'));
});

test('plurals do not read as different topics', () => {
  assert.equal(similarity('shark facts', 'a shark fact'), 1);
});

test('corpusStopwords strips house phrasing once there is a corpus to see it', () => {
  const frame = (t) => ({ text: `${t} nobody mentions what actually happens` });
  const corpus = ['Most Dust', 'Bananas Radioactive', 'Brain Deletes', 'Venus Days'].map(frame);
  const common = corpusStopwords(corpus);
  for (const word of ['nobody', 'mention', 'actually', 'happen']) {
    assert.ok(common.has(word), `${word} should be recognised as boilerplate`);
  }
  assert.ok(!common.has('dust'), 'a topic word is not boilerplate');
});

test('corpusStopwords strips nothing from a corpus too small to judge', () => {
  // Cold start: two scripts sharing a word is not evidence of house style,
  // and stripping it would erase the very topic being compared.
  assert.equal(corpusStopwords([{ text: 'most dust' }, { text: 'more dust' }]).size, 0);
  assert.equal(corpusStopwords([]).size, 0);
});

test('findDuplicate returns the closest match, or null', () => {
  const seen = ['Sharks and trees', 'Radioactive bananas', 'House dust and skin']
    .map((t) => ({ text: t, tokens: contentTokens(t) }));

  const hit = findDuplicate('Dust in the house is skin', seen);
  assert.ok(hit);
  assert.equal(hit.text, 'House dust and skin');
  assert.ok(hit.score >= DUPLICATE_THRESHOLD);

  assert.equal(findDuplicate('Cleopatra and the pyramids', seen), null);
  assert.equal(findDuplicate('', seen), null, 'empty text is never a duplicate');
  assert.equal(findDuplicate('anything', []), null, 'nothing to match against');
});

// --- the Submagic publisher -------------------------------------------------

test('submagic declares itself batched, so the poster groups platforms', () => {
  // One project carries every platform for a video. Three projects per video
  // would triple the account's usage to stagger posts by a couple of hours.
  assert.equal(batched, true);
});

test('buildPlatforms maps each platform to the shape the publish endpoint wants', () => {
  const platforms = buildPlatforms([
    { platform: 'youtube', caption: 'A caption', youtubeTitle: 'A title' },
    { platform: 'instagram', caption: 'IG caption' },
    { platform: 'tiktok', caption: 'TT caption' },
  ]);

  assert.deepEqual(Object.keys(platforms).sort(), ['instagram', 'tiktok', 'youtube']);
  assert.equal(platforms.youtube.title, 'A title');
  assert.equal(platforms.youtube.description, 'A caption');
  assert.equal(platforms.instagram.format, 'reel');

  // TikTok rejects the call without all of these.
  for (const field of [
    'content', 'privacyLevel', 'allowComment', 'allowDuet', 'allowStitch',
    'contentPreviewConfirmed', 'expressConsentGiven',
  ]) {
    assert.ok(field in platforms.tiktok, `tiktok.${field} is required by the API`);
  }
  assert.equal(platforms.tiktok.contentPreviewConfirmed, true);
  assert.equal(platforms.tiktok.expressConsentGiven, true);
});

test('a youtube title falls back to the caption and respects the 100 char cap', () => {
  const long = 'x'.repeat(200);
  const p = buildPlatforms([{ platform: 'youtube', caption: long }]);
  assert.equal(p.youtube.title.length, 100);
  assert.equal(p.youtube.description, long, 'the description is not capped at 100');
});

test('a tiktok caption is trimmed to the platform limit', () => {
  const p = buildPlatforms([{ platform: 'tiktok', caption: 'y'.repeat(3000) }]);
  assert.equal(p.tiktok.content.length, 2200);
});

test('an unmappable platform is skipped rather than sent as nonsense', () => {
  const p = buildPlatforms([
    { platform: 'youtube', caption: 'c', youtubeTitle: 't' },
    { platform: 'myspace', caption: 'c' },
  ]);
  assert.deepEqual(Object.keys(p), ['youtube']);
});

test('buildPlatforms tolerates a missing caption', () => {
  const p = buildPlatforms([{ platform: 'instagram' }]);
  assert.equal(p.instagram.content, '');
  assert.equal(p.instagram.format, 'reel');
});

// --- gemini tts: raw PCM has to become something ffmpeg will open ----------

test('the wav header describes the PCM that follows it', () => {
  const dataLength = 48000;
  const h = wavHeader({ dataLength, sampleRate: 24000 });

  assert.equal(h.length, 44);
  assert.equal(h.toString('ascii', 0, 4), 'RIFF');
  assert.equal(h.toString('ascii', 8, 12), 'WAVE');
  assert.equal(h.toString('ascii', 36, 40), 'data');
  assert.equal(h.readUInt32LE(4), 36 + dataLength, 'RIFF size covers header + data');
  assert.equal(h.readUInt32LE(40), dataLength, 'data chunk size is the payload');
  assert.equal(h.readUInt16LE(20), 1, 'format 1 = uncompressed PCM');
  assert.equal(h.readUInt16LE(22), 1, 'mono');
  assert.equal(h.readUInt32LE(24), 24000, 'sample rate');
  assert.equal(h.readUInt16LE(34), 16, 'bits per sample');
  // 24000 Hz x 1 channel x 2 bytes. A wrong byte rate plays at the wrong speed
  // rather than failing, so it is worth pinning.
  assert.equal(h.readUInt32LE(28), 48000, 'byte rate');
  assert.equal(h.readUInt16LE(32), 2, 'block align');
});

test('stereo and bit depth change the derived rates together', () => {
  const h = wavHeader({ dataLength: 100, sampleRate: 44100, channels: 2, bitsPerSample: 16 });
  assert.equal(h.readUInt16LE(32), 4, 'block align = channels x bytes per sample');
  assert.equal(h.readUInt32LE(28), 44100 * 4);
});

test('the sample rate is read out of the mime type', () => {
  assert.equal(pcmRate('audio/L16;codec=pcm;rate=24000'), 24000);
  assert.equal(pcmRate('audio/L16;codec=pcm;rate=16000'), 16000);
});

test('an unparseable mime type falls back rather than producing NaN', () => {
  // NaN would sail into writeUInt32LE and throw, losing the whole batch for
  // the sake of one unexpected header.
  assert.equal(pcmRate('audio/L16'), 24000);
  assert.equal(pcmRate(undefined), 24000);
  assert.equal(pcmRate(''), 24000);
});

// --- config: an unset Actions variable arrives as '' ----------------------

test('an empty environment variable falls back to the default', () => {
  // `FOO: ${{ vars.FOO }}` with no FOO set exports FOO= , not nothing. Reading
  // that with ?? kept the empty string and silently dropped four defaults.
  process.env.__MACHINE_TEST_EMPTY = '';
  assert.equal(env('__MACHINE_TEST_EMPTY', 'fallback'), 'fallback');
  delete process.env.__MACHINE_TEST_EMPTY;
});

test('an absent environment variable falls back to the default', () => {
  delete process.env.__MACHINE_TEST_ABSENT;
  assert.equal(env('__MACHINE_TEST_ABSENT', 'fallback'), 'fallback');
});

test('a set environment variable still wins over the default', () => {
  process.env.__MACHINE_TEST_SET = 'chosen';
  assert.equal(env('__MACHINE_TEST_SET', 'fallback'), 'chosen');
  delete process.env.__MACHINE_TEST_SET;
});

test('a falsy but meaningful value is not mistaken for absent', () => {
  process.env.__MACHINE_TEST_ZERO = '0';
  assert.equal(env('__MACHINE_TEST_ZERO', 'fallback'), '0');
  delete process.env.__MACHINE_TEST_ZERO;
});

// --- pillar rotation: four scripts, one pillar, six in the brief ----------

const PILLARS = [
  { id: 'did-you-know', weight: 3 },
  { id: 'how-things-work', weight: 2 },
  { id: 'psychology', weight: 2 },
  { id: 'money-life', weight: 2 },
  { id: 'history-bite', weight: 1 },
  { id: 'internet', weight: 1 },
];

test('a recently used pillar is not chosen again', () => {
  const recent = ['did-you-know', 'how-things-work', 'psychology'];
  for (let i = 0; i < 50; i++) {
    const p = choosePillar(PILLARS, recent);
    assert.ok(!recent.includes(p.id), `${p.id} was used recently`);
  }
});

test('weight decides the pick among what is left', () => {
  // pick() lands in the first slot, so the heaviest remaining pillar wins.
  assert.equal(choosePillar(PILLARS, [], () => 0.01).id, 'did-you-know');
  // ...and at the top of the range, the last one does.
  assert.equal(choosePillar(PILLARS, [], () => 0.999).id, 'internet');
});

test('every pillar being recent falls back rather than returning nothing', () => {
  // Otherwise a channel that has covered all six stops producing scripts.
  const all = PILLARS.map((p) => p.id);
  const p = choosePillar(PILLARS, all);
  assert.ok(all.includes(p.id));
});

test('a single pillar is still a valid choice', () => {
  assert.equal(choosePillar([{ id: 'only', weight: 1 }], []).id, 'only');
});

// --- a dead post must not keep holding its slot -------------------------

test('retired and failed posts free their slots again', () => {
  // Six superseded rows and two failures filled both of one day's YouTube
  // slots and both of the next, pushing the first working video two days out.
  for (const status of ['superseded', 'schedule-failed', 'post-failed', 'cancelled']) {
    assert.ok(DEAD_POST_STATUS.has(status), `${status} should free its slot`);
  }
});

test('a live post still holds its slot', () => {
  // Getting this wrong double-books a slot and publishes two videos at the
  // same minute, which is worse than the drift it was meant to fix.
  for (const status of ['queued', 'scheduled', 'published', 'posted']) {
    assert.ok(!DEAD_POST_STATUS.has(status), `${status} must keep its slot`);
  }
});

test('an unrecognised status keeps its slot rather than freeing it', () => {
  assert.ok(!DEAD_POST_STATUS.has('some-future-status'));
  assert.ok(!DEAD_POST_STATUS.has(undefined));
});

// --- higgsfield returns its asset at a path the SDK describes loosely -----

test('the asset url is found in the documented job shape', () => {
  const status = { status: 'completed', jobs: [{ results: { raw: { url: 'https://cdn/a.png' } } }] };
  assert.equal(firstAssetUrl(status), 'https://cdn/a.png');
});

test('a jobSet wrapper is unwrapped too', () => {
  const status = { jobSet: { jobs: [{ results: { raw: { url: 'https://cdn/b.png' } } }] } };
  assert.equal(firstAssetUrl(status), 'https://cdn/b.png');
});

test('the first job carrying a url wins, not the first job', () => {
  // A multi-job set can report an empty job first; taking jobs[0] blindly
  // would decide the generation produced nothing.
  const status = { jobs: [{ results: {} }, { results: { raw: { url: 'https://cdn/c.png' } } }] };
  assert.equal(firstAssetUrl(status), 'https://cdn/c.png');
});

test('no url anywhere returns null rather than undefined-ish truthiness', () => {
  assert.equal(firstAssetUrl({ status: 'completed', jobs: [] }), null);
  assert.equal(firstAssetUrl({}), null);
  assert.equal(firstAssetUrl(null), null);
});

// --- rss: the two shapes that exist in the wild --------------------------

const RSS2 = `<rss><channel>
  <item>
    <title>Rocket launch delayed by weather</title>
    <link>https://example.com/a</link>
    <description>The launch slipped to Thursday.</description>
    <pubDate>Wed, 17 Sep 2026 10:00:00 GMT</pubDate>
  </item>
</channel></rss>`;

const ATOM = `<feed>
  <entry>
    <title>Rocket launch delayed by weather</title>
    <link href="https://example.com/b"/>
    <summary>Scrubbed for high winds.</summary>
    <updated>2026-09-17T10:00:00Z</updated>
  </entry>
</feed>`;

test('an RSS 2.0 item is parsed, link from the element body', () => {
  const [item] = parseFeed(RSS2, { source: 'x' });
  assert.equal(item.title, 'Rocket launch delayed by weather');
  assert.equal(item.url, 'https://example.com/a');
  assert.equal(item.summary, 'The launch slipped to Thursday.');
  assert.equal(item.publishedAt.toISOString(), '2026-09-17T10:00:00.000Z');
});

test('an Atom entry is parsed, link from the href attribute', () => {
  // RSS puts the url in the body and Atom in an attribute. Reading only one
  // shape drops every item from half the feeds, on the url check.
  const [item] = parseFeed(ATOM, { source: 'y' });
  assert.equal(item.url, 'https://example.com/b');
  assert.equal(item.publishedAt.toISOString(), '2026-09-17T10:00:00.000Z');
});

test('CDATA and entities are unwrapped', () => {
  assert.equal(textOf('<![CDATA[Tom &amp; Jerry]]>'), 'Tom & Jerry');
  assert.equal(decodeEntities('caf&#233;'), 'caf\u00e9');
  assert.equal(decodeEntities('&#x2014;dash'), '\u2014dash');
  assert.equal(textOf('<p>nested <b>markup</b></p>'), 'nested markup');
});

test('an item missing a title or a link is skipped, not half-stored', () => {
  const xml = `<rss><item><title>No link here</title></item>
               <item><link>https://example.com/c</link></item></rss>`;
  assert.equal(parseFeed(xml).length, 0);
});

test('an unparseable date is null rather than the epoch or now', () => {
  // Returning a Date here would make a junk item look fresh and let it
  // through the recency filter.
  assert.equal(dateOf('<item><pubDate>not a date</pubDate></item>'), null);
  assert.equal(dateOf('<item></item>'), null);
});

test('namespaced date tags are read', () => {
  assert.equal(dateOf('<item><dc:date>2026-09-17T10:00:00Z</dc:date></item>')?.toISOString(),
    '2026-09-17T10:00:00.000Z');
});

test('malformed xml yields no items instead of throwing', () => {
  assert.deepEqual(parseFeed('<rss><item><title>unclosed'), []);
  assert.deepEqual(parseFeed(''), []);
  assert.deepEqual(parseFeed(null), []);
});

// --- clustering: corroboration is the signal -----------------------------

const at = (h) => new Date(Date.UTC(2026, 8, 17, h, 0, 0));

test('the same event from different outlets forms one story', () => {
  const items = [
    { title: 'Rocket launch delayed by bad weather', url: 'a', source: 'bbc', publishedAt: at(9) },
    { title: 'Bad weather delays rocket launch', url: 'b', source: 'npr', publishedAt: at(10) },
    { title: 'Weather forces rocket launch delay', url: 'c', source: 'cbc', publishedAt: at(11) },
  ];
  const [story] = rankStories(clusterStories(items), { minSources: 2, now: at(12) });
  assert.equal(story.sourceCount, 3);
  assert.equal(story.urls.length, 3);
});

test('one outlet running a story five times is not corroboration', () => {
  // Counting items rather than outlets would let a single prolific feed
  // manufacture a top story every run.
  const items = Array.from({ length: 5 }, (_, i) => ({
    title: 'Rocket launch delayed by bad weather',
    url: `u${i}`, source: 'bbc', publishedAt: at(9),
  }));
  assert.equal(rankStories(clusterStories(items), { minSources: 2, now: at(12) }).length, 0);
});

test('unrelated headlines stay separate', () => {
  const items = [
    { title: 'Rocket launch delayed by bad weather', url: 'a', source: 'bbc', publishedAt: at(9) },
    { title: 'Central bank holds interest rates steady', url: 'b', source: 'npr', publishedAt: at(9) },
  ];
  assert.equal(clusterStories(items).length, 2);
});

test('the earliest report dates the story, not the latest rewrite', () => {
  const items = [
    { title: 'Central bank holds interest rates steady', url: 'a', source: 'bbc', publishedAt: at(14) },
    { title: 'Interest rates held steady by central bank', url: 'b', source: 'npr', publishedAt: at(9) },
  ];
  // minInterest:0 so this tests dating and nothing else - "interest rates"
  // scores dull, and the interest gate would otherwise drop the fixture
  // before the assertion could run.
  const [story] = rankStories(clusterStories(items), { minSources: 2, minInterest: 0, now: at(15) });
  assert.equal(story.ageHours, 6);
});

test('at equal interest, more corroborated outranks fresher', () => {
  // Corroboration is now the TIEBREAK, not the ranking - so this has to pit
  // two stories of equal interest against each other, or it would really be
  // testing the interest score. Both are launches: one bright word each.
  const items = [
    { title: 'Rocket launch delayed by bad weather', url: 'a', source: 'bbc', publishedAt: at(1) },
    { title: 'Bad weather delays rocket launch', url: 'b', source: 'npr', publishedAt: at(1) },
    { title: 'Weather forces rocket launch delay', url: 'c', source: 'cbc', publishedAt: at(1) },
    { title: 'Balloon launch postponed until Friday', url: 'd', source: 'bbc', publishedAt: at(11) },
    { title: 'Friday postponement for the balloon launch', url: 'e', source: 'npr', publishedAt: at(11) },
  ];
  const ranked = rankStories(clusterStories(items), { minSources: 2, now: at(12) });
  assert.equal(ranked.length, 2, 'both stories clear both gates');
  assert.equal(ranked[0].interest, ranked[1].interest, 'the fixture is a genuine tie on interest');
  assert.match(ranked[0].title, /[Rr]ocket/, 'the better-corroborated one wins the tie');
  assert.equal(ranked[0].sourceCount, 3);
});

test('word order and filler do not change a story id', () => {
  // Feeds re-serve the same headline for days, so the id must not depend on
  // ordering or stopwords. It is NOT stemmed - see storyId for why - so
  // "delays" vs "delayed" is expected to differ, and findDuplicate catches
  // that case by topic instead.
  assert.equal(
    storyId('Rocket launch delayed by bad weather'),
    storyId('Bad weather: the rocket launch, delayed'),
  );
});

test('different stories get different ids', () => {
  assert.notEqual(
    storyId('Rocket launch delayed by bad weather'),
    storyId('Central bank holds interest rates steady'),
  );
});

// --- the news pillar -----------------------------------------------------

test('a news winner is recognised by its source, not its shape', () => {
  assert.equal(isNewsWinner({ platform: 'news' }), true);
  assert.equal(isNewsWinner({ platform: 'tiktok' }), false);
  assert.equal(isNewsWinner({}), false);
  assert.equal(isNewsWinner(null), false);
  assert.equal(isNewsWinner(undefined), false);
});

test('the news pillar exists for stories to be assigned to', () => {
  // The writer forces this pillar for a news winner rather than rotating,
  // so its absence would mean an undefined pillar reaching the prompt.
  const pillar = NICHE.pillars.find((p) => p.id === 'news');
  assert.ok(pillar, 'NICHE.pillars must carry a news pillar');
  assert.ok(pillar.label);
});

test('a script echoing the report is caught, headline and summary alike', () => {
  // The failure mode for news is reading the report back, and the report is
  // the headline PLUS the outlet summary - measuring only one lets a script
  // lift the other wholesale.
  const headline = 'Central bank holds interest rates steady at four percent';
  const summary = 'The decision was widely expected by economists after inflation eased.';
  const source = `${headline} ${summary}`;

  assert.ok(overlapRatio(source, headline) > 0.5, 'lifting the headline is an echo');
  assert.ok(overlapRatio(source, summary) > 0.5, 'lifting the summary is an echo too');
  assert.equal(
    overlapRatio(source, 'Borrowing costs stay put for a fourth straight meeting.'),
    0,
    'an original line about the same event is not an echo',
  );
});

// --- typecast: the store creates select options it has not seen ----------

test('diffTable reports missing fields, and leaves choices alone', () => {
  // The Airtable store writes with typecast:true, so a select value it has
  // not seen is CREATED rather than rejected. An earlier version of this
  // checked choices too and blocked every run over options Airtable would
  // have made itself - and Airtable will not add them by API anyway.
  const spec = {
    name: 'Scripts',
    fields: [
      { name: 'id', type: 'singleLineText' },
      { name: 'status', type: 'singleSelect', options: { choices: [{ name: 'a' }, { name: 'b' }] } },
      { name: 'review', type: 'singleLineText' },
    ],
  };
  const live = {
    fields: [
      { name: 'id', type: 'singleLineText' },
      { name: 'status', type: 'singleSelect', options: { choices: [{ name: 'a', id: 'x' }] } },
    ],
  };
  const d = diffTable(spec, live);
  assert.deepEqual(d.missing.map((f) => f.name), ['review'], 'the absent FIELD is the finding');
  assert.equal(d.missingChoices, undefined, 'choices are not diffed');
});

test('the news screen drops violence against people', () => {
  // The story that prompted this: the desk handed the writer a shooting and
  // the writer wrote it up, because a prose exclusion cannot decline an
  // assignment. The refusal has to happen before the writer is asked.
  assert.equal(harshMatch('ICE Agent Shoots Driver in Austin'), 'shoots');
  assert.equal(harshMatch('Death toll rises after weekend quake'), 'death toll');
  assert.ok(isTooHarsh('Man stabbed outside the stadium'));
});

test('the news screen does not fire on words that merely contain one', () => {
  // Whole-word matching is the whole reason this is a regex and not indexOf.
  // Without \b, "shot" eats every screenshot and moonshot on the wire and the
  // desk goes quiet for a reason nobody can see.
  for (const safe of [
    'Screenshot tool ships on Linux',
    'Deadline extended for tax filing',
    'NASA moonshot slips to 2027',
    'Canada and France expand trade ties',
    'Deadlock broken in budget talks',
  ]) {
    assert.equal(harshMatch(safe), null, safe);
  }
});

test('interest scores discovery above procedure', () => {
  assert.ok(interestScore('Astronomers discover the oldest black hole yet').score > 0);
  assert.ok(interestScore('Deadline extended for tax filing').score < 0);
  // The exact failure the user named: a real story, correctly reported, that
  // nobody would watch.
  assert.ok(
    interestScore('Ancient tomb unearthed, hidden chamber revealed').score >
      interestScore('Canada and France sign bilateral trade deal').score,
  );
});

test('interest matches whole words only', () => {
  // Substring matching scored "billion" as the legislative sense of `bill`
  // and "secretary" as `secret`, which put money stories in the wrong column.
  assert.equal(interestScore('Over 100 billion in annual trade').dull.includes('bill'), false);
  assert.equal(interestScore('Secretary announces reshuffle').bright.includes('secrets'), false);
});

const story = (title, sources, summary = '') =>
  ({ tokens: new Set(), items: [{ title, url: 'u', summary, publishedAt: new Date() }],
     sources: new Set(sources) });

test('a primary source needs no corroboration', () => {
  // The bug this fixes: every science feed breaks its own stories, so each
  // scored one outlet and was dropped, while six world desks corroborated
  // each other on procedural news and swept the batch.
  const out = rankStories(
    [story('NASA rover discovers strange ancient rock on Mars', ['nasa'])],
    { minSources: 2, primarySources: ['nasa'], now: new Date() },
  );
  assert.equal(out.length, 1, 'NASA reporting NASA does not need a second outlet');
});

test('corroboration gates, interest ranks', () => {
  const out = rankStories(
    [
      // Widely carried and dull - used to win on six outlets alone.
      story('Tax filing deadline extended by parliament', ['bbc', 'npr', 'guardian', 'aljazeera']),
      // Thinly carried and fascinating.
      story('Ancient tomb unearthed with hidden chamber', ['phys-org', 'smithsonian']),
    ],
    { minSources: 2, now: new Date() },
  );
  assert.equal(out.length, 1, 'the procedural story fails the interest gate');
  assert.match(out[0].title, /tomb/);
});

test('an uncorroborated non-primary story is still dropped', () => {
  // Interest must not become a way around the truth gate.
  const out = rankStories(
    [story('Mysterious ancient artifact discovered', ['someblog'])],
    { minSources: 2, primarySources: ['nasa'], now: new Date() },
  );
  assert.equal(out.length, 0);
});

test('the harshness screen covers the variants the first live run leaked', () => {
  // Both of these reached the winners table. The list held `killing` but not
  // `killings`, and `dead` but not `dies`. A word list that is one inflection
  // short is a story published.
  assert.equal(harshMatch('Man, 82, dies after beach fight over sunlounger'), 'dies');
  assert.equal(
    harshMatch("Patrick Clancy opens up on children's killings in first interview"),
    'killings',
  );
  for (const w of ['die', 'died', 'dying', 'death', 'killer', 'victims', 'slaying']) {
    assert.ok(harshMatch(`report says ${w} confirmed`), w);
  }
});

test('generic novelty words do not make a story interesting', () => {
  // `first` scored a child-killing story as interesting because the interview
  // was the "first televised" one. Novelty has to be novel on its own.
  assert.equal(interestScore('the first televised interview').bright.includes('first'), false);
  assert.ok(interestScore('the first-ever image of a black hole').score > 0);
});

test('a plain space story scores on its headline alone', () => {
  // "Juice to fly past Earth for third gravity assist" scored zero on its
  // title and survived only on incidental words in its summary - the space
  // vocabulary was missing from the list entirely.
  assert.ok(interestScore('Juice to fly past Earth for third gravity assist').score > 0);
  assert.ok(interestScore('Probe enters orbit around the planet').score > 0);
});

test('crime procedure and human interest score dull', () => {
  assert.ok(interestScore('Three sisters detained ahead of Islamabad march').score < 0);
  assert.ok(interestScore('Suspect charged and remanded in custody').score < 0);
});

test('an uncorroborated story clears a higher bar than a corroborated one', () => {
  // A primary feed is the ORGANISATION's feed, not a discoveries feed. NASA's
  // put an ethics notice, a festival appearance and the daily astronomy photo
  // into the winners table, all waved past corroboration by the exemption
  // meant for its missions.
  const weak = story('Nebula photo of the day', ['nasa'], '');
  const strong = story('Probe to fly past Earth for gravity assist', ['nasa'], '');
  const opts = { minSources: 2, minInterest: 1, minInterestUncorroborated: 2,
                 primarySources: ['nasa'], now: new Date() };
  assert.equal(rankStories([weak], opts).length, 0, 'one bright word is not enough alone');
  assert.equal(rankStories([strong], opts).length, 1, 'a real mission story clears it');
  // The same weak story is fine once a second outlet attests to it.
  const attested = story('Nebula photo of the day', ['nasa', 'phys-org'], '');
  assert.equal(rankStories([attested], opts).length, 1, 'corroboration lowers the bar');
});

test('institutional housekeeping scores dull', () => {
  assert.ok(interestScore('Widely Attended Gatherings (WAGs) Determinations').score < 0);
  assert.ok(interestScore('Space Center Sparks Curiosity at Annual Japan Festival').score < 0);
});
