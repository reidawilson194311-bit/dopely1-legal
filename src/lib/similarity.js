/**
 * Topic similarity, for catching two scripts about the same thing.
 *
 * Distinct from `overlapRatio` in skill 02, which asks "did we copy the
 * source's *wording*" and measures consecutive-word echo. This asks "is this
 * the same *idea* we already covered", which survives a full rewrite - two
 * scripts can share no phrasing at all and still both be about house dust
 * being mostly dead skin.
 *
 * Measured as Jaccard overlap of content words, which is deliberately
 * order-blind: "dust is mostly skin" and "most house dust is dead skin" are
 * the same post, and no phrase-level measure would say so.
 */

const STOPWORDS = new Set([
  'about', 'after', 'again', 'all', 'also', 'and', 'any', 'are', 'because',
  'been', 'before', 'being', 'between', 'both', 'but', 'can', 'did', 'does',
  'doing', 'down', 'during', 'each', 'few', 'for', 'from', 'further', 'had',
  'has', 'have', 'having', 'her', 'here', 'hers', 'him', 'his', 'how', 'into',
  'its', 'itself', 'just', 'more', 'most', 'not', 'now', 'off', 'once', 'only',
  'other', 'our', 'out', 'over', 'own', 'same', 'she', 'should', 'some', 'such',
  'than', 'that', 'the', 'their', 'them', 'then', 'there', 'these', 'they',
  'this', 'those', 'through', 'too', 'under', 'until', 'very', 'was', 'were',
  'what', 'when', 'where', 'which', 'while', 'who', 'why', 'will', 'with',
  'you', 'your', 'yours',
]);

/** Meaningful words only: 3+ letters, no stopwords, crudely de-pluralised. */
export function contentTokens(text) {
  // 3 rather than 4: "war", "ice", "sun", "gut" carry the whole topic in this
  // niche, and dropping them made two scripts about the same war look unlike.
  const words = String(text || '').toLowerCase().match(/[a-z']{3,}/g) || [];
  return new Set(
    words
      .filter((w) => !STOPWORDS.has(w))
      .map((w) => (w.endsWith('ies') ? `${w.slice(0, -3)}y` : w.replace(/s$/, ''))),
  );
}

/**
 * 0 = nothing in common, 1 = one text's ideas are a subset of the other's.
 *
 * Overlap coefficient (shared / smaller set), not Jaccard. Jaccard divides by
 * the union, so a terse hook compared against a longer one scores low purely
 * for being short - "Sharks existed before trees" vs "Sharks are older than
 * trees by 100 million years" came out at 0.33, below any threshold that also
 * excluded unrelated pairs. What we are asking is "is this text's subject
 * contained in that one", and that is what the overlap coefficient measures.
 */
export function similarity(a, b) {
  const setA = a instanceof Set ? a : contentTokens(a);
  const setB = b instanceof Set ? b : contentTokens(b);
  if (!setA.size || !setB.size) return 0;
  let shared = 0;
  for (const token of setA) if (setB.has(token)) shared++;
  return shared / Math.min(setA.size, setB.size);
}

/**
 * Default threshold. Tuned so a genuine restatement of the same fact trips it
 * while two different facts that happen to share a noun do not - erring
 * towards letting a borderline pair through, because wrongly dropping a good
 * script costs a day's output and wrongly keeping one costs a repeated post.
 */
export const DUPLICATE_THRESHOLD = 0.5;

/**
 * Words this corpus uses everywhere, which therefore say nothing about topic.
 *
 * Scripts share house phrasing - a recurring hook shape, a stock framing - and
 * those words are pure noise in a topic comparison. On short signatures they
 * are worse than noise: four shared boilerplate words against a two-word topic
 * scores 0.8 and two unrelated scripts look identical.
 *
 * Only fires once a word is common across a real sample, so an empty or tiny
 * corpus strips nothing and a growing one cleans itself up.
 */
export function corpusStopwords(entries, { minDocs = 3, minShare = 0.5 } = {}) {
  const threshold = Math.max(minDocs, Math.ceil(entries.length * minShare));
  if (entries.length < minDocs) return new Set();
  const df = new Map();
  for (const e of entries) {
    for (const token of e.tokens || contentTokens(e.text ?? e)) {
      df.set(token, (df.get(token) || 0) + 1);
    }
  }
  return new Set([...df.entries()].filter(([, n]) => n >= threshold).map(([t]) => t));
}

const without = (tokens, drop) => {
  if (!drop.size) return tokens;
  const out = new Set();
  for (const t of tokens) if (!drop.has(t)) out.add(t);
  return out;
};

/** The closest match among `others`, or null when nothing is close enough. */
export function findDuplicate(text, others, threshold = DUPLICATE_THRESHOLD, common) {
  const drop = common ?? corpusStopwords(others);
  const tokens = without(contentTokens(text), drop);
  if (!tokens.size) return null;

  let best = null;
  for (const other of others) {
    const otherTokens = without(other.tokens || contentTokens(other.text ?? other), drop);
    const score = similarity(tokens, otherTokens);
    if (score >= threshold && (!best || score > best.score)) {
      best = { score: Number(score.toFixed(3)), text: other.text ?? other };
    }
  }
  return best;
}

export default findDuplicate;
