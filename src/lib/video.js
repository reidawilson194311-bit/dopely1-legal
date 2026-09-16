import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { config } from '../config.js';
import { logger } from './log.js';

const log = logger('video');
const run = promisify(execFile);

export class FfmpegMissingError extends Error {
  constructor() {
    super(
      'ffmpeg was not found. Install it (apt install ffmpeg / brew install ffmpeg) ' +
      'or set FFMPEG_PATH to the binary.',
    );
    this.name = 'FfmpegMissingError';
  }
}

let ffmpegChecked;
export async function hasFfmpeg() {
  if (ffmpegChecked !== undefined) return ffmpegChecked;
  try {
    await run(config.design.ffmpeg, ['-version'], { timeout: 10000 });
    ffmpegChecked = true;
  } catch {
    ffmpegChecked = false;
  }
  return ffmpegChecked;
}

/** Exact media duration in seconds, or null when ffprobe is unavailable. */
export async function probeDuration(file) {
  try {
    const { stdout } = await run(config.design.ffprobe, [
      '-v', 'error', '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1', file,
    ], { timeout: 20000 });
    const d = Number(String(stdout).trim());
    return Number.isFinite(d) && d > 0 ? d : null;
  } catch {
    return null;
  }
}

/**
 * Minimal ffmpeg builds (including the pip-installed imageio-ffmpeg binary)
 * ship without libfreetype, so drawtext is absent even when a font exists.
 * Check the filter, not just the font, or every encode dies at the filtergraph.
 */
let drawtextChecked;
export async function hasDrawtext() {
  if (drawtextChecked !== undefined) return drawtextChecked;
  try {
    const { stdout } = await run(config.design.ffmpeg, ['-hide_banner', '-filters'], {
      timeout: 15000,
      maxBuffer: 8 * 1024 * 1024,
    });
    drawtextChecked = /\bdrawtext\b/.test(stdout);
  } catch {
    drawtextChecked = false;
  }
  if (!drawtextChecked) {
    log.warn('this ffmpeg build has no drawtext filter - captions will not be burned in');
  }
  return drawtextChecked;
}

const FONT_CANDIDATES = [
  '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
  '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf',
  '/usr/share/fonts/TTF/DejaVuSans-Bold.ttf',
  '/System/Library/Fonts/Supplemental/Arial Bold.ttf',
  '/Library/Fonts/Arial Bold.ttf',
  'C:/Windows/Fonts/arialbd.ttf',
];

let fontPath;
export function findFont() {
  if (fontPath !== undefined) return fontPath;
  fontPath = process.env.CAPTION_FONT || FONT_CANDIDATES.find((f) => fs.existsSync(f)) || null;
  if (!fontPath) log.warn('no bold TTF found - captions will not be burned in. Set CAPTION_FONT.');
  return fontPath;
}

/** Hard-wrap on-screen text so it never runs off a 1080px frame. */
export function wrapCaption(text, perLine = 18) {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const w of words) {
    if (line && (line + ' ' + w).length > perLine) {
      lines.push(line);
      line = w;
    } else {
      line = line ? `${line} ${w}` : w;
    }
  }
  if (line) lines.push(line);
  return lines.join('\n');
}

/** ffmpeg filter arguments are colon-separated, so the value has to be escaped. */
const esc = (v) => String(v).replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'");

/**
 * Build the filter_complex graph. Pure and exported so its shape can be tested
 * without an ffmpeg binary - the graph is the part that breaks silently.
 */
