import { contentTokens, similarity } from './similarity.js';

/**
 * Group headlines that describe the same event.
 *
 * News has no view count, so "notable" has to be measured some other way. The
 * signal used here is CORROBORATION: a story four independent outlets ran is
 * notable; one only a single outlet ran is not. That is the same shape as the
 * per-account median test in skill 01 - judge an item against its peers rather
 * than against an absolute threshold.
 *
 * Reuses the topic similarity written for script de-duplication, because it is
 * the same question: are these two texts about the same thing, ignoring how
 * they are worded. Outlets phrase one event a dozen ways.
 */

/** Two headlines this close are treated as the same story. */
export const SAME_STORY = 0.45;

/**
 * Greedy single-pass clustering.
 *
 * Deliberately not exhaustive pairwise merging: feeds return tens of items,
 * the clusters are small, and a headline that matches two clusters is far more
 * likely to be a vague headline than evidence the clusters should merge.
 */
export function clusterStories(items, threshold = SAME_STORY) {
  const clusters = [];
  for (const item of items) {
    const tokens = contentTokens(item.title);
    // A headline with almost no content words cannot be matched reliably, so
    // it gets its own cluster rather than attaching to whatever it grazes.
    const match = tokens.size >= 3
      ? clusters.find((c) => similarity(c.tokens, tokens) >= threshold)
      : null;
    if (match) {
      match.items.push(item);
      match.sources.add(item.source);
      continue;
    }
    clusters.push({ tokens, items: [item], sources: new Set([item.source]) });
  }
  return clusters;
}

/**
 * Turn clusters into ranked stories.
 *
 * `sourceCount` counts distinct OUTLETS, not items: one outlet running five
 * follow-ups on its own story is not corroboration, and counting items would
 * let a single prolific feed dominate every batch.
 */
export function rankStories(clusters, { minSources = 2, keepTop = 12, now = new Date() } = {}) {
  return clusters
    .map((c) => {
      // The earliest report is when it broke; the longest headline usually
      // carries the most detail for the writer to work from.
      const dated = c.items.filter((i) => i.publishedAt);
      const brokeAt = dated.length
        ? new Date(Math.min(...dated.map((i) => i.publishedAt.getTime())))
        : null;
      const lead = c.items.slice().sort((a, b) => b.title.length - a.title.length)[0];
      return {
        title: lead.title,
        url: lead.url,
        summary: lead.summary,
        sourceCount: c.sources.size,
        sources: [...c.sources],
        urls: c.items.map((i) => i.url),
        brokeAt,
        ageHours: brokeAt ? Math.round((now.getTime() - brokeAt.getTime()) / 36e5) : null,
      };
    })
    .filter((s) => s.sourceCount >= minSources)
    // Most corroborated first; freshest breaks the tie, so a big story from
    // this morning outranks an equally covered one from yesterday.
    .sort((a, b) => b.sourceCount - a.sourceCount || (a.ageHours ?? 1e9) - (b.ageHours ?? 1e9))
    .slice(0, keepTop);
}

export default rankStories;
