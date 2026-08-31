/**
 * Finstein Food Count - Vercel serverless function (multi-user)
 *
 * Per user, the flow is the same as before:
 *
 *   POST {kc}/realms/Finstein/protocol/openid-connect/token   -> access_token
 *   GET  {api}/user-management/getUserClaim                   -> userId
 *   GET  {api}/food-mapping/getbymycount                      -> today's rows
 *   POST {api}/food-mapping/createfoodmapping                 -> first submit
 *   PUT  {api}/food-mapping/updatefoodmapping                 -> later edits
 *
 * ---------------------------------------------------------------------------
 * Adding a user = adding environment variables in Project Settings ->
 * Environment Variables, then redeploying. Nothing else. <SLUG> is any name you
 * like, A-Z / 0-9 / _ :
 *
 *   FOODAPP_USER_<SLUG>   login email        e.g. FOODAPP_USER_ANURAG
 *   FOODAPP_PASS_<SLUG>   password           e.g. FOODAPP_PASS_ANURAG
 *   FOODAPP_KEY_<SLUG>    that user's secret e.g. foodcount-9f3a2b7c4e1d8a6f
 *   FOODAPP_TYPE_<SLUG>   optional, what the daily cron books for them
 *                         (all | 1 | 2 | 3 | 1,2 | none)   default: all
 *   FOODAPP_AT_<SLUG>     optional, the IST time their count is booked, HH:MM
 *                         ("none" = no cron at all)   default: FOODAPP_AT, 08:00
 *
 * Then that user's personal URL is:
 *
 *   https://foodauto.vercel.app/api/foodcount?key=foodcount-9f3a2b7c4e1d8a6f
 *   https://foodauto.vercel.app/api/foodcount?key=<their key>&type=2
 *
 *   type=1 breakfast, 2 lunch, 3 dinner, all = everything, none = cancel all.
 *   Combine with commas: type=1,2 . Names work too: type=lunch .
 *   Meals left out of `type` are explicitly set to "no".
 *
 * The schedule lives in vercel.json, which Vercel reads before the build - so it
 * has to be a committed file, not something generated while building. Rather
 * than editing it by hand, run "npm run crons -- --write": that turns the
 * FOODAPP_AT_<SLUG> variables into the cron list and writes it there (the
 * arithmetic lives in scripts/crons.mjs). The entries it writes call this
 * endpoint like so:
 *
 *   { "path": "/api/foodcount?user=RAVI,SHERLOCK", "schedule": "30 2 * * *" }
 *   { "path": "/api/foodcount?user=SRI",           "schedule": "0 4 * * *"  }
 *
 * A cron request carries CRON_SECRET, which on its own means "every registered
 * user". ?user=<SLUG,...> narrows the run to the people named; ?except=<SLUG,...>
 * runs everybody else. Neither is honoured for a personal ?key= request - that
 * always runs exactly its owner, so nobody can book or cancel somebody else's
 * meals by editing their link.
 *
 * Global environment variables:
 *   CRON_SECRET    admin/cron secret - a request carrying this runs EVERY user
 *   FOODAPP_AT     optional, the default IST booking time   default: 08:00
 *   FOODAPP_OFF_DAYS optional, IST days never booked. Default "Sat,Sun";
 *                  set "Sun" when Saturday is a working day, "none" for all seven
 *   SKIP_WEEKENDS  optional, "false" to also submit on days off
 *
 * Legacy single-user vars still work and register as the user "DEFAULT":
 *   FOODAPP_USER / FOODAPP_PASS   (+ CRON_SECRET as its key)
 * ---------------------------------------------------------------------------
 */

import { timingSafeEqual } from 'node:crypto';

const CONFIG = {
  keycloakBase: 'https://kc.finstein.ai:8443',
  realm: 'Finstein',
  clientId: 'food-tracker-fe',
  apiBase: 'https://foodapp.finstein.ai/api',
  timeoutMs: 20000,
};

const FOOD_ID = { breakfast: 1, lunch: 2, dinner: 3 };
const MEAL_BY_ID = Object.fromEntries(Object.entries(FOOD_ID).map(([meal, id]) => [id, meal]));

