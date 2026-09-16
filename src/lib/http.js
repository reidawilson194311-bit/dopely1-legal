import { logger } from './log.js';

const log = logger('http');

export class HttpError extends Error {
  constructor(status, statusText, body, url) {
    super(`${status} ${statusText} - ${url}`);
    this.name = 'HttpError';
    this.status = status;
    this.body = body;
    this.url = url;
  }
}

const RETRYABLE = new Set([408, 409, 425, 429, 500, 502, 503, 504]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * fetch with exponential backoff. Retries transport errors and the status
 * codes above; never retries a 4xx the server means (401/403/404/422).
 */
export async function request(url, { retries = 4, timeoutMs = 120000, ...init } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...init, signal: ac.signal });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        const err = new HttpError(res.status, res.statusText, body, url);
        if (!RETRYABLE.has(res.status) || attempt === retries) throw err;
        lastErr = err;
      } else {
        const type = res.headers.get('content-type') || '';
        if (type.includes('application/json')) return await res.json();
        if (type.startsWith('image/') || type.includes('octet-stream') || type.startsWith('video/')) {
          return Buffer.from(await res.arrayBuffer());
        }
        return await res.text();
      }
    } catch (err) {
      if (err instanceof HttpError && !RETRYABLE.has(err.status)) throw err;
      if (attempt === retries) throw err;
      lastErr = err;
    } finally {
      clearTimeout(timer);
    }
    const wait = 2000 * 2 ** attempt;
    log.warn(`retry ${attempt + 1}/${retries} in ${wait}ms`, lastErr?.message);
    await sleep(wait);
  }
  throw lastErr;
}

export const getJSON = (url, opts = {}) =>
  request(url, { ...opts, headers: { accept: 'application/json', ...(opts.headers || {}) } });

export const postJSON = (url, body, opts = {}) =>
  request(url, {
    ...opts,
    method: opts.method || 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json', ...(opts.headers || {}) },
    body: JSON.stringify(body),
  });

export { sleep };
