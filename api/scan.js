/**
 * Finstein Food Count - QR auto-scan (multi-user)
 *
 * The canteen screen shows a QR at the counter; the app's /qr-scanner page reads
 * it with the camera and PUTs it to the server to mark your token collected. This
 * endpoint does the same PUT directly, so a token is collected without a camera.
 *
 * The QR is unsigned: base64 of
 *   {"date":"YYYY-MM-DD","foodTypeId":N,"foodTypeName":"Breakfast|Lunch|Dinner","name":"foodappfinstein"}
 * so its value is fully determined by today's date and the meal - the three
 * photographed codes were only a template. This file rebuilds that value itself.
 *
 * Per user the flow is:
 *   POST {kc}/realms/Finstein/protocol/openid-connect/token   -> access_token
 *   PUT  {api}/food-mapping/checkQrVerify {readValue,foodTypeId,name} -> data
 * where data is one of: success | warn | error | invalidQR | scannerDisabled |
 * mealDisabled. "error" ("Token Not Assigned") means the meal was never booked -
 * book it with the foodcount endpoint first, then scan.
 *
 * ---------------------------------------------------------------------------
 * Users are the SAME environment variables the booking endpoint uses, so a
 * person's key and link work here unchanged:
 *
 *   FOODAPP_USER_<SLUG>   login email
 *   FOODAPP_PASS_<SLUG>   password
 *   FOODAPP_KEY_<SLUG>    that user's secret (?key=)
 *   FOODAPP_SCANTYPE_<SLUG>  optional, which meals this user auto-scans
 *                            (all | 1 | 2 | 3 | 1,2 | none)  default: the
 *                            meal that is current in IST when the run happens
 *
 * Global:
 *   CRON_SECRET    a request carrying this scans EVERY user
 *   SKIP_WEEKENDS  optional, "false" to also scan on Sat/Sun
 *
 *   https://foodauto.vercel.app/api/scan?key=<their key>
 *   https://foodauto.vercel.app/api/scan?key=<their key>&type=2   (lunch only)
 *   https://foodauto.vercel.app/api/scan?key=<their key>&dry-run  (build, don't send)
 *
 * CRON_SECRET runs may narrow with ?user=<SLUG,...> / ?except=<SLUG,...>, exactly
 * like the booking endpoint, so each meal can have its own scan cron.
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
const FOOD_NAME = { 1: 'Breakfast', 2: 'Lunch', 3: 'Dinner' };

// The server's checkQrVerify replies with one of these strings; ok=true means the
// token is (now, or already was) collected, so a re-run is safe and idempotent.
const OUTCOMES = {
  success: { ok: true, detail: 'Scanned successfully' },
  warn: { ok: true, detail: 'Already scanned' },
  error: { ok: false, detail: 'Token not assigned - book this meal before scanning' },
  invalidQR: { ok: false, detail: 'Server rejected the QR value' },
  scannerDisabled: { ok: false, detail: 'Scanning is not enabled - only the provider can enable it' },
  mealDisabled: { ok: false, detail: 'Scanning is not enabled for this meal' },
};

// ---------------------------------------------------------------------------
// User registry - identical to the booking endpoint, minus the booking-only
// FOODAPP_TYPE, plus FOODAPP_SCANTYPE.
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
      scanType: process.env[`FOODAPP_SCANTYPE_${slug}`],
    });
  }

  if (process.env.FOODAPP_USER && process.env.FOODAPP_PASS
      && !users.some((user) => user.slug === 'DEFAULT')) {
    users.push({
      slug: 'DEFAULT',
      username: process.env.FOODAPP_USER,
      password: process.env.FOODAPP_PASS,
      key: process.env.CRON_SECRET,
      scanType: process.env.FOODAPP_SCANTYPE,
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
// Auth - same rules as the booking endpoint.
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
      error: 'No secrets configured. Set CRON_SECRET, and a FOODAPP_KEY_<SLUG> per user.',
    };
  }

  if (cronSecret && safeEqual(presented, cronSecret)) {
    return { scope: 'all', matched: users };
  }

  const matched = users.filter((user) => safeEqual(presented, user.key));
  if (matched.length) return { scope: 'user', matched };

  return { status: 401, error: 'Unauthorized' };
}

function parseSlugs(value) {
  return String(value ?? '').split(/[,+\s]+/).filter(Boolean).map((slug) => slug.toUpperCase());
}

function selectUsers(auth, users, params) {
  const filtered = params.has('user') || params.has('except');

  if (auth.scope !== 'all' || !filtered) {
    return { matched: auth.matched, scope: auth.scope, only: [], except: [], unknown: [] };
  }

  const only = parseSlugs(params.getAll('user').join(','));
  const except = parseSlugs(params.getAll('except').join(','));

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

// ---------------------------------------------------------------------------
// Which meals to scan
// ---------------------------------------------------------------------------

const TYPE_ALIASES = {
  1: 'breakfast', b: 'breakfast', breakfast: 'breakfast',
  2: 'lunch', l: 'lunch', lunch: 'lunch',
  3: 'dinner', d: 'dinner', dinner: 'dinner',
};

function parseType(value) {
  const raw = String(value).trim().toLowerCase();

  if (raw === 'all' || raw === '*') return [1, 2, 3];
  if (raw === '' || raw === 'none' || raw === '0') return [];

  const ids = new Set();
  for (const part of raw.split(/[,+\s]+/).filter(Boolean)) {
    const meal = TYPE_ALIASES[part];
    if (!meal) {
      throw new Error(`Unknown type "${part}". Use 1 (breakfast), 2 (lunch), 3 (dinner),`
                    + ' all, or a comma-separated mix such as type=1,2.');
    }
    ids.add(FOOD_ID[meal]);
  }
  return [...ids].sort();
}

/** The meal that is current right now in IST - the one the counter is serving. */
function currentMeal() {
  const hour = Number(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata', hour: '2-digit', hour12: false,
  }).format(new Date()));

  if (hour >= 7 && hour < 12) return [1];
  if (hour >= 12 && hour < 16) return [2];
  if (hour >= 16 && hour < 24) return [3];
  return []; // the counter is closed (00:00-07:00 IST)
}