// Values of FOODAPP_OFF_DAYS that mean "work every day".
const NO_OFF_DAYS = new Set(['none', 'off', 'no', '-']);

// ---------------------------------------------------------------------------
// The user registry, read out of the environment on every cold start.
// ---------------------------------------------------------------------------

function loadUsers() {
  const users = [];
  const problems = [];

  for (const [name, value] of Object.entries(process.env)) {
    const match = /^FOODAPP_KEY_(.+)$/.exec(name);
    if (!match || !value) continue;

    const slug = match[1];
    const username = process.env[`FOODAPP_USER_${slug}`];
    const password = process.env[`FOODAPP_PASS_${slug}`];

    if (!username || !password) {
      problems.push(`${slug}: FOODAPP_KEY_${slug} is set but FOODAPP_USER_${slug}`
                  + ` / FOODAPP_PASS_${slug} are missing.`);
      continue;
    }

    users.push({
      slug,
      username,
      password,
      key: value,
      defaultType: process.env[`FOODAPP_TYPE_${slug}`],
    });
  }

  // Backwards compatibility with the original single-user setup.
  if (process.env.FOODAPP_USER && process.env.FOODAPP_PASS
      && !users.some((user) => user.slug === 'DEFAULT')) {
    users.push({
      slug: 'DEFAULT',
      username: process.env.FOODAPP_USER,
      password: process.env.FOODAPP_PASS,
      key: process.env.CRON_SECRET,
      defaultType: process.env.FOODAPP_TYPE,
    });
  }

  users.sort((a, b) => a.slug.localeCompare(b.slug));

  const seen = new Set();

  for (const user of users) {
    if (!user.key) continue;
    if (seen.has(user.key)) {
      problems.push(`${user.slug}: its secret key is also used by another user - keys must be unique.`);
    }
    seen.add(user.key);
  }

  return { users, problems };
}

// ---------------------------------------------------------------------------
// Auth - this endpoint is a public URL, so it must be gated.
//
// A request may present its secret either as "Authorization: Bearer <secret>"
// (what Vercel Cron sends automatically from CRON_SECRET) or as ?key=<secret>,
// so a user can just open their own link in a browser.
//
//   secret == CRON_SECRET  -> run every registered user (this is the cron)
//   secret == a user's key -> run that user only
// ---------------------------------------------------------------------------

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a ?? ''));
  const bufB = Buffer.from(String(b ?? ''));
  return bufA.length > 0 && bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

function checkAuth(req, params, users) {
  const header = req.headers.authorization || '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7) : '';
  const presented = bearer || params.get('key') || '';

  const cronSecret = process.env.CRON_SECRET;

  if (!cronSecret && !users.some((user) => user.key)) {
    return {
      status: 500,
      error: 'No secrets configured. Set CRON_SECRET, and a FOODAPP_KEY_<SLUG> per user,'
           + ' in Project Settings -> Environment Variables - otherwise anyone who finds'
           + ' this URL could submit the food count.',
    };
  }

  if (cronSecret && safeEqual(presented, cronSecret)) {
    return { scope: 'all', matched: users };
  }

  const matched = users.filter((user) => safeEqual(presented, user.key));

  if (matched.length) {
    return { scope: 'user', matched };
  }

  return { status: 401, error: 'Unauthorized' };
}

// ---------------------------------------------------------------------------
// ?type= - which meals to book
// ---------------------------------------------------------------------------

const TYPE_ALIASES = {
  1: 'breakfast', b: 'breakfast', breakfast: 'breakfast',
  2: 'lunch', l: 'lunch', lunch: 'lunch',
  3: 'dinner', d: 'dinner', dinner: 'dinner',
};

function parseType(value) {
  const raw = String(value).trim().toLowerCase();

  if (raw === '' || raw === 'all' || raw === '*') {
    return { breakfast: true, lunch: true, dinner: true };
  }

  if (raw === 'none' || raw === '0') {
    return { breakfast: false, lunch: false, dinner: false };
  }

  const meals = { breakfast: false, lunch: false, dinner: false };

  for (const part of raw.split(/[,+\s]+/).filter(Boolean)) {
    const meal = TYPE_ALIASES[part];

    if (!meal) {
      throw new Error(`Unknown type "${part}". Use 1 (breakfast), 2 (lunch), 3 (dinner),`
                    + ' all, none, or a comma-separated mix such as type=1,2.');
    }

    meals[meal] = true;
  }

  return meals;
}

