/**
 * How interesting is this story, as opposed to how widely it was reported?
 *
 * The desk used to rank purely by corroboration - how many outlets carried a
 * story. That is a good test of whether something is TRUE and a terrible test
 * of whether anyone wants to watch it. The two are close to opposites in
 * practice: six world desks all cover the same tax deadline, so it scores six
 * and tops the batch, while a discovery that only its own field reported
 * scores one and is thrown away.
 *
 * So corroboration stays where it belongs - as a gate on truth - and ranking
 * moves to this: a vocabulary score over the headline and summary. Words of
 * discovery and novelty score up, words of procedure and administration score
 * down.
 *
 * It is a word list, not a model call. A model asked "is this exciting?" costs
 * a call per headline, drifts between runs, and cannot be inspected in a diff.
 * This can be read, predicted and corrected by anyone looking at the file.
 */

/**
 * Discovery, scale, novelty, mystery. The things that make someone stop
 * scrolling: something was found, something is a first, something is the
 * biggest or oldest of its kind, something was not supposed to be possible.
 */
const BRIGHT = [
  // discovery
  'discover', 'discovers', 'discovered', 'discovery', 'uncover', 'uncovered',
  'unearth', 'unearthed', 'reveal', 'reveals', 'revealed', 'detect',
  'detected', 'spotted', 'identified', 'solve', 'solved', 'decoded',
  'deciphered', 'breakthrough',
  // novelty and scale
  'first', 'first-ever', 'never before', 'unprecedented', 'record-breaking',
  'oldest', 'largest', 'biggest', 'smallest', 'fastest', 'brightest',
  'deepest', 'rarest', 'closest', 'new species', 'new type',
  // mystery
  'mystery', 'mysterious', 'unexplained', 'puzzle', 'puzzling', 'strange',
  'bizarre', 'unusual', 'baffled', 'baffling', 'surprising', 'unexpected',
  'hidden', 'secrets', 'lost', 'buried',
  // space
  'nasa', 'telescope', 'galaxy', 'black hole', 'exoplanet', 'asteroid',
  'comet', 'meteorite', 'spacecraft', 'orbit', 'rover', 'moon', 'mars',
  'jupiter', 'saturn', 'solar', 'supernova', 'nebula', 'cosmic', 'launch',
  // earth and life
  'fossil', 'fossils', 'dinosaur', 'dinosaurs', 'ancient', 'prehistoric',
  'archaeology', 'archaeologist', 'archaeologists', 'archaeological', 'tomb',
  'ruins', 'species', 'extinct', 'volcano', 'eruption', 'erupted', 'glacier',
  'cave',
  'ocean', 'deep-sea', 'coral', 'migration',
  // science and tech
  'quantum', 'dna', 'genome', 'brain', 'neuron', 'antibiotic', 'vaccine',
  'cure', 'treatment', 'material', 'materials', 'superconductor', 'battery',
  'fusion', 'robot', 'prototype', 'invention', 'experiment', 'evolution',
  'origin', 'theory', 'physics',
];

/**
 * Procedure, process and administration. Real news, and the exact texture the
 * channel has no use for - a video about a filing deadline is a video nobody
 * finishes.
 */
const DULL = [
  // process
  'deadline', 'filing', 'filed', 'tax', 'taxes', 'budget', 'committee',
  'hearing', 'testimony', 'inquiry', 'review', 'consultation', 'memorandum',
  'statement', 'spokesperson', 'briefing', 'meeting', 'visit', 'talks',
  'negotiations', 'summit', 'delegation', 'agreement', 'treaty', 'pact',
  'accord', 'roadmap', 'working group',
  // politics
  'election', 'campaign', 'poll', 'polls', 'polling', 'ballot', 'candidate',
  'parliament', 'senate', 'congress', 'cabinet', 'minister', 'chancellor',
  'lawmaker', 'legislation', 'bill', 'bills', 'amendment', 'resign',
  'resigned', 'appointed',
  'sworn in', 'coalition', 'partisan', 'sanctions', 'ambassador',
  'diplomatic', 'embassy',
  // money
  'tariff', 'tariffs', 'quarterly', 'earnings', 'shares', 'stocks', 'index',
  'inflation', 'interest rate', 'gdp', 'bailout', 'subsidy', 'deficit',
  'trade deal', 'bilateral',
  // law
  'lawsuit', 'court', 'ruling', 'appeal', 'verdict', 'indictment',
  'prosecutor', 'plaintiff', 'settlement', 'regulator', 'compliance',
];

const build = (words) =>
  new RegExp(
    `\\b(?:${words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`,
    'gi',
  );

// Whole words, the same convention as the harshness screen, and for the same
// reason. Loose substring matching scores "billion" as the legislative sense
// of `bill` and "secretary" as `secret` - every variant that is wanted is
// spelled out in the lists above instead.
const BRIGHT_RE = build(BRIGHT);
const DULL_RE = build(DULL);

const hits = (re, text) => {
  re.lastIndex = 0;
  return [...new Set((String(text || '').match(re) || []).map((s) => s.toLowerCase()))];
};

/**
 * Score a story. Positive means it reads like a discovery, negative like an
 * agenda item.
 *
 * Distinct words are counted, not occurrences: a headline that says "tax" four
 * times is one dull idea, not four, and repetition should not outvote variety.
 * The hit lists come back with the score so the log can show its reasoning -
 * a ranking nobody can explain is a ranking nobody can correct.
 */
export function interestScore(text) {
  const bright = hits(BRIGHT_RE, text);
  const dull = hits(DULL_RE, text);
  return { score: bright.length - dull.length, bright, dull };
}

export { BRIGHT, DULL };
export default interestScore;
