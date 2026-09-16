import { config } from '../config.js';
import { logger } from './log.js';

const log = logger('claude');
let client;

async function getClient() {
  // Imported lazily so `--dry-run` works in a checkout with no node_modules.
  // Zero-arg constructor: resolves ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN or
  // an `ant auth login` profile, in that order.
  if (!client) {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    client = new Anthropic();
  }
  return client;
}

export class RefusalError extends Error {
  constructor(details) {
    super(`Claude declined this request${details?.category ? ` (${details.category})` : ''}`);
    this.name = 'RefusalError';
    this.details = details;
  }
}

const isFallbackUnsupported = (err) =>
  err?.status === 400 && /fallback|beta/i.test(err?.message || '');

/**
 * One structured-output call. Returns the parsed object matching `schema`.
 *
 * Server-side fallbacks are on by default: if a safety classifier declines the
 * request, the API routes it to another model rather than handing us a refusal
 * mid-batch. SDKs that predate the parameter get a transparent retry without.
 */
export async function generateJSON({
  system,
  prompt,
  schema,
  model = config.copy.model,
  effort = config.copy.effort,
  maxTokens = config.copy.maxTokens,
}) {
  const base = {
    model,
    max_tokens: maxTokens,
    output_config: { effort, format: { type: 'json_schema', schema } },
    system,
    messages: [{ role: 'user', content: prompt }],
  };

  let response;
  try {
    response = await (await getClient()).beta.messages.create({
      ...base,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
    });
  } catch (err) {
    if (!isFallbackUnsupported(err)) throw err;
    log.debug('server-side fallbacks unsupported on this SDK/endpoint, retrying without');
    response = await (await getClient()).messages.create(base);
  }

  if (response.stop_reason === 'refusal') throw new RefusalError(response.stop_details);
  if (response.stop_reason === 'max_tokens') {
    throw new Error(`Response hit max_tokens (${maxTokens}) - raise ANTHROPIC_MAX_TOKENS`);
  }

  const text = response.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');
  if (!text.trim()) throw new Error('Claude returned no text content');

  log.debug('usage', {
    in: response.usage?.input_tokens,
    out: response.usage?.output_tokens,
    cached: response.usage?.cache_read_input_tokens,
  });

  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Claude returned unparseable JSON: ${text.slice(0, 300)}`);
  }
}

export default generateJSON;
