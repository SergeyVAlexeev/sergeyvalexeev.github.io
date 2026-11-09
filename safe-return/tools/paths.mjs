// Locations of the author's private source files. Nothing machine-specific is committed.
// Provide them with environment variables, or with the git-ignored file safe-return/_private/paths.json:
//   { "tex": "<path to frozen chapters/chapter_01.tex>", "pdf": "<path to designed Chapter 1 PDF (optional)>" }
//   SAFE_RETURN_TEX, SAFE_RETURN_PDF override the file.
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const file = resolve(dirname(fileURLToPath(import.meta.url)), '..', '_private', 'paths.json');

export function privatePaths({ require = false } = {}) {
  const j = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  const out = { tex: process.env.SAFE_RETURN_TEX || j.tex || '', pdf: process.env.SAFE_RETURN_PDF || j.pdf || '' };
  if (require && !out.tex) {
    console.error('Private source path not set. Set SAFE_RETURN_TEX or create safe-return/_private/paths.json (see tools/paths.mjs).');
    process.exit(2);
  }
  return out;
}
