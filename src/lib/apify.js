import { request, sleep } from './http.js';
import { logger } from './log.js';
import { config } from '../config.js';

const log = logger('apify');
const API = 'https://api.apify.com/v2';
const RUNNING_STATES = new Set(['READY', 'RUNNING']);

/**
 * Run an Apify actor and return its dataset items.
 *
 * Deliberately NOT `run-sync-get-dataset-items`: that endpoint holds the HTTP
 * connection open and Apify cuts it at ~300s with a 408, whatever `timeout` you
 * pass. A slow scrape then looks like a transient failure, so the retry ladder
 * re-runs the whole actor - three 408s cost twenty-one minutes of a run before
 * one finally landed. Starting the run and polling for it has no such ceiling.
 */
export async function runActor(actorId, input, { timeoutSecs = 900, pollMs = 10000 } = {}) {
  const token = config.research.apifyToken;
  if (!token) throw new Error('APIFY_TOKEN is required to scrape (or run with --dry-run)');
  const auth = `token=${encodeURIComponent(token)}`;
  log.debug(`run ${actorId}`, { keys: Object.keys(input) });

  const started = await request(
    `${API}/acts/${encodeURIComponent(actorId)}/runs?${auth}&timeout=${timeoutSecs}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
      timeoutMs: 60000,
    },
  );

  const runId = started?.data?.id;
  if (!runId) throw new Error(`${actorId}: Apify did not return a run id`);

  const deadline = Date.now() + (timeoutSecs + 120) * 1000;
  let run = started.data;
  while (RUNNING_STATES.has(run.status)) {
    if (Date.now() > deadline) {
      throw new Error(`${actorId}: still ${run.status} after ${timeoutSecs}s`);
    }
    await sleep(pollMs);
    const polled = await request(`${API}/actor-runs/${runId}?${auth}`, { timeoutMs: 30000 });
    run = polled?.data || run;
  }

  if (run.status !== 'SUCCEEDED') {
    throw new Error(`${actorId}: run ${runId} finished ${run.status}`);
  }

  const datasetId = run.defaultDatasetId;
  if (!datasetId) return [];
  const items = await request(
    `${API}/datasets/${datasetId}/items?${auth}&format=json&clean=true`,
    { timeoutMs: 120000 },
  );
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
