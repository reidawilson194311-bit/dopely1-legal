import { NICHE } from '../src/niche.js';

/**
 * The Airtable base, as code.
 *
 * This is the source of truth for the base's shape - `setup-airtable.js` builds
 * it and `docs/AIRTABLE_SCHEMA.md` documents it. Every field here is one the
 * four skills actually write; a field the code writes but the base lacks is
 * silently dropped by Airtable, which is exactly the kind of loss you only
 * notice weeks later.
 *
 * `id` is first in every table because Airtable makes the first field the
 * primary field, and our `id` is what makes a re-run update a row instead of
 * duplicating it.
 */

const text = (name) => ({ name, type: 'singleLineText' });
const long = (name) => ({ name, type: 'multilineText' });
const url = (name) => ({ name, type: 'url' });
const int = (name) => ({ name, type: 'number', options: { precision: 0 } });
const dec = (name, precision = 2) => ({ name, type: 'number', options: { precision } });
const check = (name) => ({ name, type: 'checkbox', options: { icon: 'check', color: 'greenBright' } });
const when = (name) => ({
  name,
  type: 'dateTime',
  options: {
    dateFormat: { name: 'iso' },
    timeFormat: { name: '24hour' },
    timeZone: 'utc',
  },
});
const select = (name, choices) => ({
  name,
  type: 'singleSelect',
  options: { choices: choices.map((c) => ({ name: c })) },
});

const PLATFORMS = ['instagram', 'tiktok', 'youtube'];
// Winners can also come from the news desk, which is a source rather than a
// platform we publish to - so it belongs here and NOT in the posts table.
const WINNER_SOURCES = [...PLATFORMS, 'news'];
const PILLARS = NICHE.pillars.map((p) => p.id);

export const TABLES = [
  {
    name: 'Winners',
    description: 'Skill 01. Posts that beat their own account\'s median. Sort by viralScore.',
    fields: [
      text('id'),
      select('platform', WINNER_SOURCES),
      text('account'),
      url('accountUrl'),
      url('url'),
      long('caption'),
      long('hook'),
      int('views'),
      int('likes'),
      int('comments'),
      int('shares'),
      int('durationSec'),
      when('postedAt'),
      url('thumbnailUrl'),
      text('mediaType'),
      int('accountMedian'),
      dec('viralMultiple'),
      dec('engagementRate', 4),
      dec('viralScore', 3),
      // Skill 01b. How many distinct outlets carried the story, and how old it
      // was when we read it.
      text('sourceOutlets'),
      int('ageHours'),
      text('niche'),
      select('status', [
        'winner', 'used', 'rejected-overlap', 'rejected-duplicate', 'rejected-declined',
      ]),
      when('scrapedAt'),
    ],
  },
  {
    name: 'Scripts',
    description: 'Skill 02. Original scripts. Read sourceNote before publishing anything.',
    fields: [
      text('id'),
      text('sourceWinnerId'),
      select('sourcePlatform', PLATFORMS),
      url('sourceUrl'),
      text('title'),
      text('slug'),
      select('pillar', PILLARS),
      long('hook'),
      long('beats'),
      long('cta'),
      long('captions'),
      long('hashtags'),
      text('youtubeTitle'),
      long('sourceNote'),
      dec('estimatedDurationSec', 1),
      dec('overlapRatio', 3),
      text('niche'),
      select('status', [// News scripts land in needs-review; everything else goes straight to
        // ready-to-design. `superseded` retires a batch that should not go out.
        'needs-review', 'rejected', 'superseded',
        'ready-to-design', 'designed', 'needs-encode', 'design-failed']),
      when('writtenAt'),
    ],
  },
  {
    name: 'Renders',
    description:
      'Skill 03. Encoded shorts. videoPath is local to the machine that rendered it and ' +
      'does not survive it; videoUrl is the hosted copy the poster publishes from.',
    fields: [
      text('id'),
      text('scriptId'),
      text('title'),
      text('slug'),
      select('pillar', PILLARS),
      text('dir'),
      long('frames'),
      text('videoPath'),
      // Hosted at render time, because the runner that holds videoPath is
      // destroyed before the poster's turn comes round.
      text('videoUrl'),
      dec('durationSec', 2),
      check('hasAudio'),
      long('captions'),
      long('hashtags'),
      text('youtubeTitle'),
      long('cta'),
      text('niche'),
      select('status', [
        'ready-to-post', 'needs-encode', 'posted', 'partially-posted', 'post-failed',
      ]),
      when('renderedAt'),
    ],
  },
  {
    name: 'Posts',
    description: 'Skill 04. The schedule. A calendar view on publishAt is the "every day, forever" screen.',
    fields: [
      text('id'),
      text('renderId'),
      text('scriptId'),
      select('platform', PLATFORMS),
      text('title'),
      long('caption'),
      text('youtubeTitle'),
      text('videoPath'),
      when('publishAt'),
      text('publishAtLocal'),
      text('timezone'),
      select('provider', ['metricool', 'unipile', 'local-queue']),
      select('status', ['queued', 'scheduled', 'published', 'schedule-failed']),
      text('externalId'),
      when('publishedAt'),
      long('error'),
    ],
  },
];

export default TABLES;

/**
 * What this table is missing, and what is there under the wrong type.
 * Pure, so the sync logic can be tested without an Airtable account.
 */
export function diffTable(spec, table) {
  if (!table) return { missing: spec.fields, wrongType: [], primaryOk: true };
  const have = new Map((table.fields || []).map((f) => [f.name, f]));
  return {
    missing: spec.fields.filter((f) => !have.has(f.name)),
    wrongType: spec.fields
      .filter((f) => have.has(f.name) && have.get(f.name).type !== f.type)
      .map((f) => ({ name: f.name, want: f.type, have: have.get(f.name).type })),
    // A select rejects a value that is not one of its choices, and that is a
    // write-time 422 exactly like an unknown column - but invisible to a check
    // that only compares field names and types. Adding a status to the code
    // without adding the choice here fails the same way, and just as late.
    missingChoices: spec.fields.flatMap((f) => {
      const want = f.options?.choices?.map((c) => c.name);
      if (!want || !have.has(f.name)) return [];
      const has = new Set((have.get(f.name).options?.choices || []).map((c) => c.name));
      return want.filter((c) => !has.has(c)).map((c) => `${f.name}="${c}"`);
    }),
    // Airtable makes the first field primary and will not change it via the
    // API. If it is not `id`, upserts cannot match and rows will duplicate.
    primaryOk: table.fields?.[0]?.name === 'id',
  };
}
