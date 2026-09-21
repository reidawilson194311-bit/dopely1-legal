import { request } from '../http.js';
import { config } from '../../config.js';
import { logger } from '../log.js';
import SCHEMA, { diffTable } from '../../../scripts/airtable-schema.js';

const log = logger('schema');

/**
 * Refuse to start a run whose writes the base cannot accept.
 *
 * Airtable rejects an ENTIRE row for one unknown column. A field added to a
 * row shape but not to the base therefore fails at the upsert - which is after
 * the images, the narration and the encode have all been paid for, and after
 * the scripts have been marked consumed. Three separate batches were lost that
 * way before this existed.
 *
 * `doctor` already reports this, but only when somebody remembers to run it.
 * This is the same check placed where it cannot be skipped.
 */
export async function assertSchema({ fatal = true } = {}) {
  const { driver, airtable } = config.store;
  if (driver !== 'airtable' || !airtable.apiKey || !airtable.baseId) return { checked: false };

  let live;
  try {
    const res = await request(
      `https://api.airtable.com/v0/meta/bases/${airtable.baseId}/tables`,
      { headers: { authorization: `Bearer ${airtable.apiKey}` }, timeoutMs: 30000, retries: 1 },
    );
    live = new Map((res?.tables || []).map((t) => [t.name.toLowerCase(), t]));
  } catch (err) {
    // Being unable to READ the schema is not the same as the schema being
    // wrong, and must not take down a run that would otherwise work.
    log.warn('could not read the base schema, continuing', err.message);
    return { checked: false };
  }

  const missing = SCHEMA.flatMap((spec) =>
    diffTable(spec, live.get(spec.name.toLowerCase())).missing.map((f) => `${spec.name}.${f.name}`),
  );
  if (!missing.length) return { checked: true, missing: [] };

  const message =
    `Airtable is missing ${missing.length} field(s) the code writes: ${missing.join(', ')}. ` +
    'Run the workflow with setup_airtable to add them. Starting now would fail at the ' +
    'first upsert, after the generation has been paid for.';
  if (fatal) throw new Error(message);
  log.warn(message);
  return { checked: true, missing };
}

export default assertSchema;
