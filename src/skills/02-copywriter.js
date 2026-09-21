/**
 * SKILL 02 / THE COPYWRITER  -  "It launders the idea."
 *
 *   NODE 1  INPUT   reads the winners
 *   NODE 2  ENGINE  rewrite + voice-match (same idea, new words, sounds human)
 *   NODE 3  OUTPUT  a new script table
 *
 * The proven thing is the *idea* - the angle that made a stranger stop
 * scrolling. That transfers. The words do not: republishing someone's script
 * is both a copyright problem and a duplicate-content problem. So the engine
 * takes the idea, throws the execution away, and rebuilds it in our voice as a
 * short-form video script.
 */
import { config } from '../config.js';
import { NICHE } from '../niche.js';
import { logger } from '../lib/log.js';
import { getStore, TABLES } from '../lib/store/index.js';
import { generateJSON, DeclinedError, describeWriter } from '../lib/writer/index.js';
import { newId, slug } from '../lib/id.js';
import { findDuplicate, contentTokens } from '../lib/similarity.js';
import { reportBatch } from '../lib/batch.js';

const log = logger('02-copy');

/** Share of output trigrams allowed to appear in the source before we reject. */
const OVERLAP_LIMIT = 0.15;

const scriptSchema = (beats) => ({
  type: 'object',
  additionalProperties: false,
  required: [
    'title', 'pillar', 'hook', 'beats', 'cta',
    'captions', 'hashtags', 'youtubeTitle', 'sourceNote', 'estimatedDurationSec',
  ],
  properties: {
    title: { type: 'string', description: 'Internal working title, max 8 words.' },
    pillar: { type: 'string', enum: NICHE.pillars.map((p) => p.id) },
    hook: {
      type: 'string',
      description: 'Spoken first line. Max 12 words. The first four words must carry it.',
    },
    beats: {
      type: 'array',
      minItems: Math.max(3, beats - 1),
      maxItems: beats + 1,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['onScreenText', 'voiceover', 'imagePrompt'],
        properties: {
          onScreenText: { type: 'string', description: 'Burned-in caption. Max 7 words.' },
          voiceover: { type: 'string', description: 'One or two spoken sentences.' },
          imagePrompt: {
            type: 'string',
            description:
              'A literal description of one image illustrating this beat. Describe the subject, ' +
              'composition and lighting. No text, no logos, no real people.',
          },
        },
      },
    },
    cta: { type: 'string', description: 'One line. A reason to follow, not a demand.' },
    captions: {
      type: 'object',
      additionalProperties: false,
      required: ['instagram', 'tiktok', 'youtube'],
      properties: {
        instagram: { type: 'string' },
        tiktok: { type: 'string' },
        youtube: { type: 'string' },
      },
    },
    hashtags: {
      type: 'object',
      additionalProperties: false,
      required: ['instagram', 'tiktok', 'youtube'],
      properties: {
        instagram: { type: 'array', items: { type: 'string' }, maxItems: 8 },
        tiktok: { type: 'array', items: { type: 'string' }, maxItems: 6 },
        youtube: { type: 'array', items: { type: 'string' }, maxItems: 5 },
      },
    },
    youtubeTitle: { type: 'string', description: 'Max 70 characters.' },
    sourceNote: {
      type: 'string',
      description:
        'Where the central claim comes from and how a viewer could check it. ' +
        'If it cannot be sourced, say so plainly - that script gets dropped.',
    },
    estimatedDurationSec: { type: 'number' },
  },
});

