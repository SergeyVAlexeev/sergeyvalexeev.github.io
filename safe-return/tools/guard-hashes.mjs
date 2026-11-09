#!/usr/bin/env node
// Writes safe-return/_private/canary-hashes.json: truncated SHA-256 of 10-word windows (every 7th
// word) of frozen chapters 2-22. Hashes only; the file is git-ignored. Chapter 1 is public and is
// not hashed. Any publishable file containing a matching 10-word run (a copy of 16+ words is
// guaranteed to match) fails check-no-private.mjs.
//   node safe-return/tools/guard-hashes.mjs
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { privatePaths } from './paths.mjs';

const here = dirname(fileURLToPath(import.meta.url));
export const WINDOW = 10;
export const STEP = 7;
export const h = (s) => createHash('sha256').update(s).digest('hex').slice(0, 20);

export function texToWords(tex) {
  let t = tex.split(/\r?\n/).filter((l) => !l.startsWith('%')).join('\n');
  t = t.replace(/\\chapter\{[^}]*\}/g, ' ').replace(/\\scenebreak/g, ' ')
    .replace(/\\(app|txt|emph)\{([^{}]*)\}/g, '$2')
    .replace(/\\[a-zA-Z]+/g, ' ');
  return normWords(t);
}
export const normWords = (s) => s.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&')
  .replace(/[‘’`']/g, "'").replace(/[“”]/g, '"')
  .replace(/[^\p{L}\p{N}']+/gu, ' ').toLowerCase().trim().split(' ').filter(Boolean)
  .map((w) => w.replace(/^'+|'+$/g, '')).filter(Boolean);

export function windowHashes(words) {
  const out = [];
  for (let i = 0; i + WINDOW <= words.length; i += STEP) out.push(h(words.slice(i, i + WINDOW).join(' ')));
  return out;
}

export function main() {
  const chapDir = dirname(privatePaths({ require: true }).tex);
  const hashes = [];
  let count = 0;
  for (let n = 2; n <= 22; n++) {
    const f = join(chapDir, `chapter_${String(n).padStart(2, '0')}.tex`);
    if (!existsSync(f)) { console.error(`Missing frozen chapter: ${f}`); process.exit(2); }
    const words = texToWords(readFileSync(f, 'utf8'));
    count += words.length;
    hashes.push(...windowHashes(words));
  }
  const outDir = resolve(here, '..', '_private');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'canary-hashes.json'), JSON.stringify({
    note: 'Truncated SHA-256 of 10-word windows of frozen chapters 2-22. Hashes only. Git-ignored.',
    words: count, hashes: [...new Set(hashes)],
  }));
  console.log(`Wrote ${new Set(hashes).size} window hashes for chapters 2-22 (${count} words).`);

}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