export function buildFilterGraph({
  beats, width, height, fps, font, tmp,
  voiceIdx = [], musicIdx = -1, musicVolume = 0.12,
  writeFile = (p, c) => fs.writeFileSync(p, c, 'utf8'),
}) {
  const filters = [];

  beats.forEach((beat, i) => {
    const frames = Math.max(1, Math.round(beat.durationSec * fps));
    // Upscale before zoompan or the push-in steps visibly; 1.5x is enough to
    // hide it and costs roughly half the encode time of 2x.
    const zw = Math.round(width * 1.5);
    const zh = Math.round(height * 1.5);
    const chain = [
      `scale=${zw}:${zh}:force_original_aspect_ratio=increase`,
      `crop=${zw}:${zh}`,
      `zoompan=z='min(zoom+0.0009,1.14)':d=${frames}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${width}x${height}:fps=${fps}`,
      'setsar=1',
      'format=yuv420p',
    ];

    if (font && beat.onScreenText) {
      // One drawtext per line, each centred on its own width. drawtext's own
      // `text_align` only exists in ffmpeg 7+, and multi-line text without it
      // renders left-aligned inside a centred box, which looks broken.
      // Per-line is portable and correctly centred everywhere.
      const fontSize = Math.round(width * 0.075);
      const lineHeight = Math.round(fontSize * 1.3);
      const lines = wrapCaption(beat.onScreenText).split('\n');
      const top = Math.round(height * 0.68) - Math.round(((lines.length - 1) * lineHeight) / 2);
      lines.forEach((line, li) => {
        const textFile = path.join(tmp, `cap${i}-${li}.txt`);
        writeFile(textFile, line);
        chain.push(
          `drawtext=fontfile='${esc(font)}':textfile='${esc(textFile)}'` +
            `:fontsize=${fontSize}:fontcolor=white` +
            `:box=1:boxcolor=black@0.55:boxborderw=18` +
            `:x=(w-text_w)/2:y=${top + li * lineHeight}`,
        );
      });
    }
    filters.push(`[${i}:v]${chain.join(',')}[v${i}]`);
  });

  filters.push(`${beats.map((_, i) => `[v${i}]`).join('')}concat=n=${beats.length}:v=1:a=0[vout]`);

  const total = beats.reduce((sum, b) => sum + b.durationSec, 0);
  const hasVoice = voiceIdx.length > 0 && voiceIdx.length === beats.length;

  if (hasVoice) {
    filters.push(`${voiceIdx.map((i) => `[${i}:a]`).join('')}concat=n=${voiceIdx.length}:v=0:a=1[voice]`);
    if (musicIdx >= 0) {
      filters.push(`[${musicIdx}:a]volume=${musicVolume},atrim=0:${total.toFixed(2)}[bed]`);
      filters.push('[voice][bed]amix=inputs=2:duration=first:dropout_transition=0[aout]');
    } else {
      filters.push('[voice]anull[aout]');
    }
  } else if (musicIdx >= 0) {
    filters.push(`[${musicIdx}:a]volume=${musicVolume},atrim=0:${total.toFixed(2)}[aout]`);
  }

  return filters;
}

/**
 * Assemble one vertical short.
 *
 * beats: [{ imagePath, onScreenText, durationSec, audioPath? }]
 *
 * Each still gets a slow push-in so a sequence of static images reads as video
 * rather than a slideshow, with the caption burned into the lower third where
 * neither the Reels UI nor the Shorts UI covers it.
 */
export async function assemble(beats, outPath, opts = {}) {
  if (!(await hasFfmpeg())) throw new FfmpegMissingError();

  const { width, height, fps, musicFile, musicVolume } = { ...config.design, ...opts };
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'short-'));
  const canBurn = (await hasDrawtext()) && Boolean(findFont());
  const font = canBurn ? findFont() : null;

  try {
    const args = ['-y', '-loglevel', 'error'];
    // Each still is fed as a SINGLE frame, not looped. zoompan's `d` is output
    // frames *per input frame*, so looping a 5-second still into it asks for
    // 125 x d frames and the encode effectively never finishes. One frame in,
    // `d` frames out, exactly the beat length.
    for (const b of beats) args.push('-i', b.imagePath);

    const voiceIdx = [];
    for (const b of beats) {
      if (b.audioPath) {
        voiceIdx.push(args.filter((a) => a === '-i').length);
        args.push('-i', b.audioPath);
      }
    }
    const hasVoice = voiceIdx.length === beats.length && beats.length > 0;

    let musicIdx = -1;
    if (musicFile && fs.existsSync(musicFile)) {
      musicIdx = args.filter((a) => a === '-i').length;
      args.push('-stream_loop', '-1', '-i', musicFile);
    }

    const filters = buildFilterGraph({
      beats, width, height, fps, font, tmp,
      voiceIdx: hasVoice ? voiceIdx : [],
      musicIdx, musicVolume,
    });
    const audioMap = filters.some((f) => f.endsWith('[aout]')) ? '[aout]' : null;
    const total = beats.reduce((sum, b) => sum + b.durationSec, 0);

    args.push('-filter_complex', filters.join(';'), '-map', '[vout]');
    if (audioMap) args.push('-map', audioMap, '-c:a', 'aac', '-b:a', '160k');
    args.push(
      '-r', String(fps),
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
      // Cap the bitrate: the platforms re-encode anything we upload, so a
      // 30MB file buys nothing over a 6MB one except a slow, failure-prone
      // upload. The ceiling also stops a noisy frame blowing up the file.
      '-maxrate', '6M', '-bufsize', '12M',
      '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
      '-shortest', outPath,
    );

    log.debug(`encoding ${beats.length} beats -> ${path.basename(outPath)} (${total.toFixed(1)}s)`);
    try {
      await run(config.design.ffmpeg, args, { timeout: 15 * 60 * 1000, maxBuffer: 16 * 1024 * 1024 });
    } catch (err) {
      // ffmpeg echoes the whole filtergraph back on failure; keep the tail,
      // which is where the actual reason is, and drop the rest.
      const detail = String(err.stderr || err.message).trim().split('\n').slice(-3).join(' | ');
      throw new Error(`ffmpeg failed: ${detail.slice(0, 500)}`);
    }
    return {
      path: outPath,
      durationSec: Number(total.toFixed(2)),
      hasAudio: Boolean(audioMap),
      captionsBurned: canBurn,
    };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

export default assemble;
