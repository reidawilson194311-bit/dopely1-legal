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

let res;
try {
  res = await higgsfield.subscribe(ENDPOINT, { input: INPUT, withPolling: true });
} catch (err) {
  fail(`the request never completed: ${err instanceof Error ? err.message : String(err)}`);
}

console.log(`  request_id ${res.request_id}`);
console.log(`  status     ${res.status}`);

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
