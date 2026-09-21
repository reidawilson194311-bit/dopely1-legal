import fs from 'node:fs';
import path from 'node:path';

/** Minimal .env loader - no dependency, ignores a missing file. */
function loadDotenv(file = '.env') {
  const p = path.resolve(process.cwd(), file);
  if (!fs.existsSync(p)) return;
  for (const raw of fs.readFileSync(p, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}
loadDotenv();

/**
 * An unset GitHub Actions variable arrives as an EMPTY STRING, not as an absent
 * one - `FOO: ${{ vars.FOO }}` with no FOO set exports `FOO=`. `??` only falls
 * back on null/undefined, so every default below was being replaced by '' in
 * CI while working fine locally. That is how TTS_MODEL became '' and the
 * narration request went to `models/:generateContent`.
 *
 * num/bool/list already treat empty as absent; this brings env into line.
 */
export const env = (k, d = '') => {
  const v = process.env[k];
  return v === undefined || v === '' ? d : v;
};
const num = (k, d) => (process.env[k] ? Number(process.env[k]) : d);
const bool = (k, d = false) => (process.env[k] ? /^(1|true|yes|on)$/i.test(process.env[k]) : d);
const list = (k, d = []) =>
  process.env[k] ? process.env[k].split(',').map((s) => s.trim()).filter(Boolean) : d;

export const config = {
  /** Skip every paid call and use fixtures. Set by --dry-run too. */
  dryRun: bool('DRY_RUN', false),
  logLevel: env('LOG_LEVEL', 'info'),
  dataDir: env('DATA_DIR', './data'),
  outDir: env('OUT_DIR', './out'),

  /** Which platforms this machine publishes to. */
  platforms: list('PLATFORMS', ['instagram', 'tiktok', 'youtube']),

  store: {
    /** 'airtable' | 'json'. json needs no accounts and is the dry-run default. */
    driver: env('STORE_DRIVER', 'json'),
    airtable: {
      apiKey: env('AIRTABLE_API_KEY'),
      baseId: env('AIRTABLE_BASE_ID'),
      tables: {
        winners: env('AIRTABLE_TABLE_WINNERS', 'Winners'),
        scripts: env('AIRTABLE_TABLE_SCRIPTS', 'Scripts'),
        renders: env('AIRTABLE_TABLE_RENDERS', 'Renders'),
        posts: env('AIRTABLE_TABLE_POSTS', 'Posts'),
      },
    },
  },

  // ---- Skill 01: the researcher -------------------------------------------
  research: {
    apifyToken: env('APIFY_TOKEN'),
    actors: {
      instagram: env('APIFY_ACTOR_INSTAGRAM', 'apify~instagram-scraper'),
      tiktok: env('APIFY_ACTOR_TIKTOK', 'clockworks~tiktok-scraper'),
      youtube: env('APIFY_ACTOR_YOUTUBE', 'streamers~youtube-scraper'),
    },
    /** Posts per account to pull on each run. */
    postsPerAccount: num('RESEARCH_POSTS_PER_ACCOUNT', 12),
    /** Only consider posts published within this many days. */
    lookbackDays: num('RESEARCH_LOOKBACK_DAYS', 90),
    /** A post is a "winner" at >= this multiple of the account's median views. */
    viralMultiple: num('RESEARCH_VIRAL_MULTIPLE', 3),
    /** Hard floor so tiny accounts cannot produce winners on noise alone. */
    minViews: num('RESEARCH_MIN_VIEWS', 100000),
    /** Winners kept per run, best first. */
    keepTop: num('RESEARCH_KEEP_TOP', 40),
  },

  // ---- Skill 02: the copywriter -------------------------------------------
  copy: {
    /**
     * 'gemini' | 'openai-compatible' | 'anthropic'.
     * Defaults to Gemini because skill 03 already needs that key - writing the
     * scripts with it costs no extra account and no extra billing setup.
     */
    provider: env('COPY_PROVIDER', 'gemini'),
    /** Blank means the provider's own default model. */
    model: env('COPY_MODEL', ''),
    maxTokens: num('COPY_MAX_TOKENS', 8000),
    openai: {
      apiKey: env('OPENAI_API_KEY'),
      /** Any OpenAI-compatible server: Groq, DeepSeek, Together, Ollama... */
      baseUrl: env('OPENAI_BASE_URL', 'https://api.openai.com/v1'),
    },
    /** Anthropic only. */
    effort: env('ANTHROPIC_EFFORT', 'medium'),
    /**
     * Scripts to write per run. Matched to DESIGN_BATCH_SIZE on purpose: the
     * designer is the narrower stage, so writing more than it can render just
     * spends tokens on scripts that queue up forever. At 6/day the winners
     * table also drained faster than the weekly researcher refilled it.
     */
    batchSize: num('COPY_BATCH_SIZE', 4),
    /** Beats (= generated images) per short. 5-7 reads well at 30-45s. */
    beatsPerScript: num('COPY_BEATS', 6),
  },

  // ---- Skill 03: the designer ---------------------------------------------
  design: {
    /**
     * Which service draws the pictures: 'gemini' | 'higgsfield'.
     * The designer does not care which; both expose generateImage.
     */
    imageProvider: env('IMAGE_PROVIDER', 'gemini'),
    higgsfield: {
      baseUrl: env('HIGGSFIELD_BASE_URL', 'https://api.higgsfield.ai'),
      /** Auth is a key PAIR, not a single bearer token. */
      keyId: env('HIGGSFIELD_KEY_ID'),
      keySecret: env('HIGGSFIELD_KEY_SECRET'),
      imageModel: env('HIGGSFIELD_IMAGE_MODEL', 'flux-pro/kontext/max/text-to-image'),
      aspectRatio: env('HIGGSFIELD_ASPECT_RATIO', '9:16'),
      pollMs: num('HIGGSFIELD_POLL_MS', 4000),
      readyTimeoutMs: num('HIGGSFIELD_READY_TIMEOUT_MS', 300000),
    },
    /** Google's "nano banana" image model. */
    geminiApiKey: env('GEMINI_API_KEY'),
    // gemini-2.5-flash-image IS nano banana, and it answers on a free key.
    // gemini-3-pro-image-preview is paid-tier and returns 429, so it was
    // costing a failed call plus the retry ladder on every single image
    // before the fallback got a turn. Cheap one first, pro as the fallback.
    imageModel: env('GEMINI_IMAGE_MODEL', 'gemini-2.5-flash-image'),
    imageFallbackModel: env('GEMINI_IMAGE_FALLBACK_MODEL', 'gemini-3-pro-image-preview'),
    /** Art direction applied to every generated frame. */
    styleKey: env('DESIGN_STYLE', 'editorial-bold'),
    width: num('VIDEO_WIDTH', 1080),
    height: num('VIDEO_HEIGHT', 1920),
    fps: num('VIDEO_FPS', 30),
    ffmpeg: env('FFMPEG_PATH', 'ffmpeg'),
    ffprobe: env('FFPROBE_PATH', 'ffprobe'),
    /** Voiceover: 'none' | 'elevenlabs' | 'openai-compatible' */
    /**
     * Narration on by default. It used to be 'none', which rendered silent
     * video and said nothing about it - and a repo variable cannot be set
     * from outside the settings page, so the default is the only lever that
     * reaches the scheduled runs.
     */
    ttsProvider: env('TTS_PROVIDER', 'gemini'),
    ttsApiKey: env('TTS_API_KEY'),
    ttsVoiceId: env('TTS_VOICE_ID', ''),
    /** Gemini's TTS model. Free tier cannot reach it; the paid tier can. */
    ttsModel: env('TTS_MODEL', 'gemini-2.5-flash-preview-tts'),
    ttsBaseUrl: env('TTS_BASE_URL', ''),
    musicFile: env('MUSIC_FILE', ''),
    musicVolume: num('MUSIC_VOLUME', 0.12),
    batchSize: num('DESIGN_BATCH_SIZE', 4),
  },

  /** Somewhere public to put a rendered video, for publishers that need a URL. */
  host: {
    githubToken: env('GITHUB_TOKEN'),
    repo: env('GITHUB_REPOSITORY'),
    releaseTag: env('HOST_RELEASE_TAG', 'rendered-shorts'),
  },

  // ---- Skill 04: the poster -----------------------------------------------
  post: {
    /** 'submagic' | 'metricool' | 'unipile' | 'none' */
    provider: env('PUBLISH_PROVIDER', 'submagic'),
    /**
     * Where to PUBLISH, which is not the same question as where to SCRAPE.
     * `platforms` above is the research set - all three, because all three
     * are worth learning from. This is the set actually connected inside the
     * publisher, and sending to an unconnected one fails the post. Widen it
     * as connections are added.
     */
    platforms: list('PUBLISH_PLATFORMS', ['youtube']),
    submagic: {
      apiKey: env('SUBMAGIC_API_KEY'),
      language: env('SUBMAGIC_LANGUAGE', 'en'),
      tiktokPrivacy: env('SUBMAGIC_TIKTOK_PRIVACY', 'public'),
      pollMs: num('SUBMAGIC_POLL_MS', 5000),
      readyTimeoutMs: num('SUBMAGIC_READY_TIMEOUT_MS', 900000),
    },
    metricool: {
      token: env('METRICOOL_USER_TOKEN'),
      userId: env('METRICOOL_USER_ID'),
      blogId: env('METRICOOL_BLOG_ID'),
    },
    unipile: {
      apiKey: env('UNIPILE_API_KEY'),
      dsn: env('UNIPILE_DSN'),
      accounts: {
        instagram: env('UNIPILE_ACCOUNT_INSTAGRAM'),
        tiktok: env('UNIPILE_ACCOUNT_TIKTOK'),
        youtube: env('UNIPILE_ACCOUNT_YOUTUBE'),
      },
    },
    /**
     * Distinct videos to publish per run. Each one is cross-posted to every
     * platform, so 2 here means 2 posts per account per day, not 6.
     */
    perRun: num('PUBLISH_PER_RUN', 2),
    /** Ramp up to this rate over `rampDays`, so a new account starts slow. */
    rampTo: num('PUBLISH_RAMP_TO', 4),
    rampDays: num('PUBLISH_RAMP_DAYS', 21),
    /** IANA timezone the slot table below is expressed in. */
    timezone: env('PUBLISH_TIMEZONE', 'America/New_York'),
    /** Local-time slots per platform, best-first. */
    slots: {
      instagram: list('SLOTS_INSTAGRAM', ['11:00', '19:00']),
      tiktok: list('SLOTS_TIKTOK', ['09:00', '18:00', '21:00']),
      youtube: list('SLOTS_YOUTUBE', ['12:00', '17:00']),
    },
    /** Never schedule sooner than this many minutes from now. */
    leadMinutes: num('PUBLISH_LEAD_MINUTES', 45),
    /** Days ahead the scheduler is allowed to fill. */
    horizonDays: num('PUBLISH_HORIZON_DAYS', 7),
  },
};

export function applyCliOverrides(flags = {}) {
  if (flags.dryRun) {
    config.dryRun = true;
    config.store.driver = 'json';
  }
  if (flags.limit) {
    config.copy.batchSize = flags.limit;
    config.design.batchSize = flags.limit;
    config.post.perRun = flags.limit;
  }
  if (flags.platforms) config.platforms = flags.platforms;
  if (flags.verbose) config.logLevel = 'debug';
  return config;
}

export default config;
