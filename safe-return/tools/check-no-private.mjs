#!/usr/bin/env node
// Release guard. Fails if a publishable file (tracked, or untracked and not ignored) contains:
//  1. a private path (_private/), or under safe-return/ a PDF/TeX/DOCX other than the one allowed PDF;
//  2. text from frozen chapters 2-22 (10-word window hashes, see guard-hashes.mjs);
//  3. text from chapters 2-22 inside the allowed PDF (pdftotext).
// Chapter 1 is public by release decision and is checked for fidelity by verify-fidelity.mjs.
//   node safe-return/tools/check-no-private.mjs
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normWords, windowHashes, WINDOW } from './guard-hashes.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ALLOWED_PDF = 'safe-return/Safe_Return_Chapter_1.pdf';
const ALLOWED_CHAPTER = 'safe-return/chapter-1.html';
const files = execFileSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
const problems = [];

for (const f of files) {
  if (/(^|\/)_private\//.test(f)) problems.push(`private path: ${f}`);
  if (/^safe-return\//.test(f) && /\.(pdf|tex|docx)$/i.test(f) && f !== ALLOWED_PDF) problems.push(`forbidden file: ${f}`);
  if (/safe[-_ ]?return/i.test(f) && /\.(tex|docx)$/i.test(f)) problems.push(`forbidden file: ${f}`);
}

const hashFile = resolve(root, 'safe-return', '_private', 'canary-hashes.json');
const canary = new Set(existsSync(hashFile) ? JSON.parse(readFileSync(hashFile, 'utf8')).hashes : []);
if (!canary.size) console.warn('WARNING: no canary hashes (run safe-return/tools/guard-hashes.mjs). Only file checks ran.');

function scan(text, label) {
  const words = normWords(text);
  for (let i = 0; i + WINDOW <= words.length; i++) {
    const hsh = windowHashes(words.slice(i, i + WINDOW))[0];
    if (canary.has(hsh)) { problems.push(`chapters 2-22 text in ${label} near word ${i}`); return; }
  }
}

for (const f of files) {
  if (/\.(jpg|png|woff2|ico|mp4|mp3|webm|pdf)$/i.test(f) || f === ALLOWED_CHAPTER) continue;
  let raw; try { raw = readFileSync(resolve(root, f), 'utf8'); } catch { continue; }
  scan(raw, f);
}
if (files.includes(ALLOWED_PDF)) {
  const txt = execFileSync('pdftotext', ['-q', resolve(root, ALLOWED_PDF), '-'], { encoding: 'utf8', maxBuffer: 1 << 26 });
  scan(txt, ALLOWED_PDF);
}

if (problems.length) { console.error('RELEASE GUARD FAILED\n' + problems.join('\n')); process.exit(1); }
console.log(`Release guard passed: ${files.length} publishable files scanned; ${canary.size} chapters 2-22 window hashes.`);
