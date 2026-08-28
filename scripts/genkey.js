#!/usr/bin/env node
/**
 * Prints a secret key for a new user, in the shape foodcount-<16 hex chars>,
 * and the exact commands that register them.
 *
 *   node scripts/genkey.js             -> one key
 *   node scripts/genkey.js SRI         -> one key + the commands to register SRI
 *   node scripts/genkey.js SRI 09:30   -> the same, booking SRI at 09:30 IST
 *                                         instead of the shared default time
 *
 * There is no config file to edit afterwards: the cron list is generated from
 * these variables at build time (see scripts/crons.mjs).
 */

import { randomBytes } from 'node:crypto';
import { istToUtcCron } from './crons.mjs';

const slug = (process.argv[2] || '').toUpperCase().replace(/[^A-Z0-9_]/g, '_');
const at = process.argv[3];
const key = `foodcount-${randomBytes(8).toString('hex')}`;

const base = process.env.FOODAPP_BASE_URL
  || (process.env.VERCEL_PROJECT_PRODUCTION_URL && `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`)
  || 'https://foodauto.vercel.app';

if (!slug) {
  console.log(key);
  process.exit(0);
}

let schedule = null;

if (at) {
  try {
    schedule = istToUtcCron(at, slug).schedule;
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}

console.log(`Secret key for ${slug}:\n  ${key}\n`);
console.log('Register the user (each command prompts for the value, once per environment):');
console.log(`  vercel env add FOODAPP_USER_${slug} production   # their login email`);
console.log(`  vercel env add FOODAPP_PASS_${slug} production   # their password`);
console.log(`  vercel env add FOODAPP_KEY_${slug} production    # ${key}`);
console.log(`  vercel env add FOODAPP_TYPE_${slug} production   # optional: all | 1 | 2 | 3 | 1,2 | none`);
<<<<<<< HEAD

if (at) {
  console.log(`  vercel env add FOODAPP_AT_${slug} production     # ${at}`
            + `   -> cron "${schedule}" UTC`);
} else {
  console.log(`  vercel env add FOODAPP_AT_${slug} production     # optional: 09:30 to book them`);
  console.log('                                                  # at their own time, "none" for no cron');
}

console.log('\nThen redeploy. There is no config file to edit - the cron list is built from');
console.log('these variables. Check what the next deployment will schedule:');
console.log('  npm run crons');
console.log('\nTheir personal link, usable any time regardless of the cron:');
console.log(`  ${base}/api/foodcount?key=${key}`);
console.log(`  ${base}/api/foodcount?key=${key}&type=2`);
=======
console.log('\nThen redeploy, and their link is:');
console.log(`  https://foodauto.vercel.app/api/foodcount?key=${key}`);
console.log(`  https://foodauto.vercel.app/api/foodcount?key=${key}&type=2`);
>>>>>>> 2da2d129bd6739a7b37a8cfc7aedc283971a0f54
