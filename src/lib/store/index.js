import { config } from '../../config.js';
import { createJsonStore } from './jsonStore.js';
import { createAirtableStore } from './airtable.js';
import { logger } from '../log.js';

const log = logger('store');
let cached;

export function getStore() {
  if (cached) return cached;
  const driver = config.dryRun ? 'json' : config.store.driver;
  cached =
    driver === 'airtable'
      ? createAirtableStore({ ...config.store.airtable })
      : createJsonStore({ dataDir: config.dataDir });
  log.debug(`store driver: ${cached.driver}`);
  return cached;
}

/** Table names used across the four skills. */
export const TABLES = {
  WINNERS: 'winners',
  SCRIPTS: 'scripts',
  RENDERS: 'renders',
  POSTS: 'posts',
};

export default getStore;
