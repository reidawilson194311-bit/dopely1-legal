#!/usr/bin/env node
/**
 * Ask Higgsfield what its API actually looks like, before a render depends on it.
 *
 * The SDK documents the pieces - key-pair auth, an async submit, a status poll -
 * but not the exact submit path, and guessing one costs a whole batch to find
 * out. This submits the smallest real generation and prints every shape it sees
 * on the way: the status field, the job layout, where the asset url lives.
 *
 *   node scripts/probe-higgsfield.js            # submit and follow one job
 *   node scripts/probe-higgsfield.js --paths    # only test which paths exist
 */
import { config } from '../src/config.js';
import { request, sleep, HttpError } from '../src/lib/http.js';
import { firstAssetUrl } from '../src/lib/images/higgsfield.js';

const c = { ok: '\x1b[32m', warn: '\x1b[33m', err: '\x1b[31m', dim: '\x1b[90m', off: '\x1b[0m' };
const { baseUrl, keyId, keySecret, imageModel, aspectRatio } = config.design.higgsfield;

if (!keyId || !keySecret) {
  console.error('HIGGSFIELD_KEY_ID and HIGGSFIELD_KEY_SECRET are required');
  process.exit(1);
}

const headers = {
  authorization: `Key ${keyId}:${keySecret}`,
  'content-type': 'application/json',
  accept: 'application/json',
};

const PROMPT =
  'A quiet empty newsroom desk at dawn, vertical 9:16, soft window light, ' +
  'photographic realism. No text, no logos, no recognisable people.';

async function tryPost(path, body) {
  try {
    const res = await request(`${baseUrl}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      timeoutMs: 60000,
      retries: 0,
    });
    return { path, ok: true, res };
  } catch (err) {
    return { path, ok: false, status: err instanceof HttpError ? err.status : null, message: err.message };
  }
}

const CANDIDATES = [
  `/v1/${imageModel}`,
  `/${imageModel}`,
  `/v1/generate/${imageModel}`,
  '/v1/requests',
];

const body = { input: { prompt: PROMPT, aspect_ratio: aspectRatio } };

console.log(`\n  base   ${baseUrl}`);
console.log(`  model  ${imageModel}`);
console.log(`  auth   Key <id>:<secret>  (id ends ...${keyId.slice(-4)})\n`);

let accepted = null;
for (const path of CANDIDATES) {
  const r = await tryPost(path, path === '/v1/requests' ? { ...body, model: imageModel } : body);
  if (r.ok) {
    console.log(`  ${c.ok}accepted${c.off} POST ${path}`);
    console.log(`  ${c.dim}${JSON.stringify(r.res).slice(0, 300)}${c.off}`);
    accepted = r;
    break;
  }
  console.log(`  ${c.warn}${String(r.status ?? '---').padEnd(4)}${c.off} POST ${path}  ${c.dim}${r.message.slice(0, 120)}${c.off}`);
}

if (!accepted) {
  console.log(`\n  ${c.err}no submit path accepted${c.off} - the paths above are all this probe knows.\n`);
  process.exit(1);
}

if (process.argv.includes('--paths')) process.exit(0);

const id = accepted.res?.id || accepted.res?.request_id || accepted.res?.requestId;
if (!id) {
  console.log(`\n  ${c.err}accepted, but no request id in the response${c.off}\n`);
  process.exit(1);
}

console.log(`\n  polling /v1/requests/${id}/status\n`);
const deadline = Date.now() + 180000;
for (;;) {
  const status = await request(`${baseUrl}/v1/requests/${id}/status`, { headers, timeoutMs: 30000 });
  const state = status?.status || status?.state;
  console.log(`  ${c.dim}${new Date().toISOString().slice(11, 19)}${c.off} ${state}`);
  if (!['queued', 'in_progress'].includes(state)) {
    console.log(`\n  final shape:\n  ${c.dim}${JSON.stringify(status).slice(0, 600)}${c.off}`);
    const url = firstAssetUrl(status);
    console.log(`\n  asset url: ${url ? c.ok + url + c.off : c.err + 'NOT FOUND in that shape' + c.off}\n`);
    break;
  }
  if (Date.now() > deadline) {
    console.log(`\n  ${c.err}still ${state} after 180s${c.off}\n`);
    break;
  }
  await sleep(4000);
}
