# Airtable schema

Only needed when `STORE_DRIVER=airtable`. With the default `json` driver the
machine creates its own files and you can skip this entirely.

## Build it with one command

```bash
export AIRTABLE_API_KEY=pat...        # needs schema.bases:read + schema.bases:write
export AIRTABLE_BASE_ID=app...        # or AIRTABLE_WORKSPACE_ID + --create
node scripts/setup-airtable.js --dry-run   # show what it would do
node scripts/setup-airtable.js
```

`scripts/airtable-schema.js` is the source of truth; the tables below document
what it builds. The script is idempotent — re-run it after a schema change and
it adds what is missing. It never deletes or retypes an existing field.

To create the base as well as its tables, pass `--create` with
`AIRTABLE_WORKSPACE_ID` (the `wsp...` in your workspace URL) and give the token
`workspace.bases:write`.

---

## Building it by hand

Create one base with four tables. **Every table needs a single line text field
named exactly `id`** — that is the machine's own key, and it is what makes a
run resumable without duplicating rows. Object and array fields are stored as
JSON in long text fields and parsed back on read.

Field names are case-sensitive and must match exactly.

## `Winners` — written by skill 01

| Field | Type |
|---|---|
| `id` | Single line text |
| `platform` | Single select: instagram, tiktok, youtube |
| `account` | Single line text |
| `url` | URL |
| `caption` | Long text |
| `hook` | Long text |
| `views` | Number (integer) |
| `likes` | Number (integer) |
| `comments` | Number (integer) |
| `shares` | Number (integer) |
| `durationSec` | Number |
| `postedAt` | Date (include time) |
| `accountMedian` | Number (integer) |
| `viralMultiple` | Number (2 decimals) |
| `engagementRate` | Number (4 decimals) |
| `viralScore` | Number (3 decimals) |
| `thumbnailUrl` | URL |
| `niche` | Single line text |
| `status` | Single select: winner, used, rejected-overlap, rejected-declined |
| `scrapedAt` | Date (include time) |

Sort a grid view by `viralScore` descending and you have the shopping list.

## `Scripts` — written by skill 02

| Field | Type |
|---|---|
| `id` | Single line text |
| `sourceWinnerId` | Single line text |
| `sourcePlatform` | Single line text |
| `sourceUrl` | URL |
| `title` | Single line text |
| `slug` | Single line text |
| `pillar` | Single select (the pillar ids from `src/niche.js`) |
| `hook` | Long text |
| `beats` | Long text (JSON array) |
| `cta` | Long text |
| `captions` | Long text (JSON object) |
| `hashtags` | Long text (JSON object) |
| `youtubeTitle` | Single line text |
| `sourceNote` | Long text |
| `estimatedDurationSec` | Number |
| `overlapRatio` | Number (3 decimals) |
| `niche` | Single line text |
| `status` | Single select: ready-to-design, designed, needs-encode, design-failed |
| `writtenAt` | Date (include time) |

`sourceNote` is worth a column of its own in any view you actually read — it is
where the model says whether the central claim is checkable.

## `Renders` — written by skill 03

| Field | Type |
|---|---|
| `id` | Single line text |
| `scriptId` | Single line text |
| `title` | Single line text |
| `slug` | Single line text |
| `pillar` | Single line text |
| `dir` | Single line text |
| `frames` | Long text (JSON array of paths) |
| `videoPath` | Single line text |
| `durationSec` | Number |
| `hasAudio` | Checkbox |
| `captions` | Long text (JSON object) |
| `hashtags` | Long text (JSON object) |
| `youtubeTitle` | Single line text |
| `cta` | Long text |
| `niche` | Single line text |
| `status` | Single select: ready-to-post, needs-encode, posted, partially-posted, post-failed |
| `renderedAt` | Date (include time) |

`videoPath` is a path on the machine that rendered it. Airtable will not fetch
it — the poster uploads the file to the publisher itself.

## `Posts` — written by skill 04

| Field | Type |
|---|---|
| `id` | Single line text |
| `renderId` | Single line text |
| `scriptId` | Single line text |
| `platform` | Single select: instagram, tiktok, youtube |
| `title` | Single line text |
| `caption` | Long text |
| `youtubeTitle` | Single line text |
| `videoPath` | Single line text |
| `publishAt` | Date (include time, GMT) |
| `publishAtLocal` | Single line text |
| `timezone` | Single line text |
| `provider` | Single select: metricool, unipile, local-queue |
| `externalId` | Single line text |
| `status` | Single select: scheduled, schedule-failed |
| `error` | Long text |

A calendar view on `publishAt` is the "posts every day, forever" screen.

## Automation note

The store writes with `typecast: true`, so single-select options are created on
the fly rather than erroring — you do not have to pre-populate every status
value by hand.
