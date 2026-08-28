/**
 * Builds the Vercel cron list out of the same environment variables that define
 * the users, so adding somebody never means editing a config file.
 *
 *   FOODAPP_USER_<SLUG>   their email - this is what registers them
 *   FOODAPP_AT_<SLUG>     the IST time their food count is booked, "HH:MM"
 *                         "none" (or off / manual / -) = no cron, link only
 *   FOODAPP_AT            the default IST time for anybody with no FOODAPP_AT_<SLUG>
 *
 * People who share a time share one cron entry, so ten colleagues at 08:00 cost
 * one of the project's 100 entries, not ten.
 *
 *   node scripts/crons.mjs      prints what the next deployment would schedule
 */

import { pathToFileURL } from 'node:url';

const PATH = '/api/foodcount';
const DEFAULT_AT = '08:00';
const MAX_PATH = 512;                 // Vercel's limit on a cron path
const IST_OFFSET = 5 * 60 + 30;       // IST is UTC+5:30
const NO_CRON = new Set(['none', 'off', 'no', 'manual', '-']);

/** "09:30" IST -> "0 4 * * *", the UTC expression Vercel actually schedules. */
export function istToUtcCron(time, who = '') {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(time).trim());
  const hour = match ? Number(match[1]) : NaN;
  const minute = match ? Number(match[2]) : NaN;

  if (!match || hour > 23 || minute > 59) {
    throw new Error(`FOODAPP_AT${who ? `_${who}` : ''}="${time}" is not an IST time.`
                  + ' Use HH:MM (e.g. 09:30), or "none" for no cron at all.');
  }

  const utc = (hour * 60 + minute - IST_OFFSET + 24 * 60) % (24 * 60);

  return { schedule: `${utc % 60} ${Math.floor(utc / 60)} * * *`, utc };
}

/** Every registered user and the IST time they want, read from the environment. */
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

  // A build that cannot see the user variables (a preview deploy, or the very
  // first one) still gets a working cron: everybody, at the default time.
  if (!people.length) return [{ path: PATH, schedule: istToUtcCron(fallback).schedule }];

  const byTime = new Map();

  for (const person of people) {
    if (NO_CRON.has(person.at.toLowerCase())) continue;

    istToUtcCron(person.at, person.slug);        // fail the build on a bad time

    if (!byTime.has(person.at)) byTime.set(person.at, []);
    byTime.get(person.at).push(person.slug);
  }

  const entries = [];

  for (const [at, slugs] of byTime) {
    const { schedule, utc } = istToUtcCron(at);
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
    console.log(`the build would use if it could not see them either (${fallback} IST):\n`);
  } else {
    console.log(`${people.length} user(s), default ${fallback} IST:\n`);
    for (const person of people) {
      const off = NO_CRON.has(person.at.toLowerCase());
      console.log(`  ${person.slug.padEnd(12)} ${off ? 'no cron - personal link only' : `${person.at} IST`}`);
    }
    console.log('');
  }

  console.log(`${crons.length} cron entr${crons.length === 1 ? 'y' : 'ies'}:\n`);
  for (const cron of crons) {
    console.log(`  ${cron.schedule.padEnd(12)} ${cron.path}`);
  }
}
