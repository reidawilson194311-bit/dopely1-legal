import { request } from './http.js';

/**
 * A small RSS/Atom reader.
 *
 * Deliberately not a dependency: feeds are a narrow, stable format and this
 * machine already reads three social APIs with plain fetch. It handles the two
 * shapes that matter and is explicit about what it ignores.
 *
 * RSS 2.0 puts the url in <link>text</link>; Atom puts it in <link href="..."/>.
 * Dates are RFC-822 in one and ISO-8601 in the other. Getting either wrong
 * silently drops every item on a recency filter, so both are parsed and the
 * result is validated rather than trusted.
 */

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  '#39': "'", '#34': '"', '#8217': '’', '#8216': '‘',
  '#8220': '“', '#8221': '”', '#8212': '—', '#8211': '–',
};

/** Unescape the entities a feed actually uses, plus numeric ones. */
export function decodeEntities(text) {
  return String(text || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&([a-z]+|#\d+);/gi, (whole, name) => {
      const key = name.toLowerCase();
      if (ENTITIES[key] !== undefined) return ENTITIES[key];
      if (key.startsWith('#')) {
        const code = Number(key.slice(1));
        return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
      }
      return whole;
    });
}

/** Strip CDATA wrappers and tags, then collapse whitespace. */
export function textOf(raw) {
  return decodeEntities(
    String(raw || '')
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
      .replace(/<[^>]*>/g, ' '),
  )
    .replace(/\s+/g, ' ')
    .trim();
}

function tag(block, name) {
  // Namespaced variants (dc:date, media:title) are matched too.
  const m = new RegExp(`<(?:\\w+:)?${name}\\b[^>]*>([\\s\\S]*?)</(?:\\w+:)?${name}>`, 'i').exec(block);
  return m ? m[1] : '';
}

/** Atom keeps the url in an attribute; RSS keeps it in the element body. */
export function linkOf(block) {
  const atom = /<link\b[^>]*\bhref=["']([^"']+)["']/i.exec(block);
  if (atom) return decodeEntities(atom[1]);
  const rss = textOf(tag(block, 'link'));
  return rss || '';
}

/** Returns a Date, or null when the feed gave something unparseable. */
export function dateOf(block) {
  for (const name of ['pubDate', 'published', 'updated', 'date']) {
    const raw = textOf(tag(block, name));
    if (!raw) continue;
    const d = new Date(raw);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return null;
}

/** Parse feed XML into items. Malformed entries are skipped, not thrown on. */
export function parseFeed(xml, { source = '' } = {}) {
  const blocks = String(xml || '').match(/<(?:item|entry)\b[\s\S]*?<\/(?:item|entry)>/gi) || [];
  const items = [];
  for (const block of blocks) {
    const title = textOf(tag(block, 'title'));
    const url = linkOf(block);
    if (!title || !url) continue; // an item with neither is not usable
    items.push({
      title,
      url,
      summary: textOf(tag(block, 'description') || tag(block, 'summary') || tag(block, 'content')),
      publishedAt: dateOf(block),
      source,
    });
  }
  return items;
}

/** Fetch one feed. Never throws: a dead feed must not cost us the others. */
export async function fetchFeed(url, { source = '', timeoutMs = 20000 } = {}) {
  const xml = await request(url, {
    timeoutMs,
    retries: 1,
    headers: { accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml' },
  });
  return parseFeed(typeof xml === 'string' ? xml : String(xml), { source: source || url });
}

export default parseFeed;
