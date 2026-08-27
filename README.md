# Finstein Food Count — multi-user

One Vercel serverless function that books the daily food count for **any number of
people**. Each person gets their own secret key and their own link; a single daily
cron runs all of them.

```
https://countw.vercel.app/api/foodcount?key=foodcount-9f3a2b7c4e1d8a6f
https://countw.vercel.app/api/foodcount?key=foodcount-9f3a2b7c4e1d8a6f&type=2
```

## Adding a user

A user *is* a set of environment variables. `<SLUG>` is any name you like, using
`A–Z`, `0–9` and `_` (e.g. `ANURAG`, `RAVI`, `USER1`).

| Variable | Required | Meaning |
| --- | --- | --- |
| `FOODAPP_USER_<SLUG>` | yes | their login email |
| `FOODAPP_PASS_<SLUG>` | yes | their password |
| `FOODAPP_KEY_<SLUG>` | yes | their personal secret key, e.g. `foodcount-9f3a2b7c4e1d8a6f` |
| `FOODAPP_TYPE_<SLUG>` | no | what the daily cron books for them — `all` (default), `1`, `2`, `3`, `1,2`, `none` |

Generate a key and the exact commands to run:

```bash
npm run genkey ANURAG
```

Or add them in the Vercel dashboard: **Project Settings → Environment Variables**.
Then redeploy (env var changes only take effect on a new deployment).

Removing a user is the same in reverse — delete their three variables and redeploy.
Rotating a key is just editing `FOODAPP_KEY_<SLUG>`.

### Global variables

| Variable | Meaning |
| --- | --- |
| `CRON_SECRET` | admin/cron secret. A request carrying **this** runs **every** user. Vercel Cron sends it automatically. |
| `SKIP_WEEKENDS` | set to `false` to also submit on Sat/Sun. Default: skip. |

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

## Extra query flags

| Flag | Effect |
| --- | --- |
| `&dry-run` | shows the exact payload without sending it |
| `&force` | submit even on a weekend |

## Who a request runs as

| Secret presented | Runs |
| --- | --- |
| `CRON_SECRET` | every registered user (this is the nightly cron) |
| `FOODAPP_KEY_<SLUG>` | that one user |
| anything else | `401 Unauthorized` |

The secret goes in `?key=` (browser-friendly) or in an `Authorization: Bearer …`
header (what Vercel Cron uses). Keys are compared in constant time.

## The daily cron

`vercel.json` runs `/api/foodcount` at 02:30 UTC (08:00 IST) every day. Vercel
attaches `CRON_SECRET`, so that single run covers everybody — all users are
processed in parallel, and one person's failure does not stop the others.

## Response

```json
{
  "ok": true,
  "scope": "all",
  "dryRun": false,
  "ran": 3,
  "failed": 0,
  "users": [
    { "user": "ANURAG", "ok": true, "meals": { "breakfast": true, "lunch": true, "dinner": true }, "log": ["…"] },
    { "user": "RAVI",   "ok": false, "error": "Keycloak login rejected (HTTP 401) — Invalid user credentials", "log": ["…"] }
  ]
}
```

A run where **some** users failed still returns `200` with `failed > 0`, so the cron
log keeps the per-user detail. A run where **every** user failed returns `500`.
Misconfigured users (a key with no matching user/password, or a duplicated key)
are reported in a `problems` array instead of silently disappearing.

## Backwards compatibility

The original single-user variables still work: `FOODAPP_USER` + `FOODAPP_PASS`
register as the user `DEFAULT`, with `CRON_SECRET` as their key. The old
`?no-breakfast` / `?no-lunch` / `?no-dinner` flags still work when `type` is absent.
