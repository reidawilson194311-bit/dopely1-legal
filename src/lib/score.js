/**
 * Viral scoring.
 *
 * Raw view counts only tell you how big an account is. What we want is the
 * outlier: the post that beat its own account by a wide margin, because that
 * gap is the part attributable to the idea rather than the audience. So every
 * post is scored against the median of its own account.
 */

export function median(values) {
  const nums = values.filter((v) => Number.isFinite(v) && v > 0).sort((a, b) => a - b);
  if (!nums.length) return 0;
  const mid = Math.floor(nums.length / 2);
  return nums.length % 2 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2;
}

/** Engagement per view, clamped - a decent tiebreak between equal outliers. */
export function engagementRate(post) {
  if (!post.views) return 0;
  return Math.min(1, (post.likes + post.comments * 3 + post.shares * 5) / post.views);
}

/** Newer wins ties: 1.0 today, decaying to ~0.5 at the lookback horizon. */
export function recencyWeight(postedAt, lookbackDays) {
  if (!postedAt) return 0.75;
  const ageDays = (Date.now() - new Date(postedAt).getTime()) / 86400000;
  if (ageDays < 0) return 1;
  return 1 / (1 + ageDays / Math.max(1, lookbackDays));
}

/**
 * Annotate posts with `accountMedian`, `viralMultiple` and `viralScore`, then
 * return only the ones clearing both the multiple and the absolute floor.
 */
export function pickWinners(posts, { viralMultiple, minViews, lookbackDays, keepTop }) {
  const byAccount = new Map();
  for (const p of posts) {
    const key = `${p.platform}:${p.account}`;
    if (!byAccount.has(key)) byAccount.set(key, []);
    byAccount.get(key).push(p);
  }

  const cutoff = Date.now() - lookbackDays * 86400000;
  const scored = [];

  for (const group of byAccount.values()) {
    const accountMedian = median(group.map((p) => p.views));
    for (const p of group) {
      if (p.postedAt && new Date(p.postedAt).getTime() < cutoff) continue;
      const multiple = accountMedian > 0 ? p.views / accountMedian : 0;
      const er = engagementRate(p);
      scored.push({
        ...p,
        accountMedian: Math.round(accountMedian),
        viralMultiple: Number(multiple.toFixed(2)),
        engagementRate: Number(er.toFixed(4)),
        viralScore: Number(
          (multiple * (1 + er * 4) * recencyWeight(p.postedAt, lookbackDays)).toFixed(3),
        ),
      });
    }
  }

  return scored
    .filter((p) => p.views >= minViews && p.viralMultiple >= viralMultiple)
    .sort((a, b) => b.viralScore - a.viralScore)
    .slice(0, keepTop);
}

export default pickWinners;
