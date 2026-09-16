# The machine

An autonomous short-form content system for **Instagram Reels, TikTok and
YouTube Shorts**, in the niche of **general popular content** — surprising
facts, how-things-work, human behaviour, money and life mechanics.

```
  01 SCRAPE  ->  02 REWORD  ->  03 DESIGN  ->  04 POST
  copies what    relaunders     spins up       auto-posts
  already went   the idea       the visuals    on a schedule
  viral
                        0 HUMANS
```

Four skills. The researcher finds posts that already beat their own account's
median. The copywriter takes the *idea* and rewrites it as an original script.
The designer generates every frame and encodes a vertical video. The poster
schedules it across all three platforms. Nobody approves it. Nobody is home.

Full walkthrough of each stage: **[docs/SYSTEM.md](docs/SYSTEM.md)**.

---

## Try it without an account

```bash
npm install
npm run demo
```

That runs the entire pipeline against fixtures — scrapes 40 synthetic winners,
writes scripts, generates placeholder frames, encodes real 1080x1920 MP4s into
`./out/`, and builds a posting schedule in `./data/`. No keys, no spend,
nothing goes live.

```
  stage        this run   total
  01 SCRAPE        40       40
  02 REWORD         2        2
  03 DESIGN         2        2
  04 POST           6        6

  0 humans. 17.6s.
```

## Going live

```bash
cp .env.example .env      # fill in what you have
node src/cli.js doctor    # tells you what is still missing
node src/cli.js run
```

Each credential you add turns on one more stage for real; everything else keeps
running on fixtures. Step-by-step: **[docs/SETUP.md](docs/SETUP.md)**.

| Stage | Needs | Cost shape |
|---|---|---|
| 01 researcher | Apify | per run, not per post — run it weekly |
| 02 copywriter | Anthropic (Claude) | one short call per script |
| 03 designer | Gemini image model + ffmpeg | 7 images per short |
| 04 poster | Metricool or Unipile | flat monthly |
| store | nothing, or Airtable | — |

## Commands

```bash
node src/cli.js run                          # the whole loop
node src/cli.js run --stages=write,design    # part of it
node src/cli.js research                     # one skill
node src/cli.js status                       # what is in each table
node src/cli.js doctor                       # check credentials and tooling
node src/cli.js run --dry-run --limit=2      # rehearse
```

Flags: `--dry-run`, `--limit=N`, `--platforms=instagram,tiktok`, `--verbose`.

## Layout

```
src/
  niche.js              the only niche-specific file
  config.js             every setting, one place
  machine.js            the orchestrator
  cli.js
  skills/
    01-researcher.js    scrape -> score -> winners
    02-copywriter.js    winners -> Claude -> scripts
    03-designer.js      scripts -> images -> MP4
    04-poster.js        MP4 -> schedule -> platforms
  lib/
    apify.js normalize.js score.js      01
    claude.js                           02
    nanobanana.js tts.js video.js       03
    schedule.js publishers/             04
    store/                              json + airtable
docs/
  SYSTEM.md             what each skill does and why
  SETUP.md              accounts, keys, running it
  AIRTABLE_SCHEMA.md    tables and fields
```

## Changing the niche

Everything niche-specific lives in `src/niche.js` — seed accounts, hashtags,
voice rules, content pillars, exclusions. The four skills do not know what the
niche is. Rewrite that one file and the same machine points somewhere else.

## Scheduling

`.github/workflows/machine.yml` runs the researcher weekly and
write → design → post daily, uploading each run's shorts as an artifact. Add
your keys as repository secrets; until they exist the scheduled runs skip
themselves with a notice instead of failing daily. A cron job or any scheduler
works the same way — the stages are decoupled and idempotent, so it does not
matter which one runs when.

## What it deliberately will not do

- **Republish anyone's words.** Skill 02 rejects any script whose word trigrams
  overlap its source by more than 15%. The idea transfers; the execution does
  not.
- **Invent citations.** Every script carries a `sourceNote` saying where the
  central claim comes from, or saying plainly that it cannot be sourced.
- **Touch the excluded topics.** Medical/legal/financial instruction, named
  private individuals, elections, conspiracy claims and anything needing a
  content warning are refused at the prompt, in `src/niche.js`.
- **Generate a face.** Image prompts forbid text, logos and recognisable
  people.

The machine is unattended by design, which is exactly why those limits are in
the code rather than in a habit.

## Tests

```bash
npm test
```

Covers the parts that fail silently: per-account viral scoring, the trigram
overlap guard, each platform's field normalisation, the ffmpeg filtergraph
(frame counts, per-line captions, audio wiring), caption composition and limits,
and DST-correct slot scheduling.

---

This repository also hosts the Dopely1 Uploader legal pages (`index.html`,
`terms.html`, `privacy.html`), which are served as a static site and are
required for platform API review. They are unrelated to the machine and are
left untouched by it.
