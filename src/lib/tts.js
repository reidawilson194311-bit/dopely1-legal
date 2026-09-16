import fs from 'node:fs';
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
    if (provider === 'elevenlabs') await elevenlabs(text, outPath);
    else if (provider === 'openai-compatible') await openaiCompatible(text, outPath);
    else throw new Error(`unknown TTS_PROVIDER: ${provider}`);
    return outPath;
  } catch (err) {
    // A missing voiceover costs us polish; a crash costs us the whole batch.
    log.warn('voiceover failed, falling back to silent timing', err.message);
    return null;
  }
}

export default speak;
