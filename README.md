# Finstein Food Count — multi-user

One Vercel serverless function that books the daily food count for **any number of
people**. Each person gets their own secret key, their own link, and their own
booking time — all of it defined by environment variables, so **adding somebody
never means editing a file**.

```
https://foodauto.vercel.app/api/foodcount?key=foodcount-9f3a2b7c4e1d8a6f
https://foodauto.vercel.app/api/foodcount?key=foodcount-9f3a2b7c4e1d8a6f&type=2
```

## Adding a user

A user *is* a set of environment variables. `<SLUG>` is any name you like, using
`A–Z`, `0–9` and `_` (e.g. `SHERLOCK`, `SRI`, `USER1`).

| Variable | Required | Meaning |
| --- | --- | --- |
| `FOODAPP_USER_<SLUG>` | yes | their login email |
| `FOODAPP_PASS_<SLUG>` | yes | their password |
| `FOODAPP_KEY_<SLUG>` | yes | their personal secret key, e.g. `foodcount-9f3a2b7c4e1d8a6f` |
| `FOODAPP_TYPE_<SLUG>` | no | **what** to book — `all` (default), `1`, `2`, `3`, `1,2`, `none` |
| `FOODAPP_AT_<SLUG>` | no | **when** to book it — an IST time like `09:30`. Default `08:00`. `none` = no cron, personal link only |

Three steps, every time:

```bash
# 1. generate their key and the exact commands
npm run genkey SRI 09:30

# 2. run the printed `vercel env add` commands (or paste them into
#    Project Settings -> Environment Variables)

# 3. redeploy - env var changes only take effect on a new deployment
```

That is the whole procedure whether it is your second user or your fiftieth.
Removing somebody is the same in reverse; rotating a key is editing
`FOODAPP_KEY_<SLUG>`; moving their booking time is editing `FOODAPP_AT_<SLUG>`.

Before deploying, check what the next deployment will schedule:

```bash
$ npm run crons
3 user(s), default 08:00 IST:

  RAVI         08:00 IST
  SHERLOCK     08:00 IST
  SRI          09:30 IST

2 cron entries:

  30 2 * * *   /api/foodcount?user=RAVI,SHERLOCK
  0 4 * * *    /api/foodcount?user=SRI
```

### Global variables

| Variable | Meaning |
| --- | --- |
| `CRON_SECRET` | admin/cron secret. A request carrying **this** runs **every** user, unless `?user=` / `?except=` narrows it. Vercel Cron sends it automatically. |
| `FOODAPP_AT` | the default IST booking time for anybody with no `FOODAPP_AT_<SLUG>`. Default `08:00`. |
| `SKIP_WEEKENDS` | set to `false` to also submit on Sat/Sun. Default: skip. |
| `FOODAPP_BASE_URL` | only used by `npm run genkey`, to print the right host in the links. |

## Choosing meals — `type`

| `type` | Books |
| --- | --- |
| *(omitted)* | the user's `FOODAPP_TYPE_<SLUG>`, or all three |
| `1` | breakfast only |
| `2` | lunch only |
| `3` | dinner only |
| `all` | breakfast + lunch + dinner |
| `none` | cancels all three (on leave) |
| `1,2` | breakfast + lunch — any comma-separated mix |

Names work too: `type=lunch`, `type=breakfast,dinner`.

**Meals not listed are explicitly set to “no”**, so `type=2` means *lunch yes,
breakfast no, dinner no* — re-running the link is always safe and idempotent.

## How the cron times work

Vercel needs its cron list in the project config, and that config is normally a
static `vercel.json`. This project uses **`vercel.mjs`** instead, which Vercel
*executes at build time* — so the cron list is generated from the environment
variables rather than written by hand:

```js
// vercel.mjs
import { buildCrons } from './scripts/crons.mjs';

export const config = {
  functions: { 'api/foodcount.js': { maxDuration: 60 } },
  crons: buildCrons(process.env),
};
```