function systemPrompt() {
  return [
    `You write short-form video scripts for a ${NICHE.name} account publishing to`,
    'Instagram Reels, TikTok and YouTube Shorts.',
    '',
    `BRIEF: ${NICHE.brief}`,
    '',
    `VOICE: ${NICHE.voice.persona}`,
    ...NICHE.voice.rules.map((r) => `- ${r}`),
    '',
    `NEVER WRITE: ${NICHE.voice.banned_phrases.join(', ')}.`,
    '',
    'NEVER COVER:',
    ...NICHE.exclusions.map((e) => `- ${e}`),
    '',
    'HOW TO USE THE REFERENCE POST:',
    'You are given one post that already performed well. Take only its underlying',
    'idea and the structural reason it worked - the curiosity gap, the reversal,',
    'the surprising number. Then write something new about that idea.',
    'Do not reuse its sentences, its phrasing or its exact framing. If you find',
    'yourself echoing more than three consecutive words from the reference, rewrite.',
    '',
    'ACCURACY: every factual claim must be true and checkable. A script whose',
    'central claim you cannot source is worthless to us - say so in sourceNote',
    'rather than inventing a citation.',
    '',
    'COMPARISONS: name the exact thing compared. "Hotter than the sun" and',
    "\"hotter than the sun's CORE\" differ by a factor of a thousand, and the",
    'hook is the line that carries the video - it must be the precise one, not',
    'the roundest one. The same precision applies in sourceNote: a unit you',
    'cannot state correctly is a claim you should not make.',
    '',
    'BEATS: onScreenText and voiceover are read at the same moment, so they must',
    'make the same claim. The text is the headline for what the voice is saying.',
    'A beat captioned with a date while the voice describes a mechanism reads as',
    'two unrelated videos playing at once.',
    '',
    'CTA: write one that belongs to THIS script. A feed where every video closes',
    'on the same sentence reads as a template, and platforms demote templates.',
    '',
    `LENGTH: ${config.copy.beatsPerScript} beats, 30-45 seconds of voiceover total.`,
  ].join('\n');
}

/**
 * Extra rules for a story from the news desk.
 *
 * Read on top of the house rules, not instead of them, because the accuracy
 * and beat rules matter MORE here, not less.
 *
 * Two constraints shape this, and both are external:
 *
 * A newsreader is the one format platforms name as unmonetisable. YouTube's
 * inauthentic-content policy calls out "channels that read articles verbatim
 * instead of analyzing them", so a script that restates the headline is worth
 * nothing even when it is accurate. The value has to be the part the headline
 * leaves out.
 *
 * And the pictures are generated, so they cannot show the event. Asking for a
 * real person or a real moment produces either a refusal or an invention
 * presented as footage. The scene is what can honestly be drawn: the place,
 * the object, the empty room, the thing the story is about.
 */
