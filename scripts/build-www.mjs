// Collects the web app's files into www/, which is what the Android app bundles.
// Mirrors what the GitHub Pages workflow publishes (index.html, manifest, sw.js, src/, assets/).
// Run with: node scripts/build-www.mjs   (from the repository root)
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, existsSync, statSync } from 'node:fs';
import { dirname, join, resolve, relative } from 'node:path';

const FILES = ['index.html', 'manifest.webmanifest', 'sw.js'];
const DIRS = ['src', 'assets'];

rmSync('www', { recursive: true, force: true });
mkdirSync('www');
let problems = 0;
const fail = m => { console.error(m); problems++; };

for (const f of FILES) {
  if (!existsSync(f)) { fail(`${f} is missing`); continue; }
  cpSync(f, join('www', f));
}
for (const d of DIRS) {
  if (!existsSync(d)) { fail(`${d}/ is missing`); continue; }
  cpSync(d, join('www', d), { recursive: true });
}

const walk = dir => readdirSync(dir).flatMap(n => {
  const p = join(dir, n);
  return statSync(p).isDirectory() ? walk(p) : [p];
});
const all = walk('www');

// Every module the app imports must have been copied, or the app would not start.
const IMPORT = /(?:import|from)\s*(?:[^'"]*?from\s*)?['"](\.{1,2}\/[^'"]+\.js)['"]/g;
for (const f of all.filter(x => x.endsWith('.js'))) {
  for (const m of readFileSync(f, 'utf8').matchAll(IMPORT)) {
    const target = resolve(dirname(f), m[1]);
    if (!existsSync(target)) fail(`${relative('www', f)} imports ${m[1]}, which is missing`);
  }
}

// Files the page, manifest and service worker point at must exist too.
const html = readFileSync('www/index.html', 'utf8');
const refs = [
  ...[...html.matchAll(/(?:src|href)="\.\/([^"#?]+)"/g)].map(m => m[1]),
  ...[...readFileSync('www/manifest.webmanifest', 'utf8').matchAll(/"src":\s*"([^"]+)"/g)].map(m => m[1]),
  ...[...readFileSync('www/sw.js', 'utf8').matchAll(/'\.\/([^'/][^']*)'/g)].map(m => m[1]),
];
for (const r of new Set(refs)) {
  if (/^https?:/.test(r)) continue;
  if (!existsSync(join('www', r))) fail(`referenced file is missing from www/: ${r}`);
}

if (problems) process.exit(1);
console.log(`www/ ready: ${all.length + FILES.length} files`);
