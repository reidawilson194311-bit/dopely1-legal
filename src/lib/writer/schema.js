/**
 * The same JSON Schema drives three different APIs, and they do not accept the
 * same dialect. Rather than maintain three schemas that can drift apart, we
 * keep one strict schema and translate it per provider.
 */

const GEMINI_ALLOWED = new Set([
  'type', 'format', 'description', 'nullable', 'enum',
  'maxItems', 'minItems', 'properties', 'required', 'items', 'propertyOrdering',
]);

/**
 * Gemini's responseSchema is an OpenAPI 3 subset. Unknown keys - notably
 * `additionalProperties`, which our schema sets everywhere for OpenAI's strict
 * mode - are rejected outright, so they are stripped here.
 */
export function toGeminiSchema(node) {
  if (Array.isArray(node)) return node.map(toGeminiSchema);
  if (!node || typeof node !== 'object') return node;

  const out = {};
  for (const [key, value] of Object.entries(node)) {
    if (!GEMINI_ALLOWED.has(key)) continue;
    if (key === 'properties') {
      out.properties = Object.fromEntries(
        Object.entries(value).map(([k, v]) => [k, toGeminiSchema(v)]),
      );
    } else if (key === 'items') {
      out.items = toGeminiSchema(value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

/** A readable rendering of the schema, for providers with no native mode. */
export function describeSchema(schema) {
  return [
    'Reply with JSON only - no prose, no markdown fence - matching this schema:',
    JSON.stringify(schema, null, 2),
  ].join('\n');
}

/** Models sometimes wrap JSON in a fence despite being told not to. */
export function parseJSON(text, provider) {
  const cleaned = String(text || '')
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  if (!cleaned) throw new Error(`${provider} returned no content`);
  try {
    return JSON.parse(cleaned);
  } catch {
    throw new Error(`${provider} returned unparseable JSON: ${cleaned.slice(0, 300)}`);
  }
}

/** Raised when a provider declines the request on safety grounds. */
export class DeclinedError extends Error {
  constructor(provider, detail) {
    super(`${provider} declined this request${detail ? ` (${detail})` : ''}`);
    this.name = 'DeclinedError';
    this.detail = detail;
  }
}
