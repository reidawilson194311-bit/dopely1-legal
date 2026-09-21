import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { request } from './http.js';
import { config } from '../config.js';
import { logger } from './log.js';

const log = logger('nano-banana');
const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';

/** Art direction prepended to every beat prompt so a set of frames matches. */
export const STYLES = {
  'editorial-bold': [
    'Editorial photograph, vertical 9:16 composition, subject centred with clear',
    'headroom in the upper third for a caption. Warm neutral palette, single soft',
    'key light, shallow depth of field, gentle film grain. Photographic realism.',
  ].join(' '),
  'flat-graphic': [
    'Flat vector illustration, vertical 9:16, bold geometric shapes, two accent',
    'colours on a cream background, thick clean outlines, generous negative space',
    'in the upper third. No gradients.',
  ].join(' '),
  'retro-print': [
    'Retro risograph print, vertical 9:16, limited two-ink palette, visible paper',
    'texture and slight misregistration, high contrast, space at the top.',
  ].join(' '),
};

const GUARDRAILS =
  'No text, letters, numbers, watermarks or logos anywhere in the image. ' +
  'No recognisable real people and no celebrity likenesses. No brand marks.';

export function buildPrompt(imagePrompt, styleKey = config.design.styleKey) {
  const style = STYLES[styleKey] || STYLES['editorial-bold'];
  return `${imagePrompt}\n\nSTYLE: ${style}\n\nCONSTRAINTS: ${GUARDRAILS}`;
}

async function callGemini(model, prompt, apiKey, { retries } = {}) {
  const res = await request(`${ENDPOINT}/${model}:generateContent?key=${encodeURIComponent(apiKey)}`, {
    retries,
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { responseModalities: ['IMAGE'], imageConfig: { aspectRatio: '9:16' } },
    }),
    timeoutMs: 180000,
  });
  const parts = res?.candidates?.[0]?.content?.parts || [];
  const inline = parts.find((p) => p.inlineData?.data);
  if (!inline) {
    const blocked = res?.promptFeedback?.blockReason;
    throw new Error(blocked ? `image request blocked: ${blocked}` : 'no image in Gemini response');
  }
  return {
    buffer: Buffer.from(inline.inlineData.data, 'base64'),
    mime: inline.inlineData.mimeType || 'image/png',
  };
}

/**
 * Turn one row of copy into one image.
 * Falls back to the cheaper image model if the primary one is unavailable,
 * and to a generated placeholder in dry-run.
 */
export async function generateImage(imagePrompt, outPath, { styleKey } = {}) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });

  if (config.dryRun) {
    fs.writeFileSync(outPath, placeholderPNG(imagePrompt));
    return { path: outPath, placeholder: true };
  }

  // Another service can draw instead. Imported lazily so a machine configured
  // for Gemini never loads it, and the style prompt is built the same way
  // either way - art direction belongs to us, not to the generator.
  if (config.design.imageProvider === 'higgsfield') {
    const { generateImage: higgsfield } = await import('./images/higgsfield.js');
    return higgsfield(buildPrompt(imagePrompt, styleKey), outPath);
  }

  const apiKey = config.design.geminiApiKey;
  if (!apiKey) throw new Error('GEMINI_API_KEY is required to generate visuals (or use --dry-run)');
  const prompt = buildPrompt(imagePrompt, styleKey);

  let result;
  try {
    // One retry, not four: a quota 429 on the primary is not going to clear in
    // 30s of backoff, and paying that ladder per image costs more than the
    // fallback it is delaying.
    result = await callGemini(config.design.imageModel, prompt, apiKey, { retries: 1 });
  } catch (err) {
    log.warn(`${config.design.imageModel} failed, trying ${config.design.imageFallbackModel}`, err.message);
    result = await callGemini(config.design.imageFallbackModel, prompt, apiKey);
  }
  fs.writeFileSync(outPath, result.buffer);
  return { path: outPath, placeholder: false };
}

// --- placeholder image ------------------------------------------------------

function crc32(buf) {
  let c;
  const table = crc32.table || (crc32.table = Array.from({ length: 256 }, (_, n) => {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  }));
  let crc = 0xffffffff;
  for (const byte of buf) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/**
 * A real 9:16 PNG, written without any image library, so a dry run produces
 * files the video stage can actually encode. Colour is derived from the prompt
 * so a storyboard is visually distinguishable.
 */
export function placeholderPNG(seedText, width = 540, height = 960) {
  let h = 0;
  for (const ch of String(seedText)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const hue = h % 360;

  const raw = Buffer.alloc((width * 3 + 1) * height);
  let o = 0;
  for (let y = 0; y < height; y++) {
    raw[o++] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const t = (y / height) * 0.55 + (x / width) * 0.15;
      const [r, g, b] = hsl(hue, 0.35, 0.22 + t * 0.45);
      raw[o++] = r; raw[o++] = g; raw[o++] = b;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 2;  // truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function hsl(hDeg, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = (hDeg % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  const [r, g, b] =
    hp < 1 ? [c, x, 0] : hp < 2 ? [x, c, 0] : hp < 3 ? [0, c, x] :
    hp < 4 ? [0, x, c] : hp < 5 ? [x, 0, c] : [c, 0, x];
  const m = l - c / 2;
  return [r, g, b].map((v) => Math.round(Math.max(0, Math.min(1, v + m)) * 255));
}

export default generateImage;
