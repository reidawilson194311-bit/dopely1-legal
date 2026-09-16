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
 * Unipile publishes immediately, so scheduled-for-later posts are held locally
 * and released by the machine's own scheduler. `publishAt` in the future
 * therefore returns a queued record rather than a live post.
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
  return { externalId: id, raw: res, queuedLocally: false };
}

export default { schedule, name: 'unipile' };
