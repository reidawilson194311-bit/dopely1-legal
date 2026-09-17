# Running the machine

Setup gets it working once. This is about keeping it working — what a normal
week looks like, what to check, what quiet failure looks like, and which knobs
are worth turning.

---

## A normal week

| When (UTC) | What fires | What it does |
|---|---|---|
| Mon 06:00 | `research` | Scrapes the seed accounts, writes ~40 winners |
| Daily 07:00 | `write,design,post` | 4 scripts → 4 renders → schedules the day's videos |
| Hourly :30 | `drain` | Publishes due queued posts. **No-op unless `PUBLISH_PROVIDER=unipile`** |

Everything else is the platforms posting at their slot times. You do nothing.

## Throughput, and why the defaults are what they are

The stages have different capacities, and the narrow one sets the pace:

```
  01 research   40 winners/week   (weekly, RESEARCH_KEEP_TOP=40)
  02 write      28 scripts/week   (daily x COPY_BATCH_SIZE=4)
  03 design     28 renders/week   (daily x DESIGN_BATCH_SIZE=4)
  04 post       14 -> 28 /week    (daily, ramp PUBLISH_PER_RUN=2 -> PUBLISH_RAMP_TO=4)
```

That leaves a ~12/week buffer of winners and no pile-up anywhere. If you raise
one number, raise the ones feeding it too, or you will either starve a stage or
generate work that queues forever. The two failure shapes:

- **Writing more than you render** spends tokens on scripts nobody ever sees.
- **Writing more than research supplies** drains the winners table, and skill 02
  starts idling — which looks identical to "nothing to do".

Check the balance any time with `node src/cli.js status`.

## What to check, and how often

**Weekly, five minutes.** Open the Posts table on a calendar view. Are posts
landing in their slots? Then `machine status` — are the tables draining or
piling up? Then look at two or three of the week's videos as a viewer would.

**Monthly.** Re-read `src/niche.js`. The seed accounts drift; accounts that were
good references a month ago may have changed format or died. Swap in better
ones — that file is the whole niche.

**Whenever a platform says anything.** A warning, a strike, a reach collapse.
The machine cannot see those and will keep posting regardless.

## Quiet failure — the thing to actually worry about

A machine with nobody home fails silently far more often than it fails loudly.
Two shapes, both of which look like a green run:

**Nothing to do.** A stage with an empty input logs a warning and exits clean,
because that is a legitimate state. Sustained, it means an upstream stage
stopped feeding it. `machine status` is how you tell "quiet" from "stalled":
a healthy pipeline has non-zero counts moving through every table week to week.

**Scheduled but never posted.** On Unipile, posts sit `queued` until the hourly
drain publishes them. If that cron stops firing, the schedule fills and nothing
goes out. Watch for `queued` rows in the Posts table whose `publishAt` is in the
past — that is the signature, and it cannot happen on Metricool.

Loud failures are easier: the run goes red, and GitHub emails you. A stage that
attempted work and failed at every item fails the run deliberately, so this is
the case you will hear about.

## Stopping it

In order of speed:

1. **Set the `PUBLISH_PROVIDER` variable to `none`.** Takes effect on the next
   run. Everything keeps generating; nothing gets published.
2. **Actions → the machine → ⋯ → Disable workflow.** Stops all three crons.
3. **Already-scheduled posts still fire.** Metricool holds them on its own
   schedule, so cancel those in Metricool, not here. This is the one that
   surprises people.

## Costs, and how they scale

- **Apify** — per run, not per post. Weekly research is the whole bill. Raising
  `RESEARCH_POSTS_PER_ACCOUNT` or adding seed accounts raises it linearly.
- **Gemini** — per script and per image. 7 images per short dominates. Free tier
  covers the default rate; a big ramp is what would change that.
- **Publisher** — flat monthly.
- **GitHub Actions** — free on public repos. On a private repo the hourly drain
  is the only meaningful consumer, and only on Unipile; widen that cron or
  switch to Metricool if minutes get tight.

## The knobs worth turning

| Want | Change |
|---|---|
| Post more often | `PUBLISH_RAMP_TO`, and raise `DESIGN_BATCH_SIZE` + `COPY_BATCH_SIZE` to match |
| Better reference material | `src/niche.js` seed accounts — the highest-leverage file here |
| Different voice | `NICHE.voice` rules and `banned_phrases` |
| Fewer, better scripts | Lower `COPY_BATCH_SIZE`; raise `RESEARCH_VIRAL_MULTIPLE` so only bigger outliers qualify |
| Different look | `DESIGN_STYLE` (`editorial-bold`, `flat-graphic`, `retro-print`) |
| A voiceover | `TTS_PROVIDER` — also makes beat timing follow real audio instead of a word-count estimate |
| Post at different times | `PUBLISH_TIMEZONE` and the `SLOTS_*` lists |

## Judging whether it is actually working

Uptime is not the metric. The machine will happily publish mediocre videos
forever. Worth tracking by hand, monthly:

- **Are any posts outperforming the others, and why?** The `pillar` field on
  Renders is there so you can tell which content type is carrying.
- **Is anything landing at all?** If every video does the same flat number,
  the problem is upstream — usually the seed accounts, not the machine.
- **Would you post it yourself?** The overlap guard stops plagiarism and the
  `sourceNote` flags unsourceable claims, but neither is a taste check. That is
  still yours, and it is the reason to look at the output even when nothing is
  broken.
