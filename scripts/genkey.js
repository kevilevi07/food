#!/usr/bin/env node
/**
 * Prints a secret key for a new user, in the shape foodcount-<16 hex chars>.
 *
 *   node scripts/genkey.js            -> one key
 *   node scripts/genkey.js ANURAG     -> one key, plus the three `vercel env`
 *                                        commands that register that user
 */

import { randomBytes } from 'node:crypto';

const slug = (process.argv[2] || '').toUpperCase().replace(/[^A-Z0-9_]/g, '_');
const key = `foodcount-${randomBytes(8).toString('hex')}`;

if (!slug) {
  console.log(key);
  process.exit(0);
}

console.log(`Secret key for ${slug}:\n  ${key}\n`);
console.log('Register the user (each command prompts for the value, once per environment):');
console.log(`  vercel env add FOODAPP_USER_${slug} production   # their login email`);
console.log(`  vercel env add FOODAPP_PASS_${slug} production   # their password`);
console.log(`  vercel env add FOODAPP_KEY_${slug} production    # ${key}`);
console.log(`  vercel env add FOODAPP_TYPE_${slug} production   # optional: all | 1 | 2 | 3 | 1,2 | none`);
console.log('\nThen redeploy, and their link is:');
console.log(`  https://countw.vercel.app/api/foodcount?key=${key}`);
console.log(`  https://countw.vercel.app/api/foodcount?key=${key}&type=2`);
