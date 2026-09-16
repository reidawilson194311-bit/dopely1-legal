import fs from 'node:fs';
import { request } from '../http.js';
import { config } from '../../config.js';
import { logger } from '../log.js';

const log = logger('unipile');

function base() {
  const { dsn, apiKey } = config.post.unipile;
  if (!dsn || !apiKey) throw new Error('UNIPILE_DSN and UNIPILE_API_KEY are required');
  return { url: `https://${dsn.replace(/^https?:\/\//, '').replace(/\/$/, '')}/api/v1`, apiKey };
}

function accountId(platform) {
  const id = config.post.unipile.accounts[platform];
  if (!id) throw new Error(`UNIPILE_ACCOUNT_${platform.toUpperCase()} is not set`);
  return id;
}

/**
 * Unipile publishes immediately - it has no scheduling of its own. A post
 * dated in the future is therefore handed back unpublished, to be held in the
 * posts table and released by `drain()` once its slot comes due. Anything due
 * now goes straight out.
 */
export async function schedule({ platform, videoPath, caption, publishAt, youtubeTitle }) {
  const { url, apiKey } = base();
  if (publishAt.getTime() > Date.now() + 60000) {
    return { externalId: null, queuedLocally: true };
  }

  const form = new FormData();
  form.append('account_id', accountId(platform));
  form.append('text', caption);
  if (platform === 'youtube' && youtubeTitle) form.append('title', youtubeTitle);
  form.append(
    'attachments',
    new Blob([fs.readFileSync(videoPath)], { type: 'video/mp4' }),
    videoPath.split('/').pop(),
  );

  const res = await request(`${url}/posts`, {
    method: 'POST',
    headers: { 'X-API-KEY': apiKey, accept: 'application/json' },
    body: form,
    timeoutMs: 300000,
  });
  const id = res?.post_id || res?.id || null;
  log.debug(`published ${platform}`, { id });
  return { externalId: id, raw: res, queuedLocally: false, publishedNow: true };
}

export default { schedule, name: 'unipile' };
