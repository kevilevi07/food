# Finstein Food Count — multi-user

One Vercel serverless function that books the daily food count for **any number of
people**. Each person gets their own secret key, their own link, and their own
booking time — all of it defined by environment variables, so **adding somebody
is a set of environment variables, not a code change**.

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

They are now booked at the shared 08:00 IST cron, which runs every registered
user. Only if they want their *own* time (`FOODAPP_AT_<SLUG>`) does the schedule
itself have to change - see [How the cron times work](#how-the-cron-times-work).

That is the whole procedure whether it is your second user or your fiftieth.
Removing somebody is the same in reverse; rotating a key is editing
`FOODAPP_KEY_<SLUG>`; moving their booking time is editing `FOODAPP_AT_<SLUG>`.

Check what that schedule would be, without changing anything:

```bash
$ npm run crons
3 user(s), default 08:00:

  RAVI         08:00
  SHERLOCK     08:00
  SRI          09:30

2 cron entries:

  30 2 * * *   /api/foodcount?user=RAVI,SHERLOCK
  0 4 * * *    /api/foodcount?user=SRI
```

Add `--write` to put that list into `vercel.json`.

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

The schedule lives in **`vercel.json`**, at the root of this repo:

```json
{
  "functions": { "api/foodcount.js": { "maxDuration": 60 } },
  "crons": [
    { "path": "/api/foodcount", "schedule": "30 2 * * *" }
  ]
}
```

`30 2 * * *` is **08:00 IST** (Vercel schedules in UTC, always). That one entry
carries `CRON_SECRET`, and a `CRON_SECRET` request with no `?user=` runs **every
registered user** — so adding a colleague needs no schedule change at all.

Vercel reads `vercel.json` *before* it builds, so the cron list has to be a real,
committed file: code that runs during the build is already too late.

**For the shared 08:00 time you never touch this file.** The single entry above
has no `?user=`, and a `CRON_SECRET` request without one runs every registered
user — so a new colleague is environment variables and nothing else.

You only regenerate it to give somebody their **own** time. The generator reads
the variables from the shell it runs in, so they have to actually be visible
there:

```bash
vercel env pull .env.local --environment=production   # NOT the default (development)
node --env-file=.env.local scripts/crons.mjs --write
git add vercel.json && git commit -m schedule && git push
```

> **`vercel env pull` cannot read Sensitive variables.** It writes the literal
> string `[SENSITIVE]` instead of the value, and every `FOODAPP_*` in this
> project is currently marked Sensitive. A schedule generated from those
> placeholders would book everybody at the default time, so `--write` detects
> them and refuses rather than writing a wrong schedule. To generate per-user
> times you must either unmark `FOODAPP_USER_*` and `FOODAPP_AT_*` as Sensitive
> (they are an email and a clock time — `FOODAPP_PASS_*` and `FOODAPP_KEY_*` are
> never read here and should stay Sensitive), or set those two in your shell by
> hand. `--write` also refuses to *shrink* an existing schedule without
> `--force`, because losing entries almost always means the environment was
> invisible, not that you meant to unschedule anyone.

`buildCrons` reads every `FOODAPP_USER_<SLUG>`, looks up that person's
`FOODAPP_AT_<SLUG>`, converts IST to UTC, and **groups everybody who shares a
time into one entry**:

```json
{ "path": "/api/foodcount?user=RAVI,SHERLOCK", "schedule": "30 2 * * *" }
{ "path": "/api/foodcount?user=SRI",           "schedule": "0 4 * * *"  }
```

So ten colleagues at 08:00 cost one of the project's 100 cron entries, not ten.
Drop `--write` to preview without touching the file. A `FOODAPP_AT_<SLUG>` it
cannot parse books that person at the default time and prints a warning, so a
typo never produces a silently wrong schedule.

> **Why not generate it at build time?** An earlier version of this repo used a
> `vercel.mjs` that called `buildCrons(process.env)` at build time. Vercel does
> support that file name, but its output is invisible — nothing in the repo, the
> diff, or a failed build tells you which crons were registered, and when none
> were, the app simply stopped booking. `vercel.json` is checked in, reviewable,
> and shows up in the deployment's **Cron Jobs** tab.

## When the cron does not fire

| Check | Why |
| --- | --- |
| `CRON_SECRET` is set in **Production** | Vercel only sends `Authorization: Bearer …` when this exists. Without it every cron run answers `401` and books nobody. |
| The deployment is the **production** one | Cron jobs only run on production deployments, never on previews. |
| The deployment summary lists the job | Open the deployment → **Cron Jobs**. If the list is empty, `vercel.json` never reached the deployment. |
| `vercel.json` is committed | An uncommitted or `.gitignore`d config schedules nothing. |
| The run itself | Hit `/api/foodcount?key=<CRON_SECRET>` by hand — it does exactly what the cron does, and answers with the per-user log. |

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

## Pinning the schedule by hand

Nothing in `api/foodcount.js` depends on the generator — it only ever sees
`?user=` / `?except=` on an ordinary request. `vercel.json` is an ordinary file,
so editing the array directly is always an option:

```json
{
  "functions": { "api/foodcount.js": { "maxDuration": 60 } },
  "crons": [
    { "path": "/api/foodcount?user=RAVI,SHERLOCK", "schedule": "30 2 * * *" },
    { "path": "/api/foodcount?user=SRI",           "schedule": "0 4 * * *"  }
  ]
}
```

`npm run crons` prints exactly what belongs in that array; `npm run crons --
--write` puts it there for you, leaving `functions` and anything else untouched.

## Backwards compatibility

The original single-user variables still work: `FOODAPP_USER` + `FOODAPP_PASS`
register as the user `DEFAULT`, with `CRON_SECRET` as their key. The old
`?no-breakfast` / `?no-lunch` / `?no-dinner` flags still work when `type` is
absent. A cron entry with no `?user=` / `?except=` behaves exactly as before —
every registered user, one time.
