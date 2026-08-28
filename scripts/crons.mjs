/**
 * Builds the Vercel cron list out of the same environment variables that define
 * the users, so adding somebody never means editing a config file.
 *
 *   FOODAPP_USER_<SLUG>   their email - this is what registers them
 *   FOODAPP_AT_<SLUG>     when their food count is booked. Either an IST clock
 *                         time, "HH:MM" (e.g. 09:00), or a raw 5-field UTC cron
 *                         expression (e.g. "30 3 * * *"). "none" (or off /
 *                         manual / -) = no cron, personal link only.
 *   FOODAPP_AT            the default for anybody with no FOODAPP_AT_<SLUG>
 *
 * People who land on the same schedule share one cron entry, so ten colleagues
 * at 08:00 cost one of the project's 100 entries, not ten.
 *
 * A value it cannot understand never fails the deployment: the person is booked
 * at the default time instead and a warning is written to the build log. That
 * matters because this runs at config-compile time - throwing here would stop
 * the whole site from deploying, not just drop one cron.
 *
 *   node scripts/crons.mjs      prints what the next deployment would schedule
 */

import { pathToFileURL } from 'node:url';

const PATH = '/api/foodcount';
const DEFAULT_AT = '08:00';
const MAX_PATH = 512;                 // Vercel's limit on a cron path
const IST_OFFSET = 5 * 60 + 30;       // IST is UTC+5:30
const NO_CRON = new Set(['none', 'off', 'no', 'manual', '-']);

/**
 * Turn one FOODAPP_AT value into { schedule, utc }. Accepts an IST "HH:MM" and
 * converts it to the UTC cron Vercel schedules in, or takes a raw 5-field cron
 * expression as-is. Throws only on something that is neither.
 */
export function istToUtcCron(value, who = '') {
  const time = String(value).trim();

  const clock = /^(\d{1,2}):(\d{2})$/.exec(time);
  if (clock) {
    const hour = Number(clock[1]);
    const minute = Number(clock[2]);
    if (hour <= 23 && minute <= 59) {
      const utc = (hour * 60 + minute - IST_OFFSET + 24 * 60) % (24 * 60);
      return { schedule: `${utc % 60} ${Math.floor(utc / 60)} * * *`, utc };
    }
  }

  // A raw cron expression: five fields of digits / * , - / only. Someone who
  // pastes "30 3 * * *" (what this very function prints) gets what they meant.
  const fields = time.split(/\s+/);
  if (fields.length === 5 && fields.every((f) => /^[\d*,/-]+$/.test(f))) {
    const [min, hour] = fields;
    // Sort by wall-clock when the first two fields are plain numbers; anything
    // fancier just sorts last, which only affects display order.
    const utc = /^\d+$/.test(min) && /^\d+$/.test(hour)
      ? Number(hour) * 60 + Number(min)
      : 24 * 60;
    return { schedule: time, utc };
  }

  throw new Error(`FOODAPP_AT${who ? `_${who}` : ''}="${value}" is neither an IST`
                + ' time (HH:MM, e.g. 09:00) nor a 5-field cron expression'
                + ' (e.g. "30 3 * * *"), and "none" turns the cron off.');
}

/** The default schedule, resolved once and guaranteed to parse. */
function safeFallback(fallback) {
  try {
    return { at: fallback, ...istToUtcCron(fallback) };
  } catch (error) {
    console.warn(`[crons] ${error.message} Falling back to ${DEFAULT_AT} IST.`);
    return { at: DEFAULT_AT, ...istToUtcCron(DEFAULT_AT) };
  }
}

/** Every registered user and the time they want, read from the environment. */
export function readSchedule(env = process.env) {
  const fallback = (env.FOODAPP_AT || DEFAULT_AT).trim();
  const people = [];

  for (const [name, value] of Object.entries(env)) {
    const match = /^FOODAPP_USER_(.+)$/.exec(name);
    if (!match || !value) continue;

    const slug = match[1];
    people.push({ slug: slug.toUpperCase(), at: (env[`FOODAPP_AT_${slug}`] || fallback).trim() });
  }

  people.sort((a, b) => a.slug.localeCompare(b.slug));

  return { people, fallback };
}

export function buildCrons(env = process.env) {
  const { people, fallback } = readSchedule(env);
  const base = safeFallback(fallback);

  // A build that cannot see the user variables (a preview deploy, or the very
  // first one) still gets a working cron: everybody, at the default time.
  if (!people.length) return [{ path: PATH, schedule: base.schedule }];

  // Group by the resulting schedule, not the raw value, so "09:00" and its
  // equivalent "30 3 * * *" land in the same entry.
  const bySchedule = new Map();

  for (const person of people) {
    if (NO_CRON.has(person.at.toLowerCase())) continue;

    let parsed;
    try {
      parsed = istToUtcCron(person.at, person.slug);
    } catch (error) {
      // Never fail the whole build over one bad value - book them at the default
      // and make the mistake visible in the build log.
      console.warn(`[crons] ${error.message} Booking ${person.slug} at the`
                 + ` default ${base.at} instead.`);
      parsed = { schedule: base.schedule, utc: base.utc };
    }

    const group = bySchedule.get(parsed.schedule) || { utc: parsed.utc, slugs: [] };
    group.slugs.push(person.slug);
    bySchedule.set(parsed.schedule, group);
  }

  const entries = [];

  for (const [schedule, { utc, slugs }] of bySchedule) {
    let chunk = [];

    const flush = () => {
      if (!chunk.length) return;
      entries.push({ path: `${PATH}?user=${chunk.join(',')}`, schedule, utc });
      chunk = [];
    };

    for (const slug of slugs) {
      // Keep the path inside Vercel's 512-character limit, whatever the headcount.
      if (chunk.length && `${PATH}?user=${chunk.join(',')},${slug}`.length > MAX_PATH) flush();
      chunk.push(slug);
    }

    flush();
  }

  entries.sort((a, b) => a.utc - b.utc || a.path.localeCompare(b.path));

  return entries.map(({ path, schedule }) => ({ path, schedule }));
}

// --- preview: node scripts/crons.mjs ----------------------------------------

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { people, fallback } = readSchedule(process.env);
  const crons = buildCrons(process.env);

  if (!people.length) {
    console.log('No FOODAPP_USER_<SLUG> variables in this shell, so this is the fallback');
    console.log(`the build would use if it could not see them either (${fallback}):\n`);
  } else {
    console.log(`${people.length} user(s), default ${fallback}:\n`);
    for (const person of people) {
      const off = NO_CRON.has(person.at.toLowerCase());
      console.log(`  ${person.slug.padEnd(12)} ${off ? 'no cron - personal link only' : person.at}`);
    }
    console.log('');
  }

  console.log(`${crons.length} cron entr${crons.length === 1 ? 'y' : 'ies'}:\n`);
  for (const cron of crons) {
    console.log(`  ${cron.schedule.padEnd(12)} ${cron.path}`);
  }
}
