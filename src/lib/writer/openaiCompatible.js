import { request, HttpError } from '../http.js';
import { config } from '../../config.js';
import { logger } from '../log.js';
import { parseJSON, describeSchema, DeclinedError } from './schema.js';

const log = logger('writer:openai');

export const DEFAULT_MODEL = 'gpt-4o-mini';

/**
 * Speaks the OpenAI chat-completions shape, which by now is a lingua franca:
 * OpenAI, Groq, DeepSeek, Together, OpenRouter, Mistral, Fireworks and a local
 * llama.cpp or Ollama server all answer it. Point OPENAI_BASE_URL wherever you
 * like; only the base URL, key and model name change.
 */
export async function generateJSON({ system, prompt, schema, model, maxTokens }) {
  const { apiKey, baseUrl } = config.copy.openai;
  if (!apiKey) throw new Error('OPENAI_API_KEY is required for COPY_PROVIDER=openai-compatible');

  const url = `${baseUrl.replace(/\/$/, '')}/chat/completions`;
  const base = {
    model: model || DEFAULT_MODEL,
    max_tokens: maxTokens,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: prompt },
    ],
  };

  let res;
  try {
    res = await request(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        ...base,
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'short_form_script', strict: true, schema },
        },
      }),
      timeoutMs: 180000,
    });
  } catch (err) {
    // Plenty of compatible servers implement json_object but not json_schema.
    // Fall back rather than making the user find that out from a 400.
    const unsupported =
      err instanceof HttpError &&
      err.status === 400 &&
      /json_schema|response_format|schema/i.test(String(err.body || ''));
    if (!unsupported) throw err;

    log.debug('json_schema unsupported here, falling back to json_object');
    res = await request(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        ...base,
        messages: [
          { role: 'system', content: `${system}\n\n${describeSchema(schema)}` },
          { role: 'user', content: prompt },
        ],
        response_format: { type: 'json_object' },
      }),
      timeoutMs: 180000,
    });
  }

  const choice = res?.choices?.[0];
  if (choice?.message?.refusal) throw new DeclinedError('The model', choice.message.refusal);
  if (choice?.finish_reason === 'content_filter') throw new DeclinedError('The model', 'content_filter');
  if (choice?.finish_reason === 'length') {
    throw new Error(`Output hit the token cap (${maxTokens}) - raise COPY_MAX_TOKENS`);
  }

  log.debug('usage', {
    in: res?.usage?.prompt_tokens,
    out: res?.usage?.completion_tokens,
  });
  return parseJSON(choice?.message?.content, 'The model');
}
