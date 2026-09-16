import { request } from './http.js';
import { logger } from './log.js';
import { config } from '../config.js';

const log = logger('apify');
const API = 'https://api.apify.com/v2';

/**
 * Run an Apify actor and return its dataset items.
 * `run-sync-get-dataset-items` blocks until the run finishes, which is what we
 * want - the researcher is a batch job, not a request handler.
 */
export async function runActor(actorId, input, { timeoutSecs = 600 } = {}) {
  const token = config.research.apifyToken;
  if (!token) throw new Error('APIFY_TOKEN is required to scrape (or run with --dry-run)');
  const url =
    `${API}/acts/${encodeURIComponent(actorId)}/run-sync-get-dataset-items` +
    `?token=${encodeURIComponent(token)}&timeout=${timeoutSecs}&format=json&clean=true`;
  log.debug(`run ${actorId}`, { keys: Object.keys(input) });
  const items = await request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
    timeoutMs: (timeoutSecs + 30) * 1000,
  });
  return Array.isArray(items) ? items : [];
}

/** Actor inputs, one per platform. Kept together so they are easy to re-tune. */
export const actorInput = {
  instagram: (handles, limit) => ({
    directUrls: handles.map((h) => `https://www.instagram.com/${h.replace(/^@/, '')}/`),
    resultsType: 'posts',
    resultsLimit: limit,
    searchType: 'user',
    addParentData: false,
  }),
  tiktok: (handles, limit) => ({
    profiles: handles.map((h) => h.replace(/^@/, '')),
    resultsPerPage: limit,
    shouldDownloadVideos: false,
    shouldDownloadCovers: true,
    proxyCountryCode: 'None',
  }),
  youtube: (handles, limit) => ({
    startUrls: handles.map((h) => ({
      url: `https://www.youtube.com/${h.startsWith('@') ? h : `@${h}`}/shorts`,
    })),
    maxResults: limit,
    maxResultsShorts: limit,
    sortVideosBy: 'POPULAR',
    downloadSubtitles: false,
  }),
};
