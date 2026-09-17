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

## 3. Skill 02 — the writer

Skill 02 needs a model that follows a voice brief and returns structured JSON.
Several can, so the provider is a config choice:

| `COPY_PROVIDER` | Key | Notes |
|---|---|---|
| `gemini` *(default)* | `GEMINI_API_KEY` | **The same key skill 03 already needs.** No extra account, no extra billing. Defaults to `gemini-3.6-flash`. |
| `openai-compatible` | `OPENAI_API_KEY` + `OPENAI_BASE_URL` | OpenAI, Groq, DeepSeek, Together, OpenRouter, Mistral, or a local llama.cpp / Ollama server — they all speak this shape. |
| `anthropic` | `ANTHROPIC_API_KEY` | Uses the official SDK, lazily imported. |

Set `COPY_MODEL` to override the provider's default model.

Because the default is Gemini, **the whole machine needs only two keys**:
`APIFY_TOKEN` and `GEMINI_API_KEY`.

A note on structured output: the machine keeps one strict JSON Schema and
translates it per provider. Gemini's `responseSchema` rejects
`additionalProperties`, which OpenAI's strict mode requires — so the schema is
stripped for Gemini and sent verbatim to OpenAI. A compatible server that
implements `json_object` but not `json_schema` is detected and falls back to
putting the schema in the prompt, rather than failing.

## 4. Skill 03 — Gemini and ffmpeg

`GEMINI_API_KEY` from aistudio.google.com. The default image model is
`gemini-2.5-flash-image` ("nano banana"), falling back automatically to
`gemini-3-pro-image-preview`. The pro model is paid-tier and answers 429 on a
free key, so it is the fallback rather than the default.

ffmpeg needs to be a build **with libfreetype**, or captions are silently not
burned in (the machine warns and continues). Check:

```bash
ffmpeg -filters | grep drawtext
```

`apt install ffmpeg` and Homebrew's `ffmpeg` both include it. The pip
`imageio-ffmpeg` binary does **not**.

Captions also need a bold TTF. The machine looks for DejaVu, Liberation and
Arial in the usual places; set `CAPTION_FONT=/path/to/Bold.ttf` otherwise.

Voiceover is off by default, and off means **silent video**: the scripts still
carry a voiceover line per beat, but with no TTS it only sets how long each
frame holds. `doctor` says so explicitly.

The cheapest way to turn it on is `TTS_PROVIDER=gemini`, which narrates using
`GEMINI_API_KEY` - the same key that writes the copy and draws the pictures, so
there is no second account. It needs the paid tier, like image generation does.
Pick a voice with `TTS_VOICE_ID` (default `Kore`) and a model with `TTS_MODEL`
(default `gemini-2.5-flash-preview-tts`).

Otherwise: `TTS_PROVIDER=elevenlabs` plus `TTS_API_KEY` and `TTS_VOICE_ID`, or
`TTS_PROVIDER=openai-compatible` plus `TTS_BASE_URL`. With voiceover on, beat durations come from the real audio
length instead of a word-count estimate, so the captions stay in sync.

## 5. Skill 04 — a publisher

**Submagic** — `SUBMAGIC_API_KEY`, and set `PUBLISH_PROVIDER=submagic`.
Connect Instagram, TikTok and YouTube inside Submagic; the machine publishes to
whichever are connected and skips the rest.

Submagic fetches video by URL rather than accepting an upload, so each rendered
short is attached to a GitHub release first and published from there. On Actions
that needs nothing from you - the workflow grants itself `contents: write` and
uses the token Actions already provides. Note this makes the rendered videos
publicly downloadable from the repository's releases page, which is fine for
content that is about to be public anyway.

One Submagic project carries every platform for a video, so all platforms go out
at the same time - the earliest slot the machine picked - rather than staggered.
Three projects per video would triple usage to gain a two-hour spread.

**Metricool** — one account covers all three platforms and it schedules
natively. You need `METRICOOL_USER_TOKEN`, `METRICOOL_USER_ID` and
`METRICOOL_BLOG_ID` (the brand id). Set `PUBLISH_PROVIDER=metricool`.

**Unipile** — `UNIPILE_API_KEY`, `UNIPILE_DSN` and one account id per platform.
Set `PUBLISH_PROVIDER=unipile`. Unipile publishes immediately rather than
scheduling, so a future-dated post is held as `queued` and released by
`machine drain` when its slot comes due. The hourly cron runs that for you;
if you run the machine yourself rather than on Actions, you need `machine
drain` on a schedule too, or nothing queued will ever go out.

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
