import { request } from '../http.js';
import { config } from '../../config.js';
import { logger } from '../log.js';
import { toGeminiSchema, parseJSON, DeclinedError } from './schema.js';

const log = logger('writer:gemini');
const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';

export const DEFAULT_MODEL = 'gemini-2.5-flash';

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
  // The doctor prints failures straight into a public job summary, and an
  // HttpError carries the URL - key and all - in its message.
  let res;
  try {
    res = await request(`${ENDPOINT}?key=${encodeURIComponent(apiKey)}&pageSize=200`, {
      timeoutMs: 30000,
    });
  } catch (err) {
    throw new Error(err.message.split(' - https://')[0]);
  }
  return (res?.models || []).map((m) => ({
    name: String(m.name || '').replace(/^models\//, ''),
    methods: m.supportedGenerationMethods || [],
  }));
}
