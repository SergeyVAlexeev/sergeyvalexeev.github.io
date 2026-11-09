#!/usr/bin/env node
// Converts the frozen v0.5.1 Chapter 1 LaTeX source into the public HTML fragment.
//
//   node safe-return/tools/build-private-chapter.mjs [path/to/chapter_01.tex]
//
// Output: safe-return/chapter-1.html (public, frozen v0.5.1 text). The guard hashes for
// chapters 2-22 are made by guard-hashes.mjs only. The converter changes markup only; text is passed through, with the
// LaTeX typographic conventions mapped to the characters they typeset
// (``'' -> curly double quotes, ' -> apostrophe, -- and --- to dashes).
// Run `node safe-return/tools/verify-fidelity.mjs` afterwards.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
import { privatePaths } from './paths.mjs';
export const OUT_DIR = resolve(here, '..', '_private');

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function typography(s) {
  return s
    .replace(/``/g, '\u201C').replace(/''/g, '\u201D')
    .replace(/`/g, '\u2018')
    .replace(/'/g, '\u2019')
    .replace(/---/g, '\u2014').replace(/--/g, '\u2013');
}

// Inline commands used in the chapter: \app{}, \txt{}, \emph{}.
export function inline(raw) {
  let s = raw;
  const map = { app: 'span class="ui"', txt: 'em class="note"', emph: 'em' };
  s = s.replace(/\\(app|txt|emph)\{([^{}]*)\}/g, (_, cmd, body) => {
    const tag = map[cmd];
    const name = tag.split(' ')[0];
    return `\u0001${tag}\u0002${body}\u0001/${name}\u0002`;
  });
  if (/\\[a-zA-Z]+/.test(s.replace(/\u0001[^\u0002]*\u0002/g, ''))) {
    throw new Error('Unhandled LaTeX command in: ' + raw.slice(0, 80));
  }
  s = typography(s);
  s = esc(s).replace(/\u0001/g, '<').replace(/\u0002/g, '>');
  return s;
}

export function convert(tex) {
  const lines = tex.split(/\r?\n/).filter((l) => !l.startsWith('%'));
  const body = lines.join('\n');
  const titleMatch = body.match(/\\chapter\{([^}]*)\}/);
  if (!titleMatch) throw new Error('No \\chapter title');
  const title = titleMatch[1];
  const rest = body.replace(/\\chapter\{[^}]*\}/, '');
  // Paragraphs are blank-line separated. \scenebreak starts a new section and
  // may be followed by the first sentence of the next paragraph on the same line.
  const blocks = rest.split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean);
  const out = [];
  let afterBreak = false;
  for (const b of blocks) {
    const parts = b.split(/\\scenebreak\s*/);
    parts.forEach((p, i) => {
      if (i > 0) { out.push('<hr class="scene" aria-label="Scene break">'); afterBreak = true; }
      const text = p.replace(/\s*\n\s*/g, ' ').trim();
      if (!text) return;
      const cls = afterBreak || out.length === 0 ? ' class="first"' : '';
      out.push(`<p${cls}>${inline(text)}</p>`);
      afterBreak = false;
    });
  }
  return { title, html: out.join('\n') };
}

function main() {
  const src = resolve(process.argv[2] || privatePaths({ require: true }).tex);
  const tex = readFileSync(src, 'utf8');
  const { title, html } = convert(tex);
  mkdirSync(OUT_DIR, { recursive: true });
  const sha = createHash('sha256').update(tex).digest('hex');
  const fragment = `<!-- Safe Return, Chapter 1 (frozen v0.5.1). Source sha256 ${sha}. Checked by tools/verify-fidelity.mjs. -->
`
    + `<h3 class="chapter-title" id="ch1-title"><span class="chapter-num">Chapter 1</span> ${esc(title)}</h3>\n${html}\n`;
  writeFileSync(resolve(here, '..', 'chapter-1.html'), fragment, 'utf8'); // public fragment
  writeFileSync(resolve(OUT_DIR, 'chapter-1.meta.json'),
    JSON.stringify({ source: src, sourceSha256: sha, title, paragraphs: (html.match(/<p/g) || []).length }, null, 2));
  console.log(`Wrote safe-return/chapter-1.html (${(html.match(/<p/g) || []).length} paragraphs, "${title}")`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
