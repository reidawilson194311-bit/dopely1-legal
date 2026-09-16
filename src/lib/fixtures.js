/**
 * Deterministic fake data so `--dry-run` exercises the real code paths - the
 * same normalizers, the same scorer, the same store writes - without spending
 * a cent on Apify, Claude, Gemini or a publisher.
 */

const HOOKS = [
  'Your brain deletes memories on purpose.',
  'Airport carpets are ugly for a reason.',
  'Honey found in Egyptian tombs was still edible.',
  'The person who invented the Pringles can is buried in one.',
  'Sharks existed before trees did.',
  'Your phone charger draws power even when nothing is plugged in.',
  'Cleopatra lived closer to the Moon landing than to the pyramids.',
  'Bananas are radioactive, and that is fine.',
  'Wombat poo is cube shaped, and there is a reason.',
  'The shortest war in history lasted 38 minutes.',
  'Your stomach lining replaces itself every four days.',
  'Venus has days longer than its years.',
  'Most of the dust in your house used to be you.',
  'Nobody knows who invented the fire hydrant.',
  'Oxford University is older than the Aztec Empire.',
  'A day on Earth used to be 22 hours long.',
];

/** Small deterministic PRNG so repeat dry-runs produce identical output. */
function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

const hash = (str) => {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
};

export function fakeScrape(platform, handles, perAccount) {
  const items = [];
  for (const handle of handles) {
    const rand = rng(hash(platform + handle));
    const base = 40000 + Math.floor(rand() * 400000);
    for (let i = 0; i < perAccount; i++) {
      // One post in six is a genuine outlier, the rest sit around the median.
      const outlier = i % 6 === 0;
      const views = Math.round(base * (outlier ? 6 + rand() * 12 : 0.5 + rand()));
      const hook = HOOKS[Math.floor(rand() * HOOKS.length)];
      const daysAgo = Math.floor(rand() * 75);
      const postedAt = new Date(Date.now() - daysAgo * 86400000).toISOString();
      const url = `https://example.invalid/${platform}/${handle.replace(/^@/, '')}/${i}`;
      items.push(
        shape(platform, {
          url,
          handle: handle.replace(/^@/, ''),
          caption: `${hook} #facts #didyouknow`,
          views,
          likes: Math.round(views * (0.03 + rand() * 0.06)),
          comments: Math.round(views * (0.001 + rand() * 0.004)),
          shares: Math.round(views * (0.002 + rand() * 0.008)),
          postedAt,
          duration: 18 + Math.floor(rand() * 40),
        }),
      );
    }
  }
  return items;
}

/** Re-dress the common fields into each actor's native output shape. */
function shape(platform, f) {
  if (platform === 'instagram') {
    return {
      url: f.url, ownerUsername: f.handle, caption: f.caption,
      videoPlayCount: f.views, likesCount: f.likes, commentsCount: f.comments,
      videoDuration: f.duration, timestamp: f.postedAt, type: 'Video',
      displayUrl: `${f.url}/thumb.jpg`,
    };
  }
  if (platform === 'tiktok') {
    return {
      webVideoUrl: f.url, authorMeta: { name: f.handle }, text: f.caption,
      playCount: f.views, diggCount: f.likes, commentCount: f.comments,
      shareCount: f.shares, videoMeta: { duration: f.duration, coverUrl: `${f.url}/cover.jpg` },
      createTimeISO: f.postedAt,
    };
  }
  return {
    url: f.url, channelName: f.handle, title: f.caption.split('#')[0].trim(),
    viewCount: f.views, likes: f.likes, commentsCount: f.comments,
    duration: f.duration, date: f.postedAt, thumbnailUrl: `${f.url}/thumb.jpg`,
  };
}

export default fakeScrape;
