/**
 * SKILL 03 / THE DESIGNER  -  "It makes the visuals."
 *
 *   INPUT   reads the copy table
 *   ENGINE  nano banana turns each row of copy into an image
 *   OUTPUT  a vertical short, ready to publish
 *
 * No designer. No camera. No face.
 *
 * The video shows this stage producing a carousel. Reels, TikTok and Shorts all
 * want video, so the frames are assembled into a 1080x1920 MP4 instead - the
 * storyboard of stills is kept as well, so the same run can also post a
 * carousel to Instagram if you want both.
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { logger } from '../lib/log.js';
import { getStore, TABLES } from '../lib/store/index.js';
import { generateImage } from '../lib/nanobanana.js';
import { speak, estimateDuration } from '../lib/tts.js';
import { assemble, hasFfmpeg, probeDuration, FfmpegMissingError } from '../lib/video.js';
import { hostVideo } from '../lib/host/githubRelease.js';
import { newId } from '../lib/id.js';
import { reportBatch } from '../lib/batch.js';

const log = logger('03-design');

async function buildOne(script, store) {
  const dir = path.join(config.outDir, script.slug || script.id);
  fs.mkdirSync(dir, { recursive: true });

  // The hook is beat zero: it gets its own frame so the first 1.5 seconds are
  // doing the work rather than a title card nobody reads.
  const beatsIn = [
    { onScreenText: script.hook, voiceover: script.hook, imagePrompt: script.beats[0].imagePrompt },
    ...script.beats,
  ];

  const beats = [];
  for (const [i, beat] of beatsIn.entries()) {
    const imagePath = path.join(dir, `beat-${String(i).padStart(2, '0')}.png`);
    if (!fs.existsSync(imagePath)) {
      await generateImage(beat.imagePrompt, imagePath);
    }
    const audioPath = await speak(beat.voiceover, path.join(dir, `beat-${String(i).padStart(2, '0')}.mp3`));
    const durationSec =
      (audioPath && (await probeDuration(audioPath))) ?? estimateDuration(beat.voiceover);
    beats.push({
      imagePath,
      audioPath,
      onScreenText: beat.onScreenText,
      voiceover: beat.voiceover,
      durationSec: Number((durationSec + 0.35).toFixed(2)), // a breath between beats
    });
  }

  const videoPath = path.join(dir, 'short.mp4');
  let video = null;
  try {
    video = await assemble(beats, videoPath);
  } catch (err) {
    if (!(err instanceof FfmpegMissingError)) throw err;
    log.warn('ffmpeg missing - storyboard saved, video not encoded');
  }

  // Host it NOW, while the file still exists.
  //
  // A CI runner is destroyed when its job ends, so `videoPath` is meaningless
  // to any later job - and the poster runs later by design: the ramp posts
  // fewer videos per run than the designer renders, so there is always a
  // backlog whose files have already gone. Publishing that backlog used to
  // fail with "rendered video missing" pointing at a path on a machine that no
  // longer exists. A URL survives the runner; a path does not.
  let videoUrl = null;
  if (video && config.host.githubToken && config.host.repo) {
    try {
      videoUrl = await hostVideo(video.path);
    } catch (err) {
      // Not fatal here: the short is rendered and stored either way, and a
      // post in the same job can still publish from disk.
      log.warn(`could not host ${script.slug} for later publishing`, err.message);
    }
  }

  const row = {
    id: newId('rnd'),
    scriptId: script.id,
    niche: script.niche,
    title: script.title,
    slug: script.slug,
    pillar: script.pillar,
    dir,
    frames: beats.map((b) => b.imagePath),
    videoPath: video?.path || null,
    videoUrl,
    durationSec: video?.durationSec ?? Number(beats.reduce((s, b) => s + b.durationSec, 0).toFixed(2)),
    hasAudio: Boolean(video?.hasAudio),
    captions: script.captions,
    hashtags: script.hashtags,
    youtubeTitle: script.youtubeTitle,
    cta: script.cta,
    status: video ? 'ready-to-post' : 'needs-encode',
    renderedAt: new Date().toISOString(),
  };

  fs.writeFileSync(path.join(dir, 'script.json'), JSON.stringify({ ...script, render: row }, null, 2));
  await store.patch(TABLES.SCRIPTS, script.id, { status: video ? 'designed' : 'needs-encode' });
  return row;
}

export async function design({ limit = config.design.batchSize } = {}) {
  log.banner('SKILL 03 / THE DESIGNER', 'It makes the visuals.');
  const store = getStore();

  const scripts = await store.list(TABLES.SCRIPTS, {
    where: (r) => r.status === 'ready-to-design',
    limit,
  });
  if (!scripts.length) {
    log.warn('no scripts waiting - run the copywriter first');
    return [];
  }
  log.info(`INPUT: ${scripts.length} scripts`);
  if (!(await hasFfmpeg())) {
    log.warn('ffmpeg not found - frames will be generated but nothing will be encoded');
  }

  const rendered = [];
  const errors = [];
  for (const script of scripts) {
    try {
      const row = await buildOne(script, store);
      rendered.push(row);
      log.info(`  ${row.status === 'ready-to-post' ? 'rendered' : 'storyboarded'} "${row.title}" ` +
        `(${row.frames.length} frames, ${row.durationSec}s)`);
    } catch (err) {
      log.error(`failed on ${script.id}`, err.message);
      errors.push(err.message);
      await store.patch(TABLES.SCRIPTS, script.id, { status: 'design-failed' });
    }
  }

  if (rendered.length) await store.upsert(TABLES.RENDERS, rendered);
  log.info(`OUTPUT: ${rendered.length} shorts in ${config.outDir}`);

  // speak() swallows a failed beat on purpose - losing one voiceover is better
  // than losing the batch. But every beat failing is a broken provider, not a
  // run of bad luck, and it produced four silent shorts and a green tick.
  reportBatch(log, { attempted: scripts.length, succeeded: rendered.length, errors });

  // Thrown after the upsert so the renders are kept: they cost real money and
  // are still useful, they are just not what was asked for. reportBatch only
  // fails a stage where nothing succeeded, and here four shorts rendered
  // perfectly well - silently.
  if (config.design.ttsProvider !== 'none' && rendered.length && !rendered.some((r) => r.hasAudio)) {
    throw new Error(
      `TTS_PROVIDER=${config.design.ttsProvider} produced no audio on any beat - ` +
        `all ${rendered.length} short(s) are silent. See the [tts] warnings above for the reason.`,
    );
  }

  return rendered;
}

export default design;
