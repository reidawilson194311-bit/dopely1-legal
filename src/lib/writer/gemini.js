import { request } from '../http.js';
import { config } from '../../config.js';
import { logger } from '../log.js';
import { toGeminiSchema, parseJSON, DeclinedError } from './schema.js';

const log = logger('writer:gemini');
const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';

// gemini-2.5-flash 404s for keys created after its retirement, and says so:
// "no longer available to new users ... use models/gemini-3.6-flash". Taking
// the API at its word rather than pinning something else that will age out.
export const DEFAULT_MODEL = 'gemini-3.6-flash';

/**
 * The same key already generates the visuals in skill 03, so choosing Gemini
 * here means the machine needs one fewer account, not one more.
 */
export async function generateJSON({ system, prompt, schema, model, maxTokens }) {
  const apiKey = config.design.geminiApiKey;
  if (!apiKey) throw new Error('GEMINI_API_KEY is required for COPY_PROVIDER=gemini');

  const res = await request(
    `${ENDPOINT}/${model || DEFAULT_MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: toGeminiSchema(schema),
          maxOutputTokens: maxTokens,
          temperature: 1,
        },
      }),
      timeoutMs: 180000,
    },
  );

  const blocked = res?.promptFeedback?.blockReason;
  if (blocked) throw new DeclinedError('Gemini', blocked);

  const candidate = res?.candidates?.[0];
  const finish = candidate?.finishReason;
  if (finish === 'SAFETY' || finish === 'PROHIBITED_CONTENT' || finish === 'BLOCKLIST') {
    throw new DeclinedError('Gemini', finish);
  }
  if (finish === 'MAX_TOKENS') {
    throw new Error(`Gemini hit the output cap (${maxTokens}) - raise COPY_MAX_TOKENS`);
  }

  const text = (candidate?.content?.parts || []).map((p) => p.text || '').join('');
  log.debug('usage', {
    in: res?.usageMetadata?.promptTokenCount,
    out: res?.usageMetadata?.candidatesTokenCount,
  });
  return parseJSON(text, 'Gemini');
}

/**
 * Which models this key can actually reach.
 *
 * A model name the key cannot see comes back as a flat 404 from
 * :generateContent, indistinguishable from a dead endpoint until you look at
 * the catalogue. The doctor calls this so a bad model name is caught in
 * seconds, rather than after a twenty-minute scrape has already run.
 */
export async function listModels() {
  const apiKey = config.design.geminiApiKey;
  if (!apiKey) throw new Error('GEMINI_API_KEY is not set');
  const res = await request(`${ENDPOINT}?key=${encodeURIComponent(apiKey)}&pageSize=200`, {
    timeoutMs: 30000,
  });
  return (res?.models || []).map((m) => ({
    name: String(m.name || '').replace(/^models\//, ''),
    methods: m.supportedGenerationMethods || [],
  }));
}

/**
 * Actually call the model, with the smallest request that still proves it.
 *
 * The catalogue lists gemini-2.5-flash and :generateContent still 404s, so
 * name-checking is not the same question. This asks the question that failed.
 */
export async function ping(model) {
  const apiKey = config.design.geminiApiKey;
  if (!apiKey) throw new Error('GEMINI_API_KEY is not set');
  const res = await request(
    `${ENDPOINT}/${model}:generateContent?key=${encodeURIComponent(apiKey)}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: 'Reply with the single word: ok' }] }],
        generationConfig: { maxOutputTokens: 512 },
      }),
      timeoutMs: 60000,
      retries: 0,
    },
  );
  return (res?.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('').trim();
}
