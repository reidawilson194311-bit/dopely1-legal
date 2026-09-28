/**
 * A hard screen over what the news desk is allowed to cover.
 *
 * NICHE.exclusions already tells the writer to avoid tragedy and gore, but
 * that is prose in a system prompt and it lost: the desk handed the writer an
 * ICE shooting as the assignment, and the writer did the assignment. An
 * instruction cannot decline a story it was told to cover. So the refusal
 * belongs upstream of the writer, where it is a filter rather than a request.
 *
 * Keyword matching, deliberately. The alternative - asking a model whether a
 * story is too harsh - costs a call per headline and gives a different answer
 * on Tuesday. A word list is blunt, but it is the same on every run, it is
 * readable in a diff, and a reader can predict what it will drop.
 *
 * It screens for VIOLENCE DONE TO PEOPLE, which is the line drawn here. It is
 * not a general news filter: elections, disasters and disease are political or
 * grim but they are not this, and the pillar exclusions handle those.
 */

/**
 * Whole words only, so the obvious collisions stay out: `shot` must not fire
 * on "screenshot" or "moonshot", `dead` must not fire on "deadline". A \b on
 * both sides gets this for free - "deadline" has a word character after
 * "dead", so it never matches.
 */
const HARSH = [
  // firearms
  'shot', 'shots', 'shoots', 'shooting', 'shootings', 'shooter', 'shooters',
  'gunman',
  'gunmen', 'gunfire', 'gunshot', 'opened fire',
  // killing. The plurals and the present tense are listed explicitly and not
  // by accident: the first live run let through "children's killings" and
  // "man, 82, dies after beach fight", because the list held `killing` but not
  // `killings`, and `dead` but not `dies`. A near-miss on a word list is a
  // story published, so the variants are spelled out.
  'kill', 'kills', 'killed', 'killing', 'killings', 'killer', 'killers',
  'die', 'dies', 'died', 'dying', 'dead', 'death', 'deaths', 'death toll',
  'fatal', 'fatally', 'fatality', 'fatalities', 'murder', 'murders',
  'murdered', 'homicide', 'manslaughter', 'massacre', 'slain', 'slaying',
  'slayings', 'execution', 'executed', 'beheaded', 'lynching', 'victim',
  'victims', 'inquest', 'coroner',
  // bodily harm
  'stab', 'stabbed', 'stabbing', 'stabbings', 'beaten', 'mutilated',
  'dismembered', 'wounded', 'injuries', 'casualties', 'maimed', 'brutal',
  'brutally', 'bloodshed',
  // war and terror acts against people
  'airstrike', 'airstrikes', 'bombing', 'suicide bomber', 'car bomb',
  'hostage', 'hostages', 'kidnap', 'kidnapped', 'kidnapping', 'abduction',
  'trafficking', 'hate crime', 'torture', 'tortured',
  'atrocity', 'atrocities', 'war crime', 'war crimes', 'genocide',
  // abuse and self-harm
  'rape', 'raped', 'sexual assault', 'molested', 'abuse', 'abused',
  'suicide', 'self-harm', 'overdose',
];

// Longest alternative first. A regex alternation returns whichever branch is
// listed earliest, not the longest one, so an unsorted list reports `death`
// for "death toll" - true, but the less useful of the two answers, and the
// log line exists to be useful.
const PATTERN = new RegExp(
  `\\b(?:${[...HARSH]
    .sort((a, b) => b.length - a.length)
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|')})\\b`,
  'i',
);

/**
 * Phrasings where a harsh word is doing science, not violence.
 *
 * The screen is about violence done to PEOPLE, but its words are not. A sweep
 * of the held news scripts would have retired three of the best stories on the
 * desk: "NASA Reveals Ghosts of Five Supernovas" (dead stars), "Hubble Hunts
 * Reappearing Cosmic Explosion" (a dying star), and "Satellite Tracks Volcano
 * Awakened by Earthquake" (a volcano that shoots ash). The same words run at
 * ingest, so stories like these were being dropped from the wire all week
 * without a trace.
 *
 * Deliberately phrase-level and narrow. A blanket rule - "ignore `dead` in a
 * science story" - would let "five dead as volcano erupts" through, which is
 * the exact harm the screen exists to stop. Each entry names what the word is
 * attached to, so a real casualty still reads as one. Where a gap between the
 * word and its object is allowed, it is only for celestial objects: nothing
 * with a casualty count is ever "dead at planet".
 */
const BENIGN = [
  // dead / dying / death of a star, and friends
  /\b(?:dead|dying|died|dies|die|death\s+of\s+(?:a|the))\s+(?:[\w-]+\s+){0,2}?(?:stars?|suns?|galax(?:y|ies)|planets?|moons?|nebulae?|pulsars?|quasars?|white\s+dwarfs?|red\s+giants?|supernovae?)\b/gi,
  /\b(?:stars?|suns?|galax(?:y|ies)|planets?|stellar)(?:'s)?\s+(?:that\s+)?(?:died|dies|die|dying|death|deaths)\b/gi,
  // things that shoot out of the ground, or into a camera
  /\b(?:shoots?|shot|shooting)\s+(?:up|out|into|off|ash|lava|steam|smoke|plumes?|jets?|gas|water|debris|sparks?|photos?|pictures?|images?|video|footage|film|scenes?|stars?)\b/gi,
  // instruments firing radiation, not weapons firing at people. Found by the
  // sweep's own context line rather than guessed: "a joint US-India satellite
  // shoots radar pulses right through smoke and clouds". The first guess -
  // that a volcano was doing the shooting - was wrong.
  /\b(?:shoots?|shot|shooting)\s+(?:(?:a|an|the)\s+)?(?:[\w-]+\s+)?(?:radar|pulses?|lasers?|beams?|signals?|light|x-?rays?|particles?|neutrinos?|photons?|electrons?|microwaves?)\b/gi,
  // the most famous killing in science, and a few that are medicine
  /\bkill(?:ed|s|ing)?\s+(?:off\s+)?(?:the\s+)?(?:dinosaurs?|bacteria|germs|cancer\s+cells?|tumou?rs?|viruses?|weeds?|pests?)\b/gi,
  // names and terms of art
  /\bkiller\s+whales?\b/gi,
  /\b(?:heat\s+death|dead\s+zones?|dead\s+sea|death\s+valley)\b/gi,
];

/**
 * Does this text describe violence done to a person?
 *
 * Returns the matched word rather than a boolean, so the log can say WHY a
 * story was dropped. A silent filter that removes a third of the wire is
 * indistinguishable from a broken feed reader, and the last time this project
 * could not see why something vanished it cost three misdiagnoses.
 */
export function harshMatch(text) {
  return harshHit(text)?.word ?? null;
}

/**
 * The match and the words around it.
 *
 * The word alone was not enough to act on: a sweep reported "too harsh:
 * shoots" for a volcano story, and nothing said whether a volcano or a person
 * was doing the shooting. Tuning BENIGN from the word alone means guessing at
 * the phrasing; this shows it.
 */
export function harshHit(text) {
  let t = String(text || '');
  for (const re of BENIGN) t = t.replace(re, ' ');
  const m = PATTERN.exec(t);
  if (!m) return null;
  const from = Math.max(0, m.index - 45);
  const to = Math.min(t.length, m.index + m[0].length + 45);
  return { word: m[0].toLowerCase(), context: t.slice(from, to).replace(/\s+/g, ' ').trim() };
}

/** Convenience predicate for the common case. */
export const isTooHarsh = (text) => harshMatch(text) !== null;

export { HARSH };
