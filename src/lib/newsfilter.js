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
  'shot', 'shots', 'shoots', 'shooting', 'shootings', 'shooter', 'gunman',
  'gunmen', 'gunfire', 'gunshot', 'opened fire',
  // killing
  'killed', 'killing', 'kills', 'dead', 'deaths', 'death toll', 'fatal',
  'fatally', 'murder', 'murdered', 'homicide', 'manslaughter', 'massacre',
  'slain', 'execution', 'executed', 'beheaded', 'lynching',
  // bodily harm
  'stabbed', 'stabbing', 'beaten', 'mutilated', 'dismembered', 'wounded',
  'casualties', 'maimed',
  // war and terror acts against people
  'airstrike', 'airstrikes', 'bombing', 'suicide bomber', 'car bomb',
  'hostage', 'hostages', 'kidnapped', 'abduction', 'torture', 'tortured',
  'atrocity', 'atrocities', 'war crime', 'war crimes', 'genocide',
  // abuse and self-harm
  'rape', 'raped', 'sexual assault', 'molested', 'abuse', 'abused',
  'suicide', 'self-harm', 'overdose',
];

const PATTERN = new RegExp(
  `\\b(?:${HARSH.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`,
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