/** ?type= wins; otherwise the user's FOODAPP_TYPE_<SLUG>; otherwise everything. */
function mealsFor(user, params) {
  if (params.has('type')) return parseType(params.get('type'));
  if (user.defaultType) return parseType(user.defaultType);

  // Legacy flags, kept working: ?no-breakfast&no-dinner
  return {
    breakfast: !params.has('no-breakfast'),
    lunch: !params.has('no-lunch'),
    dinner: !params.has('no-dinner'),
  };
}

// ---------------------------------------------------------------------------
// ?user= / ?except= - which people this run covers
//
// A cron request carries CRON_SECRET, which on its own means "every registered
// user". That is fine for one shared time; giving somebody their own time means
// telling a cron entry who it is for:
//
//   { "path": "/api/foodcount?user=SRI&type=2", "schedule": "0 4 * * *"  }
//   { "path": "/api/foodcount?except=SRI",      "schedule": "30 2 * * *" }
//
// so SRI books lunch at 09:30 IST while everybody else keeps the 08:00 IST run,
// and nobody is booked twice.
//
// Both filters are only honoured for a CRON_SECRET-scoped run. A personal key
// can never use them to book for somebody else.
// ---------------------------------------------------------------------------

function parseSlugs(value) {
  return String(value ?? '')
    .split(/[,+\s]+/)
    .filter(Boolean)
    .map((slug) => slug.toUpperCase());
}

function selectUsers(auth, users, params) {
  const filtered = params.has('user') || params.has('except');

  if (auth.scope !== 'all' || !filtered) {
    return { matched: auth.matched, scope: auth.scope, only: [], except: [], unknown: [] };
  }

  // getAll, not get: ?user=SRI&user=RAVI must mean both, not silently just SRI.
  const only = parseSlugs(params.getAll('user').join(','));
  const except = parseSlugs(params.getAll('except').join(','));

  // "?user=" with nothing after it is a typo, and reading it as "everybody"
  // would book the whole office at one person's time. Refuse it instead.
  if (!only.length && !except.length) {
    return { matched: [], scope: auth.scope, only, except, unknown: [], blank: true };
  }

  const matched = users.filter((user) => {
    const slug = user.slug.toUpperCase();
    return (!only.length || only.includes(slug)) && !except.includes(slug);
  });

  const known = new Set(users.map((user) => user.slug.toUpperCase()));
  const unknown = [...new Set([...only, ...except])].filter((slug) => !known.has(slug));

  return { matched, scope: only.length ? 'selected' : 'all-except', only, except, unknown };
}

/**
 * Which IST weekdays never book. Default Sat+Sun; FOODAPP_OFF_DAYS overrides it
 * - set it to "Sun" when Saturday is a working day, or "none" for all seven.
 * SKIP_WEEKENDS=false still means "never skip", as it always did.
 */
function offDays() {
  if (process.env.SKIP_WEEKENDS === 'false') return new Set();

  const raw = (process.env.FOODAPP_OFF_DAYS || 'Sat,Sun').trim();

  if (!raw || NO_OFF_DAYS.has(raw.toLowerCase())) return new Set();

  return new Set(raw.split(/[,+\s]+/).filter(Boolean).map((day) => day.slice(0, 3).toLowerCase()));
}

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------

async function request(method, url, { token, form, json } = {}) {
  const headers = { Accept: 'application/json' };
  let body;

  if (token) headers.Authorization = `Bearer ${token}`;

  if (form) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams(form).toString();
  } else if (json !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(json);
  }

  const response = await fetch(url, {
    method,
    headers,
    body,
    signal: AbortSignal.timeout(CONFIG.timeoutMs),
  });

  const text = await response.text();
  let parsed = null;

  try {
    parsed = JSON.parse(text);
  } catch {
    // Non-JSON body; callers fall back to the raw text.
  }

  return { status: response.status, text, json: parsed };
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

