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
 * Does this text describe violence done to a person?
 *
 * Returns the matched word rather than a boolean, so the log can say WHY a
 * story was dropped. A silent filter that removes a third of the wire is
 * indistinguishable from a broken feed reader, and the last time this project
 * could not see why something vanished it cost three misdiagnoses.
 */
export function harshMatch(text) {
  const m = PATTERN.exec(String(text || ''));
  return m ? m[0].toLowerCase() : null;
}

/** Convenience predicate for the common case. */
export const isTooHarsh = (text) => harshMatch(text) !== null;

export { HARSH };
