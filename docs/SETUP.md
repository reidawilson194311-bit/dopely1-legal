# Setup

The machine runs with **zero accounts** in dry-run mode. Add credentials one
skill at a time; each one you add turns on one more stage for real.

```bash
npm install
npm run demo          # full pipeline, fixtures, no spend
node src/cli.js doctor   # what is still missing
```

---

## 1. Pick a store

**`STORE_DRIVER=json`** (default) keeps everything in `./data/*.json`. No
accounts, and perfectly fine for a single-operator machine.

**`STORE_DRIVER=airtable`** if you want to see and edit the pipeline in a
shared base. Create a base with four tables and the fields in
[AIRTABLE_SCHEMA.md](./AIRTABLE_SCHEMA.md), then set `AIRTABLE_API_KEY`
(a personal access token with `data.records:read` + `data.records:write`) and
`AIRTABLE_BASE_ID` (the `app...` id in the base URL).

## 2. Skill 01 — Apify

Sign up at apify.com, then **Settings → Integrations → API tokens**. Set
`APIFY_TOKEN`.

The three default actors are paid-per-result. Budget roughly:
`accounts x RESEARCH_POSTS_PER_ACCOUNT` results per run — about 480 with the
shipped seed lists. The researcher is the stage to run *weekly*, not hourly;
the winners table is an asset that accumulates.

Swap actors with `APIFY_ACTOR_INSTAGRAM` / `_TIKTOK` / `_YOUTUBE` if you prefer
different ones — you only need to adjust `actorInput` in `src/lib/apify.js`
and the matching normalizer in `src/lib/normalize.js`.

## 3. Skill 02 — Claude

`ANTHROPIC_API_KEY` from console.anthropic.com, or run `ant auth login` and
leave the variable unset — the SDK finds the profile either way.

Defaults to `claude-opus-5` at `medium` effort. Scripts are short; this is the
cheapest stage in the machine by a wide margin. Drop to
`ANTHROPIC_EFFORT=low` if you are writing dozens a day.

## 4. Skill 03 — Gemini and ffmpeg

`GEMINI_API_KEY` from aistudio.google.com. The default image model is
`gemini-3-pro-image-preview` ("nano banana"), falling back automatically to
`gemini-2.5-flash-image`.

ffmpeg needs to be a build **with libfreetype**, or captions are silently not
burned in (the machine warns and continues). Check:

```bash
ffmpeg -filters | grep drawtext
```

`apt install ffmpeg` and Homebrew's `ffmpeg` both include it. The pip
`imageio-ffmpeg` binary does **not**.

Captions also need a bold TTF. The machine looks for DejaVu, Liberation and
Arial in the usual places; set `CAPTION_FONT=/path/to/Bold.ttf` otherwise.

Voiceover is off by default. Turn it on with `TTS_PROVIDER=elevenlabs` plus
`TTS_API_KEY` and `TTS_VOICE_ID`, or `TTS_PROVIDER=openai-compatible` plus
`TTS_BASE_URL`. With voiceover on, beat durations come from the real audio
length instead of a word-count estimate, so the captions stay in sync.

## 5. Skill 04 — a publisher

**Metricool** — one account covers all three platforms and it schedules
natively. You need `METRICOOL_USER_TOKEN`, `METRICOOL_USER_ID` and
`METRICOOL_BLOG_ID` (the brand id). Set `PUBLISH_PROVIDER=metricool`.

**Unipile** — `UNIPILE_API_KEY`, `UNIPILE_DSN` and one account id per platform.
Unipile publishes immediately rather than scheduling, so anything dated in the
future stays queued locally and goes out on a later run that reaches its slot.
Set `PUBLISH_PROVIDER=unipile`.

Leave `PUBLISH_PROVIDER=none` to build a schedule without publishing — the
`posts` table fills up and you can review it before wiring a provider.

> Both providers' request shapes are implemented against their published APIs
> in `src/lib/publishers/`. If either changes theirs, that one file is the only
> thing to update — and `--dry-run` skips it entirely.

## 6. Connect the accounts

Each platform needs the posting account authorised inside your chosen
publisher. TikTok in particular requires the app to be approved for Content
Posting before scheduled posts appear publicly rather than as drafts.

---

## Running it

A run exits non-zero if any stage fails, including a stage that attempted work
and errored on every item — that case is deliberately distinguished from a
stage that simply had nothing to do, so an unattended cron cannot report
success while quietly producing nothing.

```bash
node src/cli.js run                 # everything
node src/cli.js research            # 01 only - weekly is plenty
node src/cli.js run --stages=write,design,post
node src/cli.js status              # what is sitting in each table
node src/cli.js run --dry-run       # rehearse, no spend
```

`.github/workflows/machine.yml` runs the researcher weekly and the
write → design → post loop daily. Add the credentials as repository secrets.

Until the secrets for a given stage set exist, the scheduled runs **skip
themselves** with a notice rather than failing — otherwise every cron would
fail and email you daily, which trains you to ignore the one notification that
matters once the machine is live. A manual run with `dry_run` always proceeds,
since it needs no credentials.

The workflow uses the flat-file store by default. Set a `STORE_DRIVER`
repository variable to `airtable` once your base exists.

## Cost shape

Per published short, roughly:

- Apify: amortised across the run — the researcher feeds many scripts
- Claude: one short structured call
- Gemini: 7 images (hook frame + 6 beats)
- TTS: ~45 seconds of audio, if enabled
- Publisher: a flat monthly fee

The researcher is the stage with a per-run cost that does not scale with
output, which is exactly why it runs weekly and the rest run daily.

## Changing the niche

Everything niche-specific lives in `src/niche.js`: seed accounts, hashtags,
voice rules, content pillars, exclusions. The other four files do not know what
the niche is. Rewrite that one file and the same machine points somewhere else.