/** ?type= wins; else the user's FOODAPP_SCANTYPE_<SLUG>; else the current meal. */
function mealsFor(user, params) {
  if (params.has('type')) return parseType(params.get('type'));
  if (user.scanType) return parseType(user.scanType);
  return currentMeal();
}

/** Today's date in IST, as the QR encodes it: YYYY-MM-DD. */
function todayIST() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

/** Rebuild the exact string the scanned QR would have carried for this meal. */
function readValueFor(foodTypeId, date) {
  return Buffer.from(JSON.stringify({
    date,
    foodTypeId,
    foodTypeName: FOOD_NAME[foodTypeId],
    name: 'foodappfinstein',
  })).toString('base64');
}

// ---------------------------------------------------------------------------
// HTTP
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

  const response = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(CONFIG.timeoutMs) });
  const text = await response.text();

  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* non-JSON body */ }

  return { status: response.status, text, json: parsed };
}

async function login(username, password) {
  const url = `${CONFIG.keycloakBase}/realms/${encodeURIComponent(CONFIG.realm)}`
            + '/protocol/openid-connect/token';

  const res = await request('POST', url, {
    form: { grant_type: 'password', client_id: CONFIG.clientId, scope: 'openid', username, password },
  });

  if (res.status !== 200 || !res.json?.access_token) {
    const reason = res.json?.error_description || res.json?.error || res.text.slice(0, 200);
    throw new Error(`Keycloak login rejected (HTTP ${res.status}) - ${reason}`);
  }

  return res.json.access_token;
}

/** One PUT to checkQrVerify for one meal; returns the server's decoded outcome. */
async function scanMeal(token, foodTypeId, date, dryRun, log) {
  const payload = { readValue: readValueFor(foodTypeId, date), foodTypeId, name: 'foodappfinstein' };
  const meal = FOOD_NAME[foodTypeId];

  if (dryRun) {
    log(`${meal}: dry run - would PUT ${JSON.stringify(payload)}`);
    return { meal, foodTypeId, dryRun: true };
  }

  const res = await request('PUT', `${CONFIG.apiBase}/food-mapping/checkQrVerify`, { token, json: payload });

  if (res.status < 200 || res.status >= 300) {
    log(`${meal}: HTTP ${res.status} - ${res.text.slice(0, 160)}`);
    return { meal, foodTypeId, ok: false, data: null, detail: `HTTP ${res.status}` };
  }

  const data = typeof res.json?.data === 'string' ? res.json.data
             : typeof res.json === 'string' ? res.json
             : res.text.trim();
  const known = OUTCOMES[data] || { ok: false, detail: `Unrecognised response "${data}"` };

  log(`${meal}: ${data} - ${known.detail}`);
  return { meal, foodTypeId, ok: known.ok, data, detail: known.detail };
}

