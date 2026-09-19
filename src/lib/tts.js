import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { request } from './http.js';
import { config } from '../config.js';
import { logger } from './log.js';

const log = logger('tts');

/** Words per second for a confident short-form read. Used when there is no audio. */
export const SPEAKING_RATE = 2.7;

export function estimateDuration(text) {
  const words = (String(text || '').match(/\S+/g) || []).length;
  return Math.max(2.2, Number((words / SPEAKING_RATE + 0.5).toFixed(2)));
}

async function elevenlabs(text, outPath) {
  const { ttsApiKey, ttsVoiceId } = config.design;
  if (!ttsApiKey) throw new Error('TTS_API_KEY is required for TTS_PROVIDER=elevenlabs');
  if (!ttsVoiceId) throw new Error('TTS_VOICE_ID is required for TTS_PROVIDER=elevenlabs');
  const buf = await request(
    `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(ttsVoiceId)}`,
    {
      method: 'POST',
      headers: { 'xi-api-key': ttsApiKey, 'content-type': 'application/json', accept: 'audio/mpeg' },
      body: JSON.stringify({
        text,
        model_id: 'eleven_multilingual_v2',
        voice_settings: { stability: 0.4, similarity_boost: 0.75, style: 0.35 },
      }),
      timeoutMs: 120000,
    },
  );
  fs.writeFileSync(outPath, buf);
}

const GEMINI = 'https://generativelanguage.googleapis.com/v1beta/models';

/**
 * A RIFF/WAVE header for raw little-endian PCM.
 *
 * Gemini hands back headerless PCM, which ffmpeg and ffprobe cannot open
 * without being told the rate and width out of band. Wrapping the samples
 * keeps that knowledge here instead of leaking it into the video stage.
 */
export function wavHeader({ dataLength, sampleRate, channels = 1, bitsPerSample = 16 }) {
  const blockAlign = (channels * bitsPerSample) / 8;
  const b = Buffer.alloc(44);
  b.write('RIFF', 0);
  b.writeUInt32LE(36 + dataLength, 4);
  b.write('WAVE', 8);
  b.write('fmt ', 12);
  b.writeUInt32LE(16, 16); // PCM subchunk size
  b.writeUInt16LE(1, 20); // format 1 = PCM
  b.writeUInt16LE(channels, 22);
  b.writeUInt32LE(sampleRate, 24);
  b.writeUInt32LE(sampleRate * blockAlign, 28); // byte rate
  b.writeUInt16LE(blockAlign, 32);
  b.writeUInt16LE(bitsPerSample, 34);
  b.write('data', 36);
  b.writeUInt32LE(dataLength, 40);
  return b;
}

/** `audio/L16;codec=pcm;rate=24000` -> 24000. */
export function pcmRate(mimeType) {
  const m = /rate=(\d+)/.exec(String(mimeType || ''));
  return m ? Number(m[1]) : 24000;
}

/**
 * Google's TTS models, on the key that already writes the copy and draws the
 * pictures. One account, one bill, one thing to rotate.
 */
async function gemini(text, outPath) {
  const apiKey = config.design.ttsApiKey || config.design.geminiApiKey;
  if (!apiKey) throw new Error('GEMINI_API_KEY (or TTS_API_KEY) is required for TTS_PROVIDER=gemini');
  const res = await request(
    `${GEMINI}/${config.design.ttsModel}:generateContent?key=${encodeURIComponent(apiKey)}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text }] }],
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName: config.design.ttsVoiceId || 'Kore' },
            },
          },
        },
      }),
      timeoutMs: 120000,
    },
  );
  const part = (res?.candidates?.[0]?.content?.parts || []).find((p) => p.inlineData?.data);
  if (!part) {
    const blocked = res?.promptFeedback?.blockReason;
    throw new Error(blocked ? `narration blocked: ${blocked}` : 'no audio in Gemini response');
  }
  const pcm = Buffer.from(part.inlineData.data, 'base64');
  const wavPath = outPath.replace(/\.[^.]+$/, '') + '.wav';
  fs.writeFileSync(
    wavPath,
    Buffer.concat([
      wavHeader({ dataLength: pcm.length, sampleRate: pcmRate(part.inlineData.mimeType) }),
      pcm,
    ]),
  );
  return wavPath;
}

/** Any service exposing OpenAI's /audio/speech shape. */
async function openaiCompatible(text, outPath) {
  const { ttsApiKey, ttsBaseUrl, ttsVoiceId } = config.design;
  if (!ttsBaseUrl) throw new Error('TTS_BASE_URL is required for TTS_PROVIDER=openai-compatible');
  const buf = await request(`${ttsBaseUrl.replace(/\/$/, '')}/audio/speech`, {
    method: 'POST',
    headers: { authorization: `Bearer ${ttsApiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'tts-1',
      voice: ttsVoiceId || 'alloy',
      input: text,
      response_format: 'mp3',
    }),
    timeoutMs: 120000,
  });
  fs.writeFileSync(outPath, buf);
  return outPath;
}

/**
 * Narrate one beat. Returns null when voiceover is switched off, in which case
 * the video stage falls back to estimated beat durations and text-only shorts.
 */
export async function speak(text, outPath) {
  const provider = config.design.ttsProvider;
  if (provider === 'none' || config.dryRun) return null;
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  try {
    // Providers return the path they actually wrote: Gemini emits WAV, not the
    // mp3 the caller asked for, and the video stage needs the real file.
    if (provider === 'gemini') return await gemini(text, outPath);
    if (provider === 'elevenlabs') return await elevenlabs(text, outPath);
    if (provider === 'openai-compatible') return await openaiCompatible(text, outPath);
    throw new Error(`unknown TTS_PROVIDER: ${provider}`);
  } catch (err) {
    // A missing voiceover costs us polish; a crash costs us the whole batch.
    log.warn('voiceover failed, falling back to silent timing', err.message);
    return null;
  }
}

export default speak;

/**
 * A plain sentence, not a word like "ok".
 *
 * Gemini's TTS models refuse anything that reads as an instruction or a
 * question - "Model tried to generate text, but it should only be used for
 * TTS" - so a one-word probe fails while real narration works, and the check
 * reports a fault that is not there. It must look like a transcript, because
 * that is what the model is for.
 */
const PING_TEXT = 'This is a short test of the narration voice.';

/**
 * Prove the voice actually speaks, using the real request shape.
 *
 * A TTS model rejects a plain text-generation call - it needs
 * responseModalities AUDIO - so checking it with the same ping used for the
 * copy and image models reports a failure that is not there. This runs the
 * provider itself and throws rather than falling back, which is the opposite
 * of what speak() wants at render time.
 */
export async function ping() {
  const provider = config.design.ttsProvider;
  if (provider === 'none') throw new Error('TTS_PROVIDER is none');
  const outPath = path.join(os.tmpdir(), `machine-tts-ping-${Date.now()}.mp3`);
  try {
    const written =
      provider === 'gemini' ? await gemini(PING_TEXT, outPath)
      : provider === 'elevenlabs' ? await elevenlabs(PING_TEXT, outPath)
      : provider === 'openai-compatible' ? await openaiCompatible(PING_TEXT, outPath)
      : (() => { throw new Error(`unknown TTS_PROVIDER: ${provider}`); })();
    const { size } = fs.statSync(written);
    if (!size) throw new Error('the provider returned an empty file');
    return { path: written, bytes: size };
  } finally {
    for (const f of [outPath, outPath.replace(/\.[^.]+$/, '') + '.wav']) {
      try { fs.unlinkSync(f); } catch { /* never written */ }
    }
  }
}
