import fs from 'node:fs';
import path from 'node:path';
import { request } from '../http.js';
import { config } from '../../config.js';
import { logger } from '../log.js';

const log = logger('host');
const API = 'https://api.github.com';

/**
 * Give a rendered short a public URL.
 *
 * Submagic's project endpoint takes a `videoUrl`, not a file upload, and our
 * MP4s live on a CI runner that is destroyed minutes later. A GitHub release
 * asset on a public repo is a public, permanent, free URL, and the repo is
 * already in the stack - no S3, no new account, no extra credential beyond the
 * token Actions hands every run.
 *
 * Everything lands on one rolling release rather than one per video, so the
 * releases page stays readable.
 */
function creds() {
  const token = config.host.githubToken;
  const repo = config.host.repo;
  if (!token) {
    throw new Error(
      'GITHUB_TOKEN is required to host videos for Submagic. ' +
        'Actions provides it automatically; set it manually if running elsewhere.',
    );
  }
  if (!repo) throw new Error('GITHUB_REPOSITORY is required (owner/name)');
  return { token, repo };
}

const headers = (token, extra = {}) => ({
  authorization: `Bearer ${token}`,
  accept: 'application/vnd.github+json',
  'x-github-api-version': '2022-11-28',
  'user-agent': 'the-machine',
  ...extra,
});

/** The rolling release everything is attached to, created on first use. */
async function ensureRelease(token, repo, tag) {
  try {
    return await request(`${API}/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`, {
      headers: headers(token),
    });
  } catch (err) {
    if (err.status !== 404) throw err;
  }
  log.info(`creating release ${tag} to host rendered videos`);
  return request(`${API}/repos/${repo}/releases`, {
    method: 'POST',
    headers: headers(token, { 'content-type': 'application/json' }),
    body: JSON.stringify({
      tag_name: tag,
      name: 'Rendered shorts',
      body:
        'Videos the machine rendered, hosted here so publishers that require a ' +
        'public URL can fetch them. Created automatically.',
      prerelease: true,
    }),
  });
}

/**
 * Upload `filePath` and return its public download URL.
 * An asset of the same name is replaced, so a re-render does not accumulate.
 */
export async function hostVideo(filePath, { tag = config.host.releaseTag } = {}) {
  const { token, repo } = creds();
  if (!fs.existsSync(filePath)) throw new Error(`video not found: ${filePath}`);

  const release = await ensureRelease(token, repo, tag);
  // Asset names must be unique within a release and cannot contain slashes.
  const name = `${path.basename(path.dirname(filePath))}-${path.basename(filePath)}`
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .slice(-120);

  const existing = (release.assets || []).find((a) => a.name === name);
  if (existing) {
    log.debug(`replacing existing asset ${name}`);
    await request(`${API}/repos/${repo}/releases/assets/${existing.id}`, {
      method: 'DELETE',
      headers: headers(token),
    });
  }

  const body = fs.readFileSync(filePath);
  const uploadUrl = release.upload_url.replace(/\{\?.*\}$/, '');
  const asset = await request(`${uploadUrl}?name=${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: headers(token, {
      'content-type': 'video/mp4',
      'content-length': String(body.length),
    }),
    body,
    timeoutMs: 300000,
  });

  log.info(`hosted ${name} (${(body.length / 1e6).toFixed(1)}MB)`);
  return asset.browser_download_url;
}

export default hostVideo;