async function login(username, password) {
  const url = `${CONFIG.keycloakBase}/realms/${encodeURIComponent(CONFIG.realm)}`
            + '/protocol/openid-connect/token';

  const res = await request('POST', url, {
    form: {
      grant_type: 'password',
      client_id: CONFIG.clientId,
      scope: 'openid',
      username,
      password,
    },
  });

  if (res.status !== 200 || !res.json?.access_token) {
    const reason = res.json?.error_description || res.json?.error || res.text.slice(0, 200);
    throw new Error(`Keycloak login rejected (HTTP ${res.status}) - ${reason}`);
  }

  return res.json.access_token;
}

async function fetchUserId(token) {
  const res = await request('GET', `${CONFIG.apiBase}/user-management/getUserClaim`, { token });

  if (res.status !== 200) {
    throw new Error(`getUserClaim failed (HTTP ${res.status}) - ${res.text.slice(0, 200)}`);
  }

  const userId = res.json?.result?.findUser?.id;

  if (userId === undefined || userId === null) {
    throw new Error(`Could not read the user id - ${res.text.slice(0, 300)}`);
  }

  return userId;
}

async function fetchTodayRows(token) {
  const res = await request('GET', `${CONFIG.apiBase}/food-mapping/getbymycount`, { token });

  if (res.status !== 200) {
    throw new Error(`getbymycount failed (HTTP ${res.status}) - ${res.text.slice(0, 200)}`);
  }

  return res.json?.data?.getbymycount ?? [];
}

function describe(rows) {
  if (!rows.length) return 'nothing submitted yet today';

  return rows
    .map((row) => `${MEAL_BY_ID[row.foodId] ?? `foodId ${row.foodId}`}=${row.tokenAssigned ? 'yes' : 'no'}`)
    .join(', ');
}

async function submit(token, userId, existingRows, meals, dryRun, log) {
  let method;
  let url;
  let payload;

  if (existingRows.length) {
    // A record already exists today: send the rows back with the boxes flipped,
    // preserving the server's own fields (id, issued), like the Update button.
    payload = existingRows.map((row) => {
      const meal = MEAL_BY_ID[row.foodId];
      return meal && meal in meals ? { ...row, tokenAssigned: meals[meal] } : row;
    });

    method = 'PUT';
    url = `${CONFIG.apiBase}/food-mapping/updatefoodmapping`;
    log('Updating existing count');
  } else {
    payload = Object.entries(FOOD_ID).map(([meal, foodId]) => ({
      foodId,
      userId,
      tokenAssigned: Boolean(meals[meal]),
    }));

    method = 'POST';
    url = `${CONFIG.apiBase}/food-mapping/createfoodmapping`;
    log('Creating new count');
  }

  log(`Wanted: ${Object.entries(meals).map(([m, on]) => `${m}=${on ? 'yes' : 'no'}`).join(', ')}`);

  if (dryRun) {
    log(`Dry run - nothing sent. Payload: ${JSON.stringify(payload)}`);
    return;
  }

  const res = await request(method, url, { token, json: payload });

  if (res.status < 200 || res.status >= 300) {
    throw new Error(`Submit failed (HTTP ${res.status}) - ${res.text.slice(0, 300)}`);
  }

  log(`Server says: ${res.json?.message ?? 'OK'}`);
}

// ---------------------------------------------------------------------------
// One user's run. Never throws: a failure for one user must not stop the rest.
// ---------------------------------------------------------------------------