`buildCrons` reads every `FOODAPP_USER_<SLUG>`, looks up that person's
`FOODAPP_AT_<SLUG>`, converts IST to the UTC that Vercel schedules in, and
**groups everybody who shares a time into one entry**:

```json
{ "path": "/api/foodcount?user=RAVI,SHERLOCK", "schedule": "30 2 * * *" }
{ "path": "/api/foodcount?user=SRI",           "schedule": "0 4 * * *"  }
```

So ten colleagues at 08:00 cost one of the project's 100 cron entries, not ten.
A bad `FOODAPP_AT_<SLUG>` fails the build rather than shipping a wrong schedule,
and a build that cannot see the user variables at all falls back to a single
`/api/foodcount` entry that runs everybody — the cron never silently vanishes.

> **Do not mark `FOODAPP_USER_*` or `FOODAPP_AT_*` as Sensitive** in Vercel.
> Sensitive variables are hidden from the build, and the generator would fall
> back to booking everyone at the default time. `FOODAPP_PASS_*` and
> `FOODAPP_KEY_*` are never read at build time, so those are free to be
> sensitive.

### Times are UTC

Vercel evaluates cron expressions in **UTC, always** — `FOODAPP_AT_<SLUG>` is in
IST and the generator does the −5:30 for you. For reference:

| IST | UTC | `schedule` |
| --- | --- | --- |
| 07:30 | 02:00 | `0 2 * * *` |
| 08:00 | 02:30 | `30 2 * * *` |
| 09:00 | 03:30 | `30 3 * * *` |
| 09:30 | 04:00 | `0 4 * * *` |
| 10:00 | 04:30 | `30 4 * * *` |

Weekends are skipped in code (see `SKIP_WEEKENDS`) rather than in the cron
expression. A weekdays-only schedule would deploy fine, but the in-code check
also covers people opening their personal link on a Saturday, and it can be
turned off with an environment variable instead of a redeploy.

### What your plan allows

| | Cron jobs per project | Minimum interval | Precision |
| --- | --- | --- | --- |
| **Hobby** | 100 | once per day | **± 59 min** |
| **Pro** | 100 | once per minute | per-minute |

Entries are per *distinct time*, not per person, so the 100 limit is generous.
But a Hobby cron set to `30 2 * * *` fires anywhere between 08:00 and 08:59 IST
— if the food-count cutoff is tight, set the time an hour early, go Pro, or set
`FOODAPP_AT_<SLUG>=none` and drive that person's link from an external scheduler
(cron-job.org, GitHub Actions) that has minute precision:

```
https://foodauto.vercel.app/api/foodcount?key=<their key>&type=2
```

Keep those keys in the scheduler's secret store, never in this repo.

## Who a request runs as

| Secret presented | Query | Runs |
| --- | --- | --- |
| `CRON_SECRET` | — | every registered user |
| `CRON_SECRET` | `?user=<SLUG,...>` | just those users |
| `CRON_SECRET` | `?except=<SLUG,...>` | everybody else |
| `FOODAPP_KEY_<SLUG>` | *(ignored)* | that one user |
| anything else | — | `401 Unauthorized` |

The secret goes in `?key=` (browser-friendly) or in an `Authorization: Bearer …`
header (what Vercel Cron uses). Keys are compared in constant time.

`?user=` and `?except=` are honoured **only** for a `CRON_SECRET` run. A personal
key always runs exactly its own owner, so nobody can book — or cancel — somebody
else's meals by editing their link. Slugs are matched case-insensitively, and a
`?user=` naming somebody who is not registered answers `404` rather than quietly
booking nobody. A `?user=` or `?except=` that is present but empty answers `400`
— reading it as "everybody" would book the whole office at one person's time.

## Collecting the token — `/api/scan`

Booking (`/api/foodcount`) reserves a meal; **collecting** it is a second step —
at the counter the app's `/qr-scanner` reads a QR and the server marks your token
`issued`. `/api/scan` does that same call without a camera.

