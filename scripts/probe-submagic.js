#!/usr/bin/env node
/**
 * Find out what Submagic's REST API actually exposes, before building against it.
 *
 * The docs are unreachable from where this was written, so the alternative was
 * to infer endpoint paths from the shape of their MCP tools and hope. This
 * asks the API instead.
 *
 * READ ONLY. It issues GET requests and nothing else - no project is created,
 * exported, published or modified. A path that needs POST answers 405, and
 * that answer is exactly what we are looking for: 405 means the path is real.
 *
 *   404  no such path
 *   405  path exists, needs a different method   <- what we want to find
 *   200  path exists and is readable
 *   401  the key is wrong or not accepted
 *   403  the key is valid but lacks the plan or scope
 */
const BASE = process.env.SUBMAGIC_BASE_URL || 'https://api.submagic.co/v1';
const KEY = process.env.SUBMAGIC_API_KEY;

if (!KEY) {
  console.error('\nSUBMAGIC_API_KEY is not set.\n');
  process.exit(1);
}

const label = (status) => {
  if (status === 200) return 'READABLE  ';
  if (status === 405) return 'EXISTS    ';
  if (status === 404) return 'not found ';
  if (status === 401) return 'UNAUTHORISED';
  if (status === 403) return 'FORBIDDEN ';
  return `${status}       `;
};

async function probe(path) {
  const url = `${BASE}${path}`;
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { 'x-api-key': KEY, accept: 'application/json' },
    });
    const text = await res.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = text.slice(0, 200);
    }
    return { path, status: res.status, body };
  } catch (err) {
    return { path, status: 0, body: `network: ${err.message}` };
  }
}

/** Keys only, two levels deep - enough to learn the shape, short enough to read. */
function shape(value, depth = 0) {
  if (Array.isArray(value)) {
    return value.length ? `[${value.length} x ${shape(value[0], depth + 1)}]` : '[]';
  }
  if (value && typeof value === 'object') {
    const keys = Object.keys(value);
    if (depth >= 2) return `{${keys.length} keys}`;
    return `{ ${keys.slice(0, 14).join(', ')}${keys.length > 14 ? ', ...' : ''} }`;
  }
  return typeof value;
}

async function main() {
  console.log(`\nProbing ${BASE} (read-only)\n`);

  // Confirmed from Submagic's public API page; also proves the key works.
  const first = [
    '/languages',
    '/templates',
    '/projects',
    '/presets',
    '/user-media',
  ];

  const found = [];
  for (const path of first) {
    const r = await probe(path);
    found.push(r);
    console.log(`  ${label(r.status)} GET ${path}`);
    if (r.status === 200) console.log(`             -> ${shape(r.body)}`);
    else if (r.status >= 400 && typeof r.body === 'object') {
      console.log(`             -> ${JSON.stringify(r.body).slice(0, 160)}`);
    }
  }

  // Per-project paths need a real id. Take one from the account rather than
  // hardcoding, so this works for anyone.
  const listing = found.find((r) => r.path === '/projects' && r.status === 200);
  const projectId =
    process.env.SUBMAGIC_PROBE_PROJECT_ID ||
    (Array.isArray(listing?.body) ? listing.body[0]?.id : listing?.body?.data?.[0]?.id);

  if (!projectId) {
    console.log('\n  No project id available, so per-project paths were not probed.');
    console.log('  Set SUBMAGIC_PROBE_PROJECT_ID to check them.\n');
    return;
  }

  console.log(`\nPer-project paths, using project ${projectId}\n`);
  for (const path of [
    `/projects/${projectId}`,
    `/projects/${projectId}/export`,
    `/projects/${projectId}/exports`,
    `/projects/${projectId}/publish`,
    `/projects/${projectId}/publications`,
    `/projects/${projectId}/status`,
  ]) {
    const r = await probe(path);
    const shown = path.replace(projectId, '{id}');
    console.log(`  ${label(r.status)} GET ${shown}`);
    if (r.status === 200) console.log(`             -> ${shape(r.body)}`);
  }

  console.log('\nEXISTS (405) means the path is real and takes POST - that is the one to build on.\n');
}

main().catch((err) => {
  console.error(`\nprobe failed: ${err.message}\n`);
  process.exit(1);
});
