/**
 * Finstein Food Count - Vercel serverless function
 *
 * Same flow as foodcount.php, in Node. No dependencies: Vercel's Node runtime
 * is 18+, which has global fetch.
 *
 *   POST {kc}/realms/Finstein/protocol/openid-connect/token   -> access_token
 *   GET  {api}/user-management/getUserClaim                   -> userId
 *   GET  {api}/food-mapping/getbymycount                      -> today's rows
 *   POST {api}/food-mapping/createfoodmapping                 -> first submit
 *   PUT  {api}/food-mapping/updatefoodmapping                 -> later edits
 *
 * Environment variables (Project Settings -> Environment Variables):
 *   FOODAPP_USER   your login email
 *   FOODAPP_PASS   your password
 *   CRON_SECRET    required; guards this endpoint (see checkAuth below)
 *   SKIP_WEEKENDS  optional, "false" to also submit on Sat/Sun
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

// ---------------------------------------------------------------------------
// Auth - this endpoint is a public URL, so it must be gated.
//
// Vercel Cron sends "Authorization: Bearer $CRON_SECRET" automatically when the
// CRON_SECRET environment variable is set. ?key=<secret> is accepted too, so you
// can test from a browser.
// ---------------------------------------------------------------------------

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

function checkAuth(req) {
  const secret = process.env.CRON_SECRET;

  if (!secret) {
    return 'CRON_SECRET is not set. Set it in Project Settings -> Environment Variables,'
         + ' otherwise anyone who finds this URL could submit your food count.';
  }

  const header = req.headers.authorization || '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7) : '';
  const key = new URL(req.url, 'http://localhost').searchParams.get('key') || '';

  if (safeEqual(bearer, secret) || safeEqual(key, secret)) {
    return null;
  }

  return 'Unauthorized';
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

  const names = Object.fromEntries(Object.entries(FOOD_ID).map(([k, v]) => [v, k]));

  return rows
    .map((row) => `${names[row.foodId] ?? `foodId ${row.foodId}`}=${row.tokenAssigned ? 'yes' : 'no'}`)
    .join(', ');
}

async function submit(token, userId, existingRows, meals, dryRun, log) {
  let method;
  let url;
  let payload;

  if (existingRows.length) {
    // A record already exists today: send the rows back with the boxes flipped,
    // preserving the server's own fields (id, issued), like the Update button.
    const names = Object.fromEntries(Object.entries(FOOD_ID).map(([k, v]) => [v, k]));

    payload = existingRows.map((row) => {
      const meal = names[row.foodId];
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
// Handler
// ---------------------------------------------------------------------------

export default async function handler(req, res) {
  const lines = [];
  const log = (message) => {
    const line = `[${new Date().toISOString()}] ${message}`;
    lines.push(line);
    console.log(line);
  };

  const authError = checkAuth(req);

  if (authError) {
    return res.status(authError === 'Unauthorized' ? 401 : 500)
      .json({ ok: false, error: authError });
  }

  const params = new URL(req.url, 'http://localhost').searchParams;
  const dryRun = params.has('dry-run');

  const meals = {
    breakfast: !params.has('no-breakfast'),
    lunch: !params.has('no-lunch'),
    dinner: !params.has('no-dinner'),
  };

  try {
    const username = process.env.FOODAPP_USER;
    const password = process.env.FOODAPP_PASS;

    if (!username || !password) {
      throw new Error('FOODAPP_USER / FOODAPP_PASS are not set in the project environment variables.');
    }

    // Vercel Hobby cron only supports a daily schedule, so the weekday check
    // lives here rather than in the cron expression.
    const weekday = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Kolkata',
      weekday: 'short',
    }).format(new Date());

    const skipWeekends = process.env.SKIP_WEEKENDS !== 'false';

    if (skipWeekends && (weekday === 'Sat' || weekday === 'Sun') && !params.has('force')) {
      log(`Skipping - it is ${weekday} in IST. Add ?force to override, or set SKIP_WEEKENDS=false.`);
      return res.status(200).json({ ok: true, skipped: true, log: lines });
    }

    const token = await login(username, password);
    log(`Logged in as ${username}`);

    const userId = await fetchUserId(token);
    log(`Resolved user id: ${userId}`);

    const before = await fetchTodayRows(token);
    log(`Before: ${describe(before)}`);

    await submit(token, userId, before, meals, dryRun, log);

    if (!dryRun) {
      log(`After:  ${describe(await fetchTodayRows(token))}`);
    }

    log('Done.');

    return res.status(200).json({ ok: true, dryRun, log: lines });
  } catch (error) {
    const message = error?.name === 'TimeoutError'
      ? `Timed out talking to ${CONFIG.keycloakBase} - check the host is reachable on port 8443.`
      : error.message;

    log(`FAILED: ${message}`);

    return res.status(500).json({ ok: false, error: message, log: lines });
  }
}