// ---------------------------------------------------------------------------
// One user's run - never throws.
// ---------------------------------------------------------------------------

async function runUser(user, params, dryRun, date) {
  const lines = [];
  const log = (message) => {
    const line = `[${new Date().toISOString()}] ${user.slug}: ${message}`;
    lines.push(line);
    console.log(line);
  };

  try {
    const meals = mealsFor(user, params);

    if (!meals.length) {
      log('No meal to scan (nothing selected, or the counter is closed in IST).');
      return { user: user.slug, ok: true, scanned: [], log: lines };
    }

    const token = await login(user.username, user.password);
    log(`Logged in as ${user.username}`);

    const scanned = [];
    for (const foodTypeId of meals) {
      scanned.push(await scanMeal(token, foodTypeId, date, dryRun, log));
    }

    const failed = scanned.filter((s) => s.ok === false);
    log('Done.');

    return { user: user.slug, ok: failed.length === 0, scanned, log: lines };
  } catch (error) {
    const message = error?.name === 'TimeoutError'
      ? `Timed out talking to ${CONFIG.keycloakBase}.`
      : error.message;
    log(`FAILED: ${message}`);
    return { user: user.slug, ok: false, error: message, log: lines };
  }
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export default async function handler(req, res) {
  const params = new URL(req.url, 'http://localhost').searchParams;
  const dryRun = params.has('dry-run');
  const cronSchedule = req.headers['x-vercel-cron-schedule'];
  const date = todayIST();

  const { users, problems } = loadUsers();

  if (!users.length) {
    return res.status(500).json({ ok: false, error: 'No users configured.', problems });
  }

  const auth = checkAuth(req, params, users);
  if (auth.error) return res.status(auth.status).json({ ok: false, error: auth.error });

  const { matched, scope, only, except, unknown, blank } = selectUsers(auth, users, params);

  if (blank) {
    return res.status(400).json({
      ok: false,
      error: 'This request carried ?user= or ?except= but named nobody. Drop the'
           + ' parameter to scan every user, or name at least one slug.',
    });
  }

  if (unknown.length) {
    problems.push(`?user= / ?except= named ${unknown.join(', ')}, which is not a registered user.`);
  }

  if (!matched.length) {
    const empty = { ok: !only.length, scope, ran: 0, failed: 0, users: [] };
    if (only.length && except.length) {
      empty.error = `?user=${only.join(',')} and ?except=${except.join(',')} cancel each other out.`;
    } else if (only.length) {
      empty.error = `No registered user matches ?user=${only.join(',')}.`
                  + ` Known users: ${users.map((user) => user.slug).join(', ')}.`;
    }
    if (problems.length) empty.problems = problems;
    if (cronSchedule) empty.cron = cronSchedule;
    return res.status(only.length ? 404 : 200).json(empty);
  }

  const weekday = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Kolkata', weekday: 'short' }).format(new Date());
  const skipWeekends = process.env.SKIP_WEEKENDS !== 'false';

  if (skipWeekends && (weekday === 'Sat' || weekday === 'Sun') && !params.has('force')) {
    const line = `Skipping ${matched.map((u) => u.slug).join(', ')} - it is ${weekday} in IST.`
               + ' Add &force to override, or set SKIP_WEEKENDS=false.';
    console.log(line);
    const body = { ok: true, skipped: true, scope, log: [line] };
    if (problems.length) body.problems = problems;
    if (cronSchedule) body.cron = cronSchedule;
    return res.status(200).json(body);
  }

  const results = await Promise.all(matched.map((user) => runUser(user, params, dryRun, date)));
  const failed = results.filter((result) => !result.ok);

  const body = {
    ok: failed.length === 0,
    scope,
    date,
    dryRun,
    ran: results.length,
    failed: failed.length,
    users: results,
  };

  if (problems.length) body.problems = problems;
  if (cronSchedule) body.cron = cronSchedule;
  if (results.length === 1) body.log = results[0].log;

  const allFailed = failed.length > 0 && failed.length === results.length;
  return res.status(allFailed ? 500 : 200).json(body);
}
