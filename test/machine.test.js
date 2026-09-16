import { test } from 'node:test';
import assert from 'node:assert/strict';

import { pickWinners, median, engagementRate } from '../src/lib/score.js';
import { normalize, extractHook } from '../src/lib/normalize.js';
import { overlapRatio } from '../src/skills/02-copywriter.js';
import { wrapCaption, buildFilterGraph } from '../src/lib/video.js';
import { composeCaption } from '../src/skills/04-poster.js';
import { nextSlots, zonedTimeToUtc } from '../src/lib/schedule.js';
import { placeholderPNG, buildPrompt } from '../src/lib/nanobanana.js';
import { estimateDuration } from '../src/lib/tts.js';

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
