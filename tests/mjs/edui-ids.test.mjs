// The sheet editor (edui.js) is a layer over the original form controls. This checks every control it talks to exists in the page.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
const js = readFileSync(new URL('../../src/js/edui.js', import.meta.url), 'utf8');
const mainJs = readFileSync(new URL('../../src/js/main.js', import.meta.url), 'utf8');
test('edui.js only uses ids that exist in index.html or are drawn by edui.js itself', () => {
  const ids = new Set([...js.matchAll(/\$\('#([A-Za-z0-9_]+)'\)/g)].map(m => m[1]));
  const drawn = new Set(['es_d', 'es_m', 'es_from', 'es_to', 'es_colors', 'wh', 'wm', 'wa']);
  const missing = [...ids].filter(id => !drawn.has(id) && !html.includes('id="' + id + '"'));
  assert.deepEqual(missing, []);
});
test('the editor sheets are wired into main.js', () => {
  assert.match(mainJs, /initEdUI\(/);
  assert.match(mainJs, /'edSub'/);
});
test('the new modules are listed for offline use', () => {
  const sw = readFileSync(new URL('../../sw.js', import.meta.url), 'utf8');
  assert.match(sw, /wave\.js/); assert.match(sw, /edui\.js/);
});
