import { config } from '../../config.js';
import { logger } from '../log.js';
import * as gemini from './gemini.js';
import * as openaiCompatible from './openaiCompatible.js';
import { DeclinedError } from './schema.js';

const log = logger('writer');

/**
 * Skill 02 needs a model that can follow a voice brief and return structured
 * JSON. Several can. Which one is a config choice, not an architectural one,
 * so the whole dependency lives behind this single call.
 *
 * Anthropic is lazy-loaded because it is the only provider needing an SDK -
 * the other two are plain HTTP, so an unused provider costs nothing.
 */
const PROVIDERS = {
  gemini,
  'openai-compatible': openaiCompatible,
  anthropic: null, // resolved on demand
};

async function resolve(name) {
  if (name === 'anthropic') return import('./anthropic.js');
  const provider = PROVIDERS[name];
  if (!provider) {
    throw new Error(
      `unknown COPY_PROVIDER "${name}" - expected one of: ${Object.keys(PROVIDERS).join(', ')}`,
    );
  }
  return provider;
}

export async function generateJSON({ system, prompt, schema }) {
  const name = config.copy.provider;
  const provider = await resolve(name);
  const model = config.copy.model || provider.DEFAULT_MODEL;
  log.debug(`writing with ${name}/${model}`);
  return provider.generateJSON({
    system,
    prompt,
    schema,
    model,
    maxTokens: config.copy.maxTokens,
  });
}

/** The model this run will use, for logs and `doctor`. */
export async function describeWriter() {
  const name = config.copy.provider;
  try {
    const provider = await resolve(name);
    return `${name}/${config.copy.model || provider.DEFAULT_MODEL}`;
  } catch {
    return `${name}/unknown`;
  }
}

export { DeclinedError };
export default generateJSON;
