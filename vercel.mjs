/**
 * Vercel executes this file at BUILD time, which is the whole point: the cron
 * list is generated from the same environment variables that define the users,
 * so adding somebody is never a code change.
 *
 *   FOODAPP_USER_<SLUG>   registers them
 *   FOODAPP_AT_<SLUG>     the IST time their count is booked (default 08:00,
 *                         or whatever FOODAPP_AT says; "none" = no cron)
 *
 * Preview what the next deployment will schedule:  npm run crons
 *
 * This replaces vercel.json - Vercel reads one config file, not both. The static
 * equivalent is in the README if you ever want to go back.
 */

import { buildCrons } from './scripts/crons.mjs';

export const config = {
  functions: {
    'api/foodcount.js': {
      maxDuration: 60,
    },
  },
  crons: buildCrons(process.env),
};