async function runUser(user, params, dryRun) {
  const lines = [];
  const log = (message) => {
    const line = `[${new Date().toISOString()}] ${user.slug}: ${message}`;
    lines.push(line);
    console.log(line);
  };

  let meals = null;

  try {
    meals = mealsFor(user, params);

    const token = await login(user.username, user.password);
    log(`Logged in as ${user.username}`);

    const userId = await fetchUserId(token);
    log(`Resolved user id: ${userId}`);

    const before = await fetchTodayRows(token);
    log(`Before: ${describe(before)}`);

    await submit(token, userId, before, meals, dryRun, log);

    if (!dryRun) {
      log(`After:  ${describe(await fetchTodayRows(token))}`);
    }

    log('Done.');

    return { user: user.slug, ok: true, meals, log: lines };
  } catch (error) {
    const message = error?.name === 'TimeoutError'
      ? `Timed out talking to ${CONFIG.keycloakBase} - check the host is reachable on port 8443.`
      : error.message;

    log(`FAILED: ${message}`);

    return { user: user.slug, ok: false, meals, error: message, log: lines };
  }
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export default async function handler(req, res) {
  const params = new URL(req.url, 'http://localhost').searchParams;
  const dryRun = params.has('dry-run');

  // Every per-user cron entry shares this one path, so the log has to say which
  // schedule fired. Vercel sets this header on every cron invocation.
  const cronSchedule = req.headers['x-vercel-cron-schedule'];

  const { users, problems } = loadUsers();

  if (!users.length) {
    return res.status(500).json({
      ok: false,
      error: 'No users configured. Add FOODAPP_USER_<SLUG>, FOODAPP_PASS_<SLUG> and'
           + ' FOODAPP_KEY_<SLUG> in Project Settings -> Environment Variables.',
      problems,
    });
  }

  const auth = checkAuth(req, params, users);

  if (auth.error) {
    return res.status(auth.status).json({ ok: false, error: auth.error });
  }

  const { matched, scope, only, except, unknown, blank } = selectUsers(auth, users, params);

  if (blank) {
    return res.status(400).json({
      ok: false,
      error: 'This request carried ?user= or ?except= but named nobody. Drop the'
           + ' parameter to run every user, or name at least one slug - an empty'
           + ' filter is a typo, not a request to book the whole office.',
    });
  }

  if (unknown.length) {
    problems.push(`?user= / ?except= named ${unknown.join(', ')}, which is not a registered`
                + ' user - check the slug matches its FOODAPP_KEY_<SLUG> variable.');
  }

  if (!matched.length) {
    // A cron pointing at a slug that does not exist has to fail loudly, or one
    // typo silently books nobody for months. Excluding everybody is a
    // legitimate, if pointless, request, so that one stays a 200.
    const empty = { ok: !only.length, scope, ran: 0, failed: 0, users: [] };

    if (only.length && except.length) {
      empty.error = `?user=${only.join(',')} and ?except=${except.join(',')} cancel each`
                  + ' other out, so this run would book nobody.';
    } else if (only.length) {
      empty.error = `No registered user matches ?user=${only.join(',')}.`
                  + ` Known users: ${users.map((user) => user.slug).join(', ')}.`;
    }

    if (problems.length) empty.problems = problems;
    if (cronSchedule) empty.cron = cronSchedule;

    return res.status(only.length ? 404 : 200).json(empty);
  }

  // The weekday check lives here rather than in the cron expression: it then
  // also covers somebody opening their personal link on a day off, and the days
  // can be changed with FOODAPP_OFF_DAYS instead of editing the schedule.
  const weekday = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Kolkata',
    weekday: 'short',
  }).format(new Date());

  const off = offDays();

  if (off.has(weekday.toLowerCase()) && !params.has('force')) {
    const line = `Skipping ${matched.map((user) => user.slug).join(', ')} - it is ${weekday}`
               + ` in IST and the days off are ${[...off].join(', ')}.`
               + ' Add &force to override, or change FOODAPP_OFF_DAYS.';
    console.log(line);

    const skippedBody = { ok: true, skipped: true, scope, log: [line] };

    if (problems.length) skippedBody.problems = problems;
    if (cronSchedule) skippedBody.cron = cronSchedule;

    return res.status(200).json(skippedBody);
  }

  const results = await Promise.all(matched.map((user) => runUser(user, params, dryRun)));

  const failed = results.filter((result) => !result.ok);

  const body = {
    ok: failed.length === 0,
    scope,
    dryRun,
    ran: results.length,
    failed: failed.length,
    users: results,
  };

  if (problems.length) body.problems = problems;
  if (cronSchedule) body.cron = cronSchedule;
  if (results.length === 1) body.log = results[0].log; // convenience for a single user

  // A partial failure across many users is still a 200 so the cron log keeps the
  // per-user detail; a run that helped nobody is a 500.
  const allFailed = failed.length > 0 && failed.length === results.length;

  return res.status(allFailed ? 500 : 200).json(body);
}
