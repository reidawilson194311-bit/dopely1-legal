# The machine, one screen

```
                        01 SCRAPE
                  copies what already went viral
                              |
        04 POST  <--  0 HUMANS  -->  02 REWORD
   auto-posts on a       nobody is        relaunders
      schedule            home             the idea
                              |
                        03 DESIGN
                     spins up the visuals
```

Four skills. Each reads a table, writes a table, and does not care when the one
before it ran. That decoupling is the whole design: the researcher can run
weekly, the poster every few hours, and a stage that fails just leaves its
input sitting in the store for the next run to pick up.

---

## Skill 01 / The researcher — "It goes shopping."

```
  top accounts, any niche  ->  Apify  ->  scored winners
```

Reads the seed accounts in `src/niche.js` across Instagram, TikTok and YouTube
Shorts, pulls their recent posts through Apify, and keeps the outliers.

**It does not guess what works. It copies what already did.**

The scoring is the part that matters. A raw view count only tells you how big
an account is, so every post is scored against **the median of its own
account**:

```
viralMultiple = post.views / median(views of that account's recent posts)
viralScore    = viralMultiple x (1 + 4 x engagementRate) x recencyWeight
```

A 1M-view post on an account that always does 1M is not a signal. A 900K post
on an account that usually does 100K is. A post must clear both
`RESEARCH_VIRAL_MULTIPLE` (default 3x) and an absolute floor
`RESEARCH_MIN_VIEWS` (default 100K), so a tiny account cannot manufacture
winners out of noise.

Writes: **winners**.

## Skill 02 / The copywriter — "It launders the idea."

```
  NODE 1  INPUT   reads the winners
  NODE 2  ENGINE  rewrite + voice-match
  NODE 3  OUTPUT  a new script table
```

The writer takes one winner and writes a *new* short-form video script: a hook, six
beats (on-screen text + voiceover + an image prompt), a caption per platform,
hashtags per platform, and a YouTube title.

What transfers from the reference post is the **idea** — the curiosity gap, the
reversal, the surprising number. What does not transfer is the wording.
Republishing someone's script is both a copyright problem and a
duplicate-content problem, so the output is checked before it is saved:

> `overlapRatio` measures the share of the output's **word trigrams** that also
> appear in the source. Anything over 0.15 is rejected and the winner is marked
> `rejected-overlap`.

Trigrams, not a bag of words — two scripts about the same subject legitimately
share nouns, and every English sentence shares "the" and "is". A shared run of
three consecutive words is the thing actually being forbidden, and it almost
never happens by chance.

The provider is configurable (`COPY_PROVIDER`): Gemini by default, since
skill 03 already needs that key; any OpenAI-compatible endpoint; or Anthropic.
One strict JSON Schema is kept and translated per provider, rather than three
schemas that can drift apart.

**Two guards, asking different questions.** The trigram check above asks *did
we copy the source's wording*. A second check asks *is this the same idea we
already covered* — which survives a complete rewrite, since two scripts can
share no phrasing at all and both still be about house dust being dead skin.
That one compares the **title**, the claim itself, as an order-blind overlap of
content words, and it runs twice: once on the source winner before a generation
call is spent, and once on the finished script, against a set that grows during
the batch so two scripts written minutes apart cannot both go out.

Rejected sources are marked `rejected-duplicate` and the run continues. If every
item in a batch is rejected, the stage fails rather than reporting a clean run.

Writes: **scripts**. Marks each source winner `used`.

## Skill 03 / The designer — "It makes the visuals."

```
  INPUT   reads the copy table
  ENGINE  nano banana turns each row of copy into an image
  OUTPUT  a 1080x1920 MP4
```

**No designer. No camera. No face.**

Each beat's `imagePrompt` goes to Gemini's image model with a fixed style
preamble (so a set of frames looks like one set) and hard guardrails: no text,
no logos, no recognisable people. The hook gets its own frame, so the first
1.5 seconds are doing the work rather than a title card nobody reads.

ffmpeg then assembles the stills into a vertical short: a slow push-in per
frame so it reads as video rather than a slideshow, captions burned into the
lower third where neither the Reels UI nor the Shorts UI covers them, optional
voiceover and music bed.

Two things about the encode are load-bearing:

- **Each still is fed as one frame, not looped.** `zoompan`'s `d` is output
  frames *per input frame* — feeding it a looped 5-second still asks for
  `125 x d` frames and the encode effectively never finishes.
- **Captions are one `drawtext` per wrapped line.** drawtext's own
  `text_align` only exists in ffmpeg 7+, and multi-line text without it renders
  left-aligned inside a centred box. Per-line is portable and correctly centred
  on every build.

The storyboard PNGs are kept alongside the MP4, so the same run can also feed
an Instagram carousel if you want both formats.

Writes: **renders**.

## Skill 04 / The poster — "It posts itself."

```
  INPUT   takes the finished posts
  ENGINE  auto-post, on a schedule
  OUTPUT  every day, forever
```

**Nobody approves it. Nobody is home.**

Composes a caption per platform (body + CTA + hashtags, trimmed to each
platform's limit), picks the next free slot per platform from the slot table,
and hands the video to Metricool or Unipile.

**Rate ramp.** `PUBLISH_PER_RUN` counts *distinct videos*, each cross-posted to
every platform — 2 means 2 posts per account per day, not 6. The rate climbs
from there to `PUBLISH_RAMP_TO` over `PUBLISH_RAMP_DAYS`, because an account
that opens at full cadence reads as a bot. The clock runs from the first post
the machine ever scheduled, so the ramp survives restarts and gaps — it is a
property of the account's history, not of the process.

**The drain.** Not every publisher can schedule ahead. Metricool takes a
publication date and owns the post from that moment. Unipile publishes
immediately and has no concept of "later", so a future-dated post is held in
the posts table as `queued` and released by `machine drain` once its slot comes
due. The hourly cron in `machine.yml` runs it, and skips itself entirely unless
`PUBLISH_PROVIDER=unipile`.

A queued post that fails to upload stays `queued` and is retried on the next
drain rather than being silently dropped; only a successful upload moves it to
`published`.

Slots are real local times in `PUBLISH_TIMEZONE`, converted through `Intl` so
daylight saving is handled — a machine that posts an hour late for half the
year is a machine nobody trusts. Slots already taken by earlier runs are never
double-booked.

Writes: **posts**. Marks each render `posted` / `partially-posted`.

---

## Tables

| Table | Written by | Key fields |
|---|---|---|
| `winners` | 01 | `platform`, `url`, `views`, `viralMultiple`, `viralScore`, `hook`, `status` |
| `scripts` | 02 | `hook`, `beats[]`, `captions{}`, `hashtags{}`, `overlapRatio`, `status` |
| `renders` | 03 | `videoPath`, `frames[]`, `durationSec`, `status` |
| `posts`   | 04 | `platform`, `publishAt`, `caption`, `provider`, `externalId`, `status` |

Status is what makes a stage resumable. A row only moves forward when the next
stage has actually taken it, so an interrupted run resumes instead of
duplicating.

```
winners:  winner -> used | rejected-overlap | rejected-declined
scripts:  ready-to-design -> designed | needs-encode | design-failed
renders:  ready-to-post -> posted | partially-posted | post-failed
posts:    scheduled | schedule-failed
```
