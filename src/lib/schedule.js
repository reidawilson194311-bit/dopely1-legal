import { config } from '../config.js';

/**
 * Turn "11:00 in America/New_York" into a UTC instant, without pulling in a
 * date library. Intl gives us the zone's offset on that date, which handles
 * daylight saving correctly - a fixed offset does not, and a machine that
 * posts an hour late for half the year is a machine nobody trusts.
 */
export function zonedTimeToUtc(year, month, day, hour, minute, timeZone) {
  const guess = Date.UTC(year, month - 1, day, hour, minute, 0);
  // Two passes: the first offset may be wrong if the guess lands on the far
  // side of a DST boundary from the real instant.
  let ts = guess;
  for (let i = 0; i < 2; i++) {
    ts = guess + offsetMs(ts, timeZone);
  }
  return new Date(ts);
}

function offsetMs(utcMs, timeZone) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const parts = Object.fromEntries(
    fmt.formatToParts(new Date(utcMs)).filter((p) => p.type !== 'literal').map((p) => [p.type, Number(p.value)]),
  );
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour % 24, parts.minute, parts.second);
  return utcMs - asUtc;
}

/**
 * Next free slots for a platform, skipping anything already taken and anything
 * inside the lead time. Returns `count` Date objects in chronological order.
 */
export function nextSlots(platform, count, takenISO = [], now = new Date()) {
  const slots = config.post.slots[platform] || ['12:00'];
  const tz = config.post.timezone;
  const taken = new Set(takenISO);
  const earliest = now.getTime() + config.post.leadMinutes * 60000;
  const out = [];

  for (let dayOffset = 0; dayOffset <= config.post.horizonDays && out.length < count; dayOffset++) {
    const day = new Date(now.getTime() + dayOffset * 86400000);
    // Read the calendar date in the target zone, not the server's zone.
    const [month, dayOfMonth, year] = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    })
      .format(day)
      .split('/')
      .map(Number);

    for (const slot of slots) {
      if (out.length >= count) break;
      const [h, m] = slot.split(':').map(Number);
      const when = zonedTimeToUtc(year, month, dayOfMonth, h, m, tz);
      if (when.getTime() < earliest) continue;
      const iso = when.toISOString();
      if (taken.has(iso)) continue;
      taken.add(iso);
      out.push(when);
    }
  }
  return out;
}

/** Local wall-clock rendering of an instant, for logs and the publisher APIs. */
export function formatLocal(date, timeZone = config.post.timezone) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone, hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    })
      .formatToParts(date)
      .filter((x) => x.type !== 'literal')
      .map((x) => [x.type, x.value]),
  );
  return `${p.year}-${p.month}-${p.day}T${p.hour === '24' ? '00' : p.hour}:${p.minute}:${p.second}`;
}
