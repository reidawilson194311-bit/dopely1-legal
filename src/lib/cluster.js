import { contentTokens, similarity } from './similarity.js';
import { interestScore } from './interest.js';

/**
 * Group headlines that describe the same event.
 *
 * News has no view count, so "notable" has to be measured some other way.
 * CORROBORATION is the measure of whether a story is REAL: one four
 * independent outlets ran happened; one a single outlet ran might not have.
 * That is the same shape as the per-account median test in skill 01 - judge an
 * item against its peers rather than against an absolute threshold.
 *
 * It is not a measure of whether the story is worth watching. See rankStories
 * below, where that is scored separately.
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
 *
 * Corroboration GATES, interest RANKS. They used to be the same number, and
 * the result was a batch of tax deadlines: the story six world desks all cover
 * is by construction the procedural one, while a discovery reported by the
 * field that made it scores one and was discarded. Whether a story is true and
 * whether anyone wants to watch it are close to opposite questions, so they
 * are now asked separately.
 *
 * `primarySources` are outlets that ARE the source rather than reporting one -
 * a space agency announcing its own mission. Asking a second outlet to confirm
 * what NASA said about NASA adds nothing, and the requirement silently deleted
 * every exciting story the science feeds broke.
 */
export function rankStories(clusters, {
  minSources = 2,
  keepTop = 12,
  minInterest = 1,
  primarySources = [],
  now = new Date(),
} = {}) {
  const primary = new Set(primarySources);
  return clusters
    .map((c) => {
      // The earliest report is when it broke; the longest headline usually
      // carries the most detail for the writer to work from.
      const dated = c.items.filter((i) => i.publishedAt);
      const brokeAt = dated.length
        ? new Date(Math.min(...dated.map((i) => i.publishedAt.getTime())))
        : null;
      const lead = c.items.slice().sort((a, b) => b.title.length - a.title.length)[0];
      const interest = interestScore(`${lead.title} ${lead.summary || ''}`);
      return {
        title: lead.title,
        url: lead.url,
        summary: lead.summary,
        interest: interest.score,
        bright: interest.bright,
        dull: interest.dull,
        fromPrimary: [...c.sources].some((src) => primary.has(src)),
        sourceCount: c.sources.size,
        sources: [...c.sources],
        urls: c.items.map((i) => i.url),
        brokeAt,
        ageHours: brokeAt ? Math.round((now.getTime() - brokeAt.getTime()) / 36e5) : null,
      };
    })
    // The truth gate: corroborated by enough outlets, OR broken by an outlet
    // that is itself the primary source.
    .filter((s) => s.sourceCount >= minSources || s.fromPrimary)
    // The interest gate. A story with no signal of discovery at all is not
    // worth a video, and an empty news day is a better outcome than a video
    // about a filing deadline - the other pillars keep the schedule fed.
    .filter((s) => s.interest >= minInterest)
    // Most interesting first. Corroboration breaks the tie, then freshness, so
    // between two equally interesting stories the better-attested and more
    // recent one wins.
    .sort((a, b) =>
      b.interest - a.interest ||
      b.sourceCount - a.sourceCount ||
      (a.ageHours ?? 1e9) - (b.ageHours ?? 1e9))
    .slice(0, keepTop);
}

export default rankStories;
