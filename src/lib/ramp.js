/**
 * Posting rate ramp.
 *
 * A brand-new account that jumps straight to its target cadence looks less
 * like a publisher and more like a bot, and the platforms treat it that way.
 * So the machine starts slow and works up: `start` videos per day for the
 * first stretch, `target` by the end of `days`, interpolated linearly and
 * rounded to whole videos in between.
 *
 * The clock runs from the first post the machine ever scheduled, not from
 * process start, so the ramp survives restarts, redeploys and gaps - it is a
 * property of the account's history, not of this run.
 */
export function rampedRate({ start, target, days, firstPostAt, now = new Date() }) {
  if (!Number.isFinite(start) || start < 1) return 1;
  if (!Number.isFinite(target) || target <= start) return start;
  if (!Number.isFinite(days) || days <= 0) return target;

  // Nothing posted yet: this is day zero.
  if (!firstPostAt) return start;
  const first = new Date(firstPostAt).getTime();
  if (!Number.isFinite(first)) return start;

  const elapsedDays = (now.getTime() - first) / 86400000;
  if (elapsedDays <= 0) return start;
  if (elapsedDays >= days) return target;

  return Math.round(start + (target - start) * (elapsedDays / days));
}

/** Human-readable note for the log, so the current rate is never a mystery. */
export function rampNote({ start, target, days, firstPostAt, rate, now = new Date() }) {
  if (target <= start) return `${rate} video(s) per run (no ramp configured)`;
  if (!firstPostAt) return `${rate} video(s) per run (day 1 of a ${days}-day ramp to ${target})`;
  const elapsed = Math.floor((now.getTime() - new Date(firstPostAt).getTime()) / 86400000);
  if (elapsed >= days) return `${rate} video(s) per run (ramp complete)`;
  return `${rate} video(s) per run (day ${elapsed + 1} of a ${days}-day ramp ${start} -> ${target})`;
}

export default rampedRate;
