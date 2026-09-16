import crypto from 'node:crypto';

/** Stable id for a scraped post, so re-runs do not duplicate winners. */
export const postId = (platform, url) =>
  `${platform}_${crypto.createHash('sha1').update(String(url)).digest('hex').slice(0, 16)}`;

export const newId = (prefix) => `${prefix}_${crypto.randomBytes(8).toString('hex')}`;

/** Lowercase alphanumeric slug, safe as a filename. */
export const slug = (s, max = 48) =>
  String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, max) || 'untitled';
