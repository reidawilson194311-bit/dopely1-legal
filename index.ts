/**
 * Higgsfield / Seedance 2.5 text-to-video, through the official SDK.
 *
 *   node --env-file=.env.local index.ts
 *
 * Node 22 runs TypeScript directly and reads .env files natively, so this
 * needs no compiler and no dotenv - only @higgsfield/client.
 *
 * Credentials live in .env.local as HF_CREDENTIALS=key-id:key-secret, which
 * .gitignore already excludes. The SDK reads that variable itself; this file
 * never reads, prints or logs the value, and only ever reports whether one
 * was present.
 *
 * THIS MAKES A BILLABLE GENERATION REQUEST.
 */
import { higgsfield } from '@higgsfield/client/v2';

const ENDPOINT = 'bytedance/seedance-2.5/text-to-video';

/** Video generation outlives the SDK's own polling window, so we wait here. */
const MAX_WAIT_MS = 15 * 60 * 1000;
const POLL_MS = 5000;
const RUNNING = new Set(['queued', 'in_progress']);

const INPUT = {
  prompt: 'A cinematic scene at sunset',
  duration: 5,
  resolution: '720p',
  aspect_ratio: '16:9',
};

function fail(message: string): never {
  console.error(`\n  FAILED: ${message}\n`);
  process.exit(1);
}

// Presence only. Never the value - not in a log, not in an error, not in a
// stack trace that might be pasted somewhere later.
const creds = process.env.HF_CREDENTIALS;
const pair = process.env.HF_API_KEY && process.env.HF_API_SECRET;
if (!creds && !pair) {
  fail(
    'no credentials. Put HF_CREDENTIALS=key-id:key-secret in .env.local and run ' +
      'with `node --env-file=.env.local index.ts`.',
  );
}
if (creds && creds.includes('REPLACE_WITH_')) {
  // Spending a real request on the template value would fail upstream with a
  // less obvious message, so catch it here.
  fail('.env.local still holds the placeholder. Replace it with a real key pair.');
}

console.log(`\n  endpoint   ${ENDPOINT}`);
console.log(`  input      ${INPUT.duration}s ${INPUT.resolution} ${INPUT.aspect_ratio}`);
console.log(`  prompt     "${INPUT.prompt}"`);
console.log('\n  submitting (billable) and waiting for completion...\n');

// Submit WITHOUT the SDK's polling, then poll here.
//
// subscribe({withPolling: true}) gives up after its own maxPollTime and throws
// - and it throws before returning anything, so the request_id goes with it.
// A video generation that outlives that window is then already paid for and
// unreachable. Capturing the id first means a slow job is always recoverable,
// whatever happens next.
let submitted;
try {
  submitted = await higgsfield.subscribe(ENDPOINT, { input: INPUT, withPolling: false });
} catch (err) {
  fail(`the request was not accepted: ${err instanceof Error ? err.message : String(err)}`);
}

console.log(`  request_id ${submitted.request_id}`);
console.log(`  status_url ${submitted.status_url}`);
console.log(`\n  waiting (up to ${Math.round(MAX_WAIT_MS / 60000)} min)...\n`);

// The SDK builds this header from the same variable; reusing the value here
// keeps polling under our control. It is never printed or logged.
const authValue = process.env.HF_CREDENTIALS
  ? `Key ${process.env.HF_CREDENTIALS}`
  : `Key ${process.env.HF_API_KEY}:${process.env.HF_API_SECRET}`;

let res = submitted;
const deadline = Date.now() + MAX_WAIT_MS;
while (RUNNING.has(String(res.status))) {
  if (Date.now() > deadline) {
    fail(
      `still "${res.status}" after ${Math.round(MAX_WAIT_MS / 60000)} minutes. ` +
        `The generation may still finish - it is request ${submitted.request_id}, ` +
        `readable at ${submitted.status_url}.`,
    );
  }
  await new Promise((r) => setTimeout(r, POLL_MS));
  const r = await fetch(submitted.status_url, { headers: { authorization: authValue } });
  if (!r.ok) fail(`polling ${submitted.status_url} returned ${r.status} ${r.statusText}`);
  res = (await r.json()) as typeof submitted;
  process.stdout.write(`  ${new Date().toISOString().slice(11, 19)}  ${res.status}\n`);
}

console.log(`\n  final      ${res.status}`);

// Anything that is not `completed` is not a success, and each one means
// something different to whoever has to act on it. `canceled` is absent from
// the SDK's V2RequestStatus union but real in its v1 JobStatus enum, so it is
// matched by string rather than trusted to be impossible.
const status = String(res.status);
if (status === 'nsfw') fail('the prompt was moderated (nsfw) - the same prompt will be refused again.');
if (status === 'failed') fail('generation failed upstream. Nothing was produced.');
if (status === 'canceled') fail('the request was canceled before it finished.');
if (status !== 'completed') fail(`unexpected terminal status "${status}" - treating as not successful.`);

// A `completed` job with no asset is still not a video. Say so rather than
// printing "undefined" under a success banner.
const url = res.video?.url ?? res.images?.[0]?.url;
if (!url) fail('status is completed but the response carried no video url.');

console.log(`\n  VIDEO URL  ${url}\n`);
