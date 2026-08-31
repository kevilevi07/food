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
 * A value it cannot understand never aborts the run: the person is booked at the
 * default time instead and a warning is printed, so one typo cannot leave the
 * config unwritten and the whole office unscheduled.
 *
 *   node scripts/crons.mjs           prints what the next deployment would schedule
 *   node scripts/crons.mjs --write   writes that list into vercel.json
 *
 * Vercel reads the cron list out of vercel.json BEFORE the build runs, so it
 * cannot be produced by code that runs during the build - it has to be a real,
 * committed file. That is why this generator writes vercel.json rather than
 * being imported by it: run --write, commit the result, redeploy. (An earlier
 * version of this repo did import it from a vercel.mjs evaluated at build time;
 * that is what silently dropped the cron, so do not go back to it.)
 *
 * IMPORTANT: this reads the variables from the shell it runs in, and Vercel
 * marks FOODAPP_* as Sensitive, which means `vercel env pull` writes the literal
 * string "[SENSITIVE]" rather than the value. Generating from that would book
 * everybody at the default time, so --write refuses to run on it.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const PATH = '/api/foodcount';
const DEFAULT_AT = '08:00';
const MAX_PATH = 512;                 // Vercel's limit on a cron path
const IST_OFFSET = 5 * 60 + 30;       // IST is UTC+5:30
const NO_CRON = new Set(['none', 'off', 'no', 'manual', '-']);
const SENSITIVE = '[SENSITIVE]';   // what `vercel env pull` writes for a Sensitive var

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

  // `vercel env pull` writes the literal "[SENSITIVE]" for variables marked
  // Sensitive, and every FOODAPP_* here is. Those read as perfectly good
  // truthy values, so without this check the generator would register the
  // users, fail to parse their times, and book the whole office at the
  // default - a wrong schedule that looks deliberate.
  const hidden = people
    .filter((person) => person.at === SENSITIVE || env[`FOODAPP_USER_${person.slug}`] === SENSITIVE
                     || env[`FOODAPP_USER_${person.slug.toLowerCase()}`] === SENSITIVE)
    .map((person) => person.slug);

  return { people, fallback, hidden };
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

// --- writing vercel.json ----------------------------------------------------

const CONFIG_FILE = new URL('../vercel.json', import.meta.url);

/** The config used when there is no vercel.json to update yet. */
const BASE_CONFIG = {
  $schema: 'https://openapi.vercel.sh/vercel.json',
  functions: { 'api/foodcount.js': { maxDuration: 60 } },
};

/**
 * Replace only the "crons" array of vercel.json, leaving every other setting
 * (functions, headers, whatever gets added later) exactly as it was.
 */
export function writeConfig(crons, file = CONFIG_FILE) {
  const existing = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  const config = { ...BASE_CONFIG, ...existing, crons };

  writeFileSync(file, JSON.stringify(config, null, 2) + '\n');

  return config;
}

// --- CLI: node scripts/crons.mjs [--write] ----------------------------------

/** The crons already committed, so --write can tell what it is about to undo. */
function existingCrons(file = CONFIG_FILE) {
  if (!existsSync(file)) return [];
  try {
    return JSON.parse(readFileSync(file, 'utf8')).crons || [];
  } catch {
    return [];
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const write = process.argv.includes('--write');
  const force = process.argv.includes('--force');
  const { people, fallback, hidden } = readSchedule(process.env);
  const crons = buildCrons(process.env);

  if (!people.length) {
    console.log('No FOODAPP_USER_<SLUG> variables in this shell, so this is the fallback:');
    console.log(`one entry that runs every registered user at the default time (${fallback} IST).`);
    console.log('That entry is correct for everybody on the shared time - you only need the');
    console.log('real values to generate per-user times. See the README before pulling them.');
    console.log('');
  } else {
    console.log(`${people.length} user(s), default ${fallback}:`);
    console.log('');
    for (const person of people) {
      const off = NO_CRON.has(person.at.toLowerCase());
      console.log(`  ${person.slug.padEnd(12)} ${off ? 'no cron - personal link only' : person.at}`);
    }
    console.log('');
  }

  console.log(`${crons.length} cron entr${crons.length === 1 ? 'y' : 'ies'}:`);
  console.log('');
  for (const cron of crons) {
    console.log(`  ${cron.schedule.padEnd(12)} ${cron.path}`);
  }
  console.log('');

  // Refuse to generate from values Vercel redacted. They are truthy, so nothing
  // downstream would notice - it would just quietly book everyone at 08:00.
  if (hidden.length) {
    console.error(`REFUSING: ${hidden.length} variable(s) read back as "${SENSITIVE}"`
                + ` (${hidden.join(', ')}).`);
    console.error('They are marked Sensitive in Vercel, so their real values cannot be pulled');
    console.error('and any schedule built from them would be wrong. Either unmark');
    console.error('FOODAPP_USER_* / FOODAPP_AT_* as Sensitive, or set the values in your shell');
    console.error('by hand. Nothing was written.');
    process.exit(1);
  }

  if (!write) {
    console.log('This only previews. Run with --write to put it in vercel.json:');
    console.log('  npm run crons -- --write');
  } else {
    // Losing entries almost always means the environment was not visible, not
    // that somebody meant to unschedule people. Make that impossible to do by
    // accident - this is exactly how the cron went missing the first time.
    const before = existingCrons();

    if (before.length > crons.length && !force) {
      console.error(`REFUSING: vercel.json already has ${before.length} cron entr`
                  + `${before.length === 1 ? 'y' : 'ies'} and this run produced only`
                  + ` ${crons.length}.`);
      console.error('That usually means this shell cannot see the FOODAPP_USER_* variables,');
      console.error('not that you meant to unschedule anybody. Existing entries:');
      for (const cron of before) console.error(`  ${cron.schedule.padEnd(12)} ${cron.path}`);
      console.error('Re-run with --force if you really do want to replace them. Nothing was written.');
      process.exit(1);
    }

    writeConfig(crons);
    console.log('Written to vercel.json. Commit it and redeploy - Vercel reads that file');
    console.log('before the build, so an uncommitted change schedules nothing.');
  }
}
