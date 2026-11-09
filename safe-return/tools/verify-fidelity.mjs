#!/usr/bin/env node
// Manuscript fidelity check (local only; needs the private fragment).
//  1. Strips LaTeX from the frozen source and the markup from the generated HTML,
//     then compares the two plain-text word streams exactly.
//  2. Optionally compares against text extracted from the designed Chapter 1 PDF
//     (pdftotext) when `--pdf <file>` is supplied; reports the diff size.
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { typography } from './build-private-chapter.mjs';

const here = dirname(fileURLToPath(import.meta.url));
import { privatePaths } from './paths.mjs';
const SRC = privatePaths({ require: true }).tex;
const frag = readFileSync(resolve(here, '..', 'chapter-1.html'), 'utf8');

const decode = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const words = (s) => s.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);

let tex = readFileSync(SRC, 'utf8').split(/\r?\n/).filter((l) => !l.startsWith('%')).join('\n');
tex = tex.replace(/\\chapter\{[^}]*\}/, '').replace(/\\scenebreak/g, ' ')
  .replace(/\\(app|txt|emph)\{([^{}]*)\}/g, '$2');
tex = typography(tex);
const html = decode(frag.replace(/<!--[\s\S]*?-->/g, '').replace(/<h3[\s\S]*?<\/h3>/, '').replace(/<\/?(p|hr)[^>]*>/g, ' ').replace(/<[^>]+>/g, ''));

const a = words(tex), b = words(html);
let bad = 0;
for (let i = 0; i < Math.max(a.length, b.length); i++) {
  if (a[i] !== b[i]) { console.error(`MISMATCH at word ${i}: tex=${a[i]} html=${b[i]}`); if (++bad > 5) break; }
}
console.log(`Source words: ${a.length}; HTML words: ${b.length}; ${bad ? 'FAIL' : 'EXACT MATCH'}`);

const pdfIdx = process.argv.indexOf('--pdf');
if (pdfIdx > 0) {
  const raw = execFileSync('pdftotext', ['-layout', process.argv[pdfIdx + 1], '-'], { encoding: 'utf8', maxBuffer: 1 << 26 });
  const norm = (s) => s.replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, '"').replace(/\u00AD/g, '').replace(/-\n/g, '').replace(/[^\w']+/g, ' ').toLowerCase().trim().split(' ');
  const p = new Set(norm(raw)), h = norm(html);
  const missing = h.filter((w) => !p.has(w));
  console.log(`PDF cross-check: ${missing.length} HTML words not present in PDF text${missing.length ? ' e.g. ' + [...new Set(missing)].slice(0, 10).join(', ') : ''}`);
}
process.exit(bad ? 1 : 0);