function newsRules(winner) {
  return [
    '',
    'THIS IS A NEWS STORY. The rules above still apply. These are extra.',
    '',
    `CORROBORATION: carried by ${winner.views} outlets (${winner.sourceOutlets || 'unknown'})`,
    winner.ageHours != null ? `AGE: it broke about ${winner.ageHours} hours ago.` : '',
    '',
    'DO NOT READ THE HEADLINE BACK. A script that restates what the headline',
    'already said is worth nothing - and it is specifically the format',
    'platforms refuse to monetise. Earn the video by adding what the headline',
    'leaves out: the mechanism behind it, the number that puts it in',
    'proportion, the precedent it echoes, what actually changes next.',
    '',
    'STRUCTURE: open on what happened, in one line a stranger understands with',
    'no prior context. Then why it matters. Then what happens next. The middle',
    'is where the video earns its place.',
    '',
    'CERTAINTY: say only what is reported. If something is alleged, expected or',
    'disputed, use those words. A confident sentence about an uncertain thing',
    'is the way this format goes wrong, and it is not fixable after posting.',
    'Where reports disagree, that disagreement IS the story - say so.',
    '',
    'NO PREDICTIONS stated as fact. "What happens next" means what has been',
    'announced or scheduled, not what you expect.',
    '',
    'IMAGES: every imagePrompt must describe a SCENE, not a person and not a',
    'moment from the event. The pictures are generated, so they cannot show',
    'what happened and must never pretend to. Draw the place, the object, the',
    'empty chamber, the machinery, the landscape - what the story is ABOUT.',
    'No recognisable individuals, no crowds implying a specific event, nothing',
    'that could be mistaken for footage.',
    '',
    'sourceNote: name the outlets that carried it and what each confirmed.',
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Pick the pillar this script has to serve.
 *
 * The schema always listed every pillar and nothing ever chose between them,
 * so the engine picked for itself and picked the same one four times out of
 * four - a channel of nothing but animal trivia, from a brief asking for six
 * subjects. Weights set the long-run mix; the recent-pillar exclusion stops a
 * single batch landing entirely on the heaviest one.
 */
export function choosePillar(pillars, recent = [], pick = Math.random) {
  const fresh = pillars.filter((p) => !recent.includes(p.id));
  const pool = fresh.length ? fresh : pillars;
  const total = pool.reduce((sum, p) => sum + (p.weight || 1), 0);
  let n = pick() * total;
  for (const p of pool) {
    n -= p.weight || 1;
    if (n <= 0) return p;
  }
  return pool[pool.length - 1];
}

/** A story from the news desk, rather than a post that performed well. */
export const isNewsWinner = (winner) => winner?.platform === 'news';

function userPrompt(winner, recentTitles, pillar) {
  // A news story is not a "reference post to launder" - it is an event to
  // report. Framing it as something to take the idea from and reword invites
  // exactly the headline-restatement the rules forbid.
  const reference = isNewsWinner(winner)
    ? [
        'THE STORY (what was reported - not text to reuse):',
        `  headline:  ${winner.hook}`,
        `  outlets:   ${winner.sourceOutlets || 'unknown'} (${winner.views} independent)`,
        winner.ageHours != null ? `  age:       about ${winner.ageHours} hours old` : '',
        `  reported:  ${winner.caption?.slice(0, 900) || '(no summary)'}`,
      ].filter(Boolean)
    : [
        'REFERENCE POST (performed well - use the idea, not the words):',
        `  platform: ${winner.platform}`,
        `  views: ${winner.views.toLocaleString()} (${winner.viralMultiple}x this account's median)`,
        `  caption: ${winner.caption?.slice(0, 600) || '(none)'}`,
      ];

  return [
    `PILLAR: write this one as "${pillar.id}" - ${pillar.label}.`,
    isNewsWinner(winner)
      ? ''
      : 'The reference post need not belong to that pillar; find the angle on its\nidea that does.',
    '',
    ...reference,
    '',
    recentTitles.length
      ? `ALREADY PUBLISHED - do not repeat these angles:\n${recentTitles.map((t) => `  - ${t}`).join('\n')}`
      : '',
    '',
    'Write one original short-form video script.',
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Guard against the engine echoing the source it was told to launder.
 *
 * Measured over word trigrams, not a bag of words: two texts about the same
 * subject legitimately share nouns and every text shares "the" and "is", so a
 * vocabulary overlap flags honest rewrites. A shared run of three consecutive
 * words is the thing the system prompt actually forbids, and it is rare by
 * chance. Returns the share of the output's trigrams that appear in the source.
 */
export function overlapRatio(source, output) {
  const words = (s) => String(s || '').toLowerCase().match(/[a-z0-9']+/g) || [];
  const trigrams = (w) => {
    const out = [];
    for (let i = 0; i + 2 < w.length; i++) out.push(`${w[i]} ${w[i + 1]} ${w[i + 2]}`);
    return out;
  };
  const src = new Set(trigrams(words(source)));
  const out = trigrams(words(output));
  if (!out.length || !src.size) return 0;
  return out.filter((t) => src.has(t)).length / out.length;
}

/**
 * Stand-in for the engine in --dry-run. It deliberately does NOT echo the
 * source wording - a placeholder that trips the overlap guard would make the
 * dry run exercise the reject path instead of the happy path, and hide whether
 * the rest of the pipeline works.
 */
const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'is', 'are', 'was', 'were', 'be', 'been',
  'to', 'of', 'in', 'on', 'for', 'that', 'this', 'it', 'its', 'your', 'you',
  'has', 'have', 'had', 'than', 'then', 'with', 'by', 'at', 'as', 'from', 'did',
]);

function topicOf(text) {
  const words = String(text || '').toLowerCase().match(/[a-z]{4,}/g) || [];
  const keep = words.filter((w) => !STOPWORDS.has(w));
  return keep.slice(0, 2).join(' ') || 'the thing';
}

function dryRunScript(winner) {
  const pillar = NICHE.pillars[winner.views % NICHE.pillars.length];
  const topic = topicOf(winner.hook || winner.caption);
  // Vary the title and hook by topic. A fixture where every script shares a
  // hook verbatim makes unrelated topics look like duplicates to the guard -
  // which is correct behaviour on a real shared hook, and pure noise here.
  return {
    title: topic.replace(/\b\w/g, (ch) => ch.toUpperCase()).slice(0, 60),
    pillar: pillar.id,
    hook: `Nobody mentions what ${topic} actually means.`,
    beats: Array.from({ length: config.copy.beatsPerScript }, (_, i) => ({
      onScreenText: `Point ${i + 1}`,
      voiceover: `Dry-run narration, line ${i + 1}. Nothing here is a real claim.`,
      imagePrompt: `Editorial photograph, concept: ${topic}, frame ${i + 1}, no text.`,
    })),
    cta: 'Follow for one of these a day.',
    captions: {
      instagram: `Placeholder caption — dry run (${topic}).`,
      tiktok: `Placeholder caption — dry run (${topic}).`,
      youtube: `Placeholder caption — dry run (${topic}).`,
    },
    hashtags: {
      instagram: NICHE.hashtags.instagram.slice(0, 5),
      tiktok: NICHE.hashtags.tiktok.slice(0, 5),
      youtube: NICHE.hashtags.youtube.slice(0, 4),
    },
    youtubeTitle: `Placeholder: ${topic}`.slice(0, 70),
    sourceNote: 'Dry-run placeholder — not a sourced claim.',
    estimatedDurationSec: 38,
  };
}

export async function write({ limit = config.copy.batchSize } = {}) {
  log.banner('SKILL 02 / THE COPYWRITER', 'It launders the idea.');
  const store = getStore();

  // NODE 1, INPUT: read the winners we have not written from yet.
  const winners = await store.list(TABLES.WINNERS, {
    where: (r) => r.status === 'winner',
    sort: (a, b) => (b.viralScore || 0) - (a.viralScore || 0),
    limit,
  });
  if (!winners.length) {
    log.warn('no unused winners - run the researcher first');
    return [];
  }
  log.info(`NODE 1 / INPUT: ${winners.length} winners`);
  if (!config.dryRun) log.info(`NODE 2 / ENGINE: ${await describeWriter()}`);

  // Everything we have already covered, as topic signatures. Two sources:
  // the scripts themselves, and the hooks of winners we already wrote from -
  // a winner whose idea we used is still the idea we used, even if the script
  // that came out of it reads nothing like it.
  const priorScripts = await store.list(TABLES.SCRIPTS, { limit: 200 });
  const usedWinners = await store.list(TABLES.WINNERS, { where: (r) => r.status === 'used' });
  // Signature is the TITLE, not the title plus hook. The title is the claim;
  // the hook is framing, and framing is shared house style - on a fresh base
  // there is no corpus yet to recognise that boilerplate, so including it made
  // four unrelated topics score 0.8 against each other on day one.
  const seen = [
    ...priorScripts.map((s) => ({ text: s.title, tokens: contentTokens(s.title) })),
    ...usedWinners.map((w) => ({ text: w.hook || '', tokens: contentTokens(w.hook || '') })),
  ].filter((e) => e.tokens.size);

  const recentTitles = priorScripts.slice(0, 25).map((s) => s.title);
  // Pillars already used recently, so a fresh batch does not land on one
  // subject the way the first four scripts all landed on did-you-know.
  const recentPillars = priorScripts.slice(0, NICHE.pillars.length - 1).map((s) => s.pillar);
  const written = [];
  const errors = [];
  let duplicates = 0;

  // NODE 2, ENGINE: rewrite + voice-match.
  for (const winner of winners) {
    try {
      // Cheapest rejection first: if the source idea is one we have covered,
      // skip before spending a generation call on it.
      const sourceDupe = findDuplicate(winner.hook || winner.caption || '', seen);
      if (sourceDupe) {
        log.warn(`source idea already covered (${sourceDupe.score}), skipping`, winner.id);
        await store.patch(TABLES.WINNERS, winner.id, { status: 'rejected-duplicate' });
        duplicates++;
        continue;
      }

      // A news story is always the news pillar - rotation picks the subject of
      // an evergreen script, but it cannot make an event into psychology.
      const news = isNewsWinner(winner);
      const pillar = news
        ? NICHE.pillars.find((p) => p.id === 'news')
        : choosePillar(NICHE.pillars, recentPillars);

      const script = config.dryRun
        ? dryRunScript(winner)
        : await generateJSON({
            system: news ? `${systemPrompt()}\n${newsRules(winner)}` : systemPrompt(),
            prompt: userPrompt(winner, recentTitles, pillar),
            schema: scriptSchema(config.copy.beatsPerScript),
          });

      const spoken = [script.hook, ...script.beats.map((b) => b.voiceover)].join(' ');
      // For news the source text is the headline plus the outlet's own
      // summary, and echoing THAT is the specific failure mode here - a script
      // that reads the report back. So the guard runs against both.
      const sourceText = news ? `${winner.hook} ${winner.caption || ''}` : winner.caption;
      const overlap = overlapRatio(sourceText, spoken);
      if (overlap > OVERLAP_LIMIT) {
        log.warn(`too close to the source (${Math.round(overlap * 100)}% trigram echo), skipping`, winner.id);
        await store.patch(TABLES.WINNERS, winner.id, { status: 'rejected-overlap' });
        continue;
      }

      // And again on the output: different winners can converge on one idea,
      // and `seen` grows as this batch runs, so two scripts written minutes
      // apart cannot both go out about the same thing.
      const signature = script.title;
      const outputDupe = findDuplicate(signature, seen);
      if (outputDupe) {
        log.warn(`writes the same idea as "${outputDupe.text.slice(0, 60)}" (${outputDupe.score}), skipping`, winner.id);
        await store.patch(TABLES.WINNERS, winner.id, { status: 'rejected-duplicate' });
        duplicates++;
        continue;
      }
      seen.push({ text: signature, tokens: contentTokens(signature) });

      const row = {
        id: newId('scr'),
        niche: NICHE.id,
        sourceWinnerId: winner.id,
        sourcePlatform: winner.platform,
        sourceUrl: winner.url,
        slug: slug(script.title),
        ...script,
        overlapRatio: Number(overlap.toFixed(3)),
        status: 'ready-to-design',
        writtenAt: new Date().toISOString(),
      };
      written.push(row);
      recentTitles.push(script.title);
      recentPillars.push(script.pillar);
      await store.patch(TABLES.WINNERS, winner.id, { status: 'used' });
      log.info(`  wrote "${script.title}" [${script.pillar}] ${script.beats.length} beats`);
    } catch (err) {
      if (err instanceof DeclinedError) {
        log.warn('declined, marking the source and moving on', winner.id);
        await store.patch(TABLES.WINNERS, winner.id, { status: 'rejected-declined' });
        continue;
      }
      log.error(`failed on ${winner.id}`, err.message);
      errors.push(err.message);
    }
  }

  // NODE 3, OUTPUT: the new copy table.
  if (written.length) await store.upsert(TABLES.SCRIPTS, written);
  log.info(
    `NODE 3 / OUTPUT: ${written.length} scripts written to ${store.driver}` +
      (duplicates ? ` (${duplicates} skipped as already-covered ideas)` : ''),
  );
  reportBatch(log, { attempted: winners.length, succeeded: written.length, errors });
  return written;
}

export default write;