The counter QR is unsigned base64 of
`{"date":"YYYY-MM-DD","foodTypeId":N,"foodTypeName":"…","name":"foodappfinstein"}`,
so its value is fully determined by the date and the meal — `scan.js` rebuilds it
and `PUT`s `/food-mapping/checkQrVerify`. It reuses the **same** users, keys, and
`?user=` / `?except=` scoping as `/api/foodcount`:

| URL | Scans |
| --- | --- |
| `…/api/scan?key=<their key>` | the meal current in IST right now |
| `…/api/scan?key=<their key>&type=2` | lunch |
| `…/api/scan?key=<their key>&type=all` | breakfast + lunch + dinner |
| `…/api/scan?key=<their key>&dry-run` | builds the payload, sends nothing |
| `…/api/scan?key=<CRON_SECRET>&user=SRI` | scans SRI (admin) |

`FOODAPP_SCANTYPE_<SLUG>` sets a user's default meals to scan, the way
`FOODAPP_TYPE_<SLUG>` does for booking. The server's reply is decoded to a clear
outcome:

| Server `data` | Meaning |
| --- | --- |
| `success` | collected now |
| `warn` | already collected (safe to re-run) |
| `error` | **token not assigned** — book the meal first, then scan |
| `scannerDisabled` / `mealDisabled` | the provider has scanning switched off |
| `invalidQR` | the server rejected the value |

> **The provider gates this.** A scan only takes effect while the provider has the
> scan session **and** that meal enabled (`GET /food-mapping/scan-session/status`,
> `…/meal-scan-config`). Outside that window every scan returns `scannerDisabled`
> and nothing changes — the same gate the physical camera faces. Because that
> window is provider-controlled and its timing is not exposed, `/api/scan` is not
> wired into the generated cron list; trigger it from the personal link, or from
> an external scheduler timed to when scanning is actually open.

## Extra query flags

| Flag | Effect |
| --- | --- |
| `&dry-run` | shows the exact payload without sending it |
| `&force` | submit even on a weekend |

## Response

```json
{
  "ok": true,
  "scope": "selected",
  "cron": "0 4 * * *",
  "dryRun": false,
  "ran": 1,
  "failed": 0,
  "users": [
    { "user": "SRI", "ok": true, "meals": { "breakfast": false, "lunch": true, "dinner": false }, "log": ["…"] }
  ],
  "log": ["…"]
}
```

A run covering exactly one user repeats that user's log at the top level, as
above; a run covering several omits the top-level `log` and you read
`users[].log` instead.

`scope` says who the run covered — `all`, `selected` (`?user=`), `all-except`
(`?except=`), or `user` (somebody's personal key). `cron` echoes the schedule
that fired, so a log full of runs on the same path still tells you which entry
each one came from.

A run where **some** users failed still returns `200` with `failed > 0`, so the
cron log keeps the per-user detail. A run where **every** user failed returns
`500`. Misconfigured users (a key with no matching user/password, a duplicated
key, or a `?user=` slug that does not exist) are reported in a `problems` array
instead of silently disappearing.

## Going back to a static config

Nothing in `api/foodcount.js` depends on the generator — it only ever sees
`?user=` / `?except=` on an ordinary request. To pin the schedule by hand,
delete `vercel.mjs` and write the equivalent `vercel.json` (Vercel reads one
config file, not both):

```json
{
  "functions": { "api/foodcount.js": { "maxDuration": 60 } },
  "crons": [
    { "path": "/api/foodcount?user=RAVI,SHERLOCK", "schedule": "30 2 * * *" },
    { "path": "/api/foodcount?user=SRI",           "schedule": "0 4 * * *"  }
  ]
}
```

`npm run crons` prints exactly what belongs in that array.

## Backwards compatibility

The original single-user variables still work: `FOODAPP_USER` + `FOODAPP_PASS`
register as the user `DEFAULT`, with `CRON_SECRET` as their key. The old
`?no-breakfast` / `?no-lunch` / `?no-dinner` flags still work when `type` is
absent. A cron entry with no `?user=` / `?except=` behaves exactly as before —
every registered user, one time.
