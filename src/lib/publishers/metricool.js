import fs from 'node:fs';
import { request } from '../http.js';
import { config } from '../../config.js';
import { logger } from '../log.js';
import { formatLocal } from '../schedule.js';

const log = logger('metricool');
const API = 'https://app.metricool.com/api/v2';

/** Metricool's provider names for the three networks we publish to. */
const PROVIDER = {
  instagram: 'instagram',
  tiktok: 'tiktok',
  youtube: 'youtube',
};

function creds() {
  const { token, userId, blogId } = config.post.metricool;
  if (!token || !userId || !blogId) {
    throw new Error('METRICOOL_USER_TOKEN, METRICOOL_USER_ID and METRICOOL_BLOG_ID are required');
  }
  return { token, userId, blogId };
}

const qs = ({ token, userId, blogId }) =>
  new URLSearchParams({ userToken: token, userId, blogId }).toString();

/**
 * Upload the rendered MP4 to Metricool's media store and return the URL the
 * scheduler expects. Metricool will not fetch from a local path.
 */
export async function uploadMedia(filePath) {
  const c = creds();
  const form = new FormData();
  form.append(
    'file',
    new Blob([fs.readFileSync(filePath)], { type: 'video/mp4' }),
    filePath.split('/').pop(),
  );
  const res = await request(`${API}/media?${qs(c)}`, {
    method: 'POST',
    headers: { 'X-Mc-Auth': c.token },
    body: form,
    timeoutMs: 300000,
  });
  const url = res?.data?.url || res?.url;
  if (!url) throw new Error(`Metricool upload returned no URL: ${JSON.stringify(res).slice(0, 200)}`);
  return url;
}

export async function schedule({ platform, videoUrl, caption, publishAt, youtubeTitle }) {
  const c = creds();
  const body = {
    providers: [{ network: PROVIDER[platform] }],
    // Metricool interprets publicationDate in the brand's own timezone.
    publicationDate: { dateTime: formatLocal(publishAt), timezone: config.post.timezone },
    text: caption,
    media: [videoUrl],
    autoPublish: true,
    draft: false,
  };
  if (platform === 'youtube') {
    body.youtubeData = { title: youtubeTitle, type: 'SHORT', privacy: 'PUBLIC', madeForKids: false };
  }
  if (platform === 'instagram') body.instagramData = { type: 'REEL', showReelOnFeed: true };
  if (platform === 'tiktok') {
    body.tiktokData = { privacyLevel: 'PUBLIC_TO_EVERYONE', disableComment: false, disableDuet: false };
  }

  const res = await request(`${API}/scheduler/posts?${qs(c)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Mc-Auth': c.token },
    body: JSON.stringify(body),
    timeoutMs: 120000,
  });
  const id = res?.data?.id || res?.id || null;
  log.debug(`scheduled ${platform}`, { id, at: publishAt.toISOString() });
  return { externalId: id, raw: res };
}

export default { uploadMedia, schedule, name: 'metricool' };
