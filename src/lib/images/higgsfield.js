import fs from 'node:fs';
import path from 'node:path';
import { request, sleep } from '../http.js';
import { config } from '../../config.js';
import { logger } from '../log.js';

const log = logger('higgsfield');

/**
 * Higgsfield's generation API.
 *
 * Asynchronous by design: a request is submitted, then polled until it
 * finishes, then the finished asset is fetched from the URL it returns. That is
 * three round trips where Gemini takes one, so the caller must not assume an
 * image comes back from the first call.
 *
 * Auth is a key PAIR - `Authorization: Key <id>:<secret>` - not a single
 * bearer token, which is the part most likely to be configured wrongly.
 */
const RUNNING = new Set(['queued', 'in_progress']);

function credentials() {
  const { keyId, keySecret } = config.design.higgsfield;
  if (!keyId || !keySecret) {
    throw new Error(
      'HIGGSFIELD_KEY_ID and HIGGSFIELD_KEY_SECRET are required for IMAGE_PROVIDER=higgsfield',
    );
  }
  return `Key ${keyId}:${keySecret}`;
}

const headers = () => ({
  authorization: credentials(),
  'content-type': 'application/json',
  accept: 'application/json',
});

/** Where a finished job hides its asset, across the shapes seen in the SDK. */
export function firstAssetUrl(status) {
  const jobs = status?.jobs || status?.jobSet?.jobs || [];
  for (const job of jobs) {
    const url = job?.results?.raw?.url || job?.results?.url || job?.result?.url;
    if (url) return url;
  }
  return status?.results?.raw?.url || status?.url || null;
}

/** Submit one generation and return its request id. */
async function submit(prompt, { model, aspectRatio, seed }) {
  const res = await request(`${config.design.higgsfield.baseUrl}/v1/${model}`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({
      input: {
        prompt,
        aspect_ratio: aspectRatio,
        ...(seed === undefined ? {} : { seed }),
      },
    }),
    timeoutMs: 60000,
  });
  const id = res?.id || res?.request_id || res?.requestId;
  if (!id) throw new Error(`Higgsfield did not return a request id: ${JSON.stringify(res).slice(0, 200)}`);
  return id;
}

/** Poll one request until it leaves the running states. */
async function awaitResult(id, { pollMs, timeoutMs }) {
  const deadline = Date.now() + timeoutMs;
  let status = null;
  for (;;) {
    status = await request(`${config.design.higgsfield.baseUrl}/v1/requests/${id}/status`, {
      headers: headers(),
      timeoutMs: 30000,
    });
    const state = status?.status || status?.state;
    if (!RUNNING.has(state)) {
      // `nsfw` is a refusal, not a transport failure, and retrying the same
      // prompt will refuse again - so say which it was.
      if (state === 'nsfw') throw new Error('Higgsfield refused the prompt (nsfw)');
      if (state === 'failed') throw new Error(`Higgsfield job failed: ${status?.error || 'no reason given'}`);
      return status;
    }
    if (Date.now() > deadline) throw new Error(`Higgsfield still ${state} after ${Math.round(timeoutMs / 1000)}s`);
    await sleep(pollMs);
  }
}

/**
 * Generate one image and write it to disk.
 * Same contract as the Gemini path, so the designer does not care which ran.
 */
export async function generateImage(prompt, outPath, { model, seed } = {}) {
  const { imageModel, aspectRatio, pollMs, readyTimeoutMs } = config.design.higgsfield;
  fs.mkdirSync(path.dirname(outPath), { recursive: true });

  const id = await submit(prompt, { model: model || imageModel, aspectRatio, seed });
  log.debug(`request ${id} submitted`);
  const status = await awaitResult(id, { pollMs, timeoutMs: readyTimeoutMs });

  const url = firstAssetUrl(status);
  if (!url) throw new Error('Higgsfield finished without returning an asset url');

  const buf = await request(url, { timeoutMs: 120000 });
  if (!Buffer.isBuffer(buf)) throw new Error('Higgsfield asset did not download as binary');
  fs.writeFileSync(outPath, buf);
  return { path: outPath, placeholder: false };
}

export default generateImage;
