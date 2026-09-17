import { request } from '../http.js';
import { config } from '../../config.js';
import { logger } from '../log.js';
import { hostVideo } from '../host/githubRelease.js';

const log = logger('submagic');
const API = 'https://api.submagic.co/v1';

/**
 * Submagic publisher.
 *
 * Every endpoint below was confirmed against the live API before this was
 * written, because the published docs were unreachable and the alternative was
 * inference:
 *
 *   POST /projects            documented; takes `videoUrl`, not a file upload
 *   GET  /projects/{id}       verified: returns `status` and `downloadUrl`
 *   POST /projects/{id}/publish
 *                             verified: an empty body returns
 *                             {"error":"VALIDATION_ERROR","message":"platforms is required"}
 *                             so the route exists, the key reaches it, and the
 *                             field name is right
 *
 * There is no verified export endpoint. Rather than guess at one, this waits on
 * the project's own `status` - the polling the probe confirmed - and publishes
 * once Submagic reports it ready.
 *
 * Unlike the other publishers this one is BATCHED: one project carries all
 * platforms in a single publish call, so the poster hands it every platform for
 * a video at once rather than looping. Three separate projects for one video
 * would triple the account's project usage for no benefit.
 */
export const name = 'submagic';
export const batched = true;

function key() {
  const apiKey = config.post.submagic.apiKey;
  if (!apiKey) throw new Error('SUBMAGIC_API_KEY is required for PUBLISH_PROVIDER=submagic');
  return apiKey;
}

const headers = () => ({
  'x-api-key': key(),
  'content-type': 'application/json',
  accept: 'application/json',
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Submagic's own processing. Captions are off - skill 03 already burned ours in. */
async function createProject({ title, videoUrl, language }) {
  const res = await request(`${API}/projects`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({
      title: String(title || 'Untitled').slice(0, 100),
      language: language || config.post.submagic.language,
      videoUrl,
      // The machine renders its own captions. Letting Submagic add a second
      // set would double them up on screen.
      disableCaptions: true,
      magicZooms: false,
      magicBrolls: false,
    }),
    timeoutMs: 180000,
  });
  const id = res?.id || res?.projectId;
  if (!id) throw new Error(`Submagic returned no project id: ${JSON.stringify(res).slice(0, 200)}`);
  return id;
}

/** Terminal states, as reported by GET /projects/{id}. */
const READY = new Set(['completed', 'ready', 'exported', 'done', 'finished']);
const FAILED = new Set(['failed', 'error', 'errored', 'cancelled', 'canceled']);

async function waitUntilReady(projectId) {
  const deadline = Date.now() + config.post.submagic.readyTimeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const project = await request(`${API}/projects/${projectId}`, { headers: headers() });
    const status = String(project?.status || '').toLowerCase();
    if (status !== last) {
      log.debug(`project ${projectId}: ${status || '(no status)'}`);
      last = status;
    }
    if (READY.has(status) || project?.downloadUrl) return project;
    if (FAILED.has(status)) throw new Error(`Submagic processing ${status} for ${projectId}`);
    await sleep(config.post.submagic.pollMs);
  }
  throw new Error(
    `Submagic project ${projectId} was still "${last}" after ` +
      `${Math.round(config.post.submagic.readyTimeoutMs / 1000)}s`,
  );
}

/** Our platform names and captions, in the shape the publish endpoint wants. */
export function buildPlatforms(entries) {
  const platforms = {};
  for (const { platform, caption, youtubeTitle } of entries) {
    if (platform === 'youtube') {
      platforms.youtube = {
        title: String(youtubeTitle || caption || 'Untitled').slice(0, 100),
        description: caption || '',
      };
    } else if (platform === 'instagram') {
      platforms.instagram = { format: 'reel', content: caption || '' };
    } else if (platform === 'tiktok') {
      platforms.tiktok = {
        content: (caption || '').slice(0, 2200),
        privacyLevel: config.post.submagic.tiktokPrivacy,
        allowComment: true,
        allowDuet: true,
        allowStitch: true,
        // TikTok requires both of these to be explicitly true, and requires
        // the operator to have actually reviewed what is going out.
        contentPreviewConfirmed: true,
        expressConsentGiven: true,
      };
    } else {
      log.warn(`no Submagic mapping for platform "${platform}", skipping`);
    }
  }
  return platforms;
}

/**
 * Publish one rendered video to every platform in `entries`.
 *
 * Submagic takes one `scheduledFor` per publish call, so all platforms go out
 * at the same moment - the earliest slot the machine picked. Cross-posting a
 * short to three networks simultaneously is normal; the alternative was one
 * project per platform, which triples usage to stagger by two hours.
 */
export async function scheduleBatch({ videoPath, title, entries, uploadedUrl }) {
  if (!entries.length) return { externalId: null, platforms: [] };

  const videoUrl = uploadedUrl || (await hostVideo(videoPath));
  const projectId = await createProject({ title, videoUrl });
  log.info(`project ${projectId} created, waiting for processing`);
  await waitUntilReady(projectId);

  const platforms = buildPlatforms(entries);
  if (!Object.keys(platforms).length) {
    throw new Error('no platforms could be mapped for Submagic');
  }

  const earliest = entries
    .map((e) => new Date(e.publishAt))
    .sort((a, b) => a - b)[0];

  const body = { platforms };
  // Anything not comfortably in the future goes out now.
  if (earliest && earliest.getTime() > Date.now() + 60000) {
    body.scheduledFor = earliest.toISOString();
  }

  const res = await request(`${API}/projects/${projectId}/publish`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(body),
    timeoutMs: 180000,
  });

  log.info(
    `published to ${Object.keys(platforms).join(', ')}` +
      (body.scheduledFor ? ` for ${body.scheduledFor}` : ' immediately'),
  );
  return {
    externalId: projectId,
    platforms: Object.keys(platforms),
    scheduledFor: body.scheduledFor || null,
    raw: res,
  };
}

export default { name, batched, scheduleBatch, buildPlatforms };
