import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addGooglePlugin, pluginSource, PLAY_AUTH } from '../../scripts/google-plugin.mjs';

// A pretend `npx cap add android` result.
function fakeProject({ withFiles = true, gradle = 'android {\n}\ndependencies {\n    implementation "androidx.appcompat:appcompat:1.7.0"\n}\n', main } = {}){
  const root = mkdtempSync(join(tmpdir(), 'yotei-'));
  writeFileSync(join(root, 'capacitor.config.json'), JSON.stringify({ appId:'app.yotei' }));
  const dir = join(root, 'android/app/src/main/java/app/yotei'); mkdirSync(dir, { recursive:true });
  writeFileSync(join(root, 'android/app/build.gradle'), gradle);
  writeFileSync(join(dir, 'MainActivity.java'), main || 'package app.yotei;\n\nimport com.getcapacitor.BridgeActivity;\n\npublic class MainActivity extends BridgeActivity {}\n');
  if (withFiles) writeFileSync(join(dir, 'YoteiFilesPlugin.java'), 'package app.yotei;\npublic class YoteiFilesPlugin {}\n');
  return { root, dir, gradle:join(root, 'android/app/build.gradle'), main:join(dir, 'MainActivity.java') };
}
const quiet = [];  const warn = m => quiet.push(m);

test('adds the dependency once, writes the plugin and registers both plugins', () => {
  const p = fakeProject(); assert.equal(addGooglePlugin({ root:p.root, warn }), true);
  const g = readFileSync(p.gradle, 'utf8'); assert.equal(g.split('play-services-auth').length - 1, 1); assert.ok(g.includes(PLAY_AUTH));
  assert.ok(existsSync(join(p.dir, 'YoteiGooglePlugin.java')));
  const m = readFileSync(p.main, 'utf8'); assert.match(m, /registerPlugin\(YoteiFilesPlugin\.class\)/); assert.match(m, /registerPlugin\(YoteiGooglePlugin\.class\)/);
  assert.ok(m.indexOf('registerPlugin') < m.indexOf('super.onCreate'));      // plugins must be registered before the bridge starts
});
test('running it twice changes nothing the second time', () => {
  const p = fakeProject(); addGooglePlugin({ root:p.root, warn }); const a = [readFileSync(p.gradle, 'utf8'), readFileSync(p.main, 'utf8')];
  addGooglePlugin({ root:p.root, warn }); assert.deepEqual([readFileSync(p.gradle, 'utf8'), readFileSync(p.main, 'utf8')], a);
});
test('without the Downloads helper it still registers only what exists', () => {
  const p = fakeProject({ withFiles:false }); addGooglePlugin({ root:p.root, warn });
  const m = readFileSync(p.main, 'utf8'); assert.doesNotMatch(m, /YoteiFilesPlugin/); assert.match(m, /YoteiGooglePlugin/);
});
test('a project that looks different is left alone, with a warning', () => {
  quiet.length = 0;
  const p = fakeProject({ gradle:'android {}\n' }); assert.equal(addGooglePlugin({ root:p.root, warn }), false);
  assert.ok(!existsSync(join(p.dir, 'YoteiGooglePlugin.java')) && quiet.length === 1);
  const q = fakeProject({ main:'package app.yotei;\npublic class MainActivity {}\n' }); assert.equal(addGooglePlugin({ root:q.root, warn }), false);
  assert.ok(!readFileSync(q.gradle, 'utf8').includes('play-services-auth'));
});
test('the generated plugin is well formed and uses the Google API the right way', () => {
  const src = pluginSource('app.yotei');
  assert.equal(src.split('{').length, src.split('}').length);          // braces balance
  assert.equal(src.split('(').length, src.split(')').length);
  for (const needle of ['package app.yotei;', '@CapacitorPlugin(name = "YoteiGoogle")', 'extends Plugin', 'public void load()', '@PluginMethod', 'public void authorize(PluginCall call)',
    'drive.appdata', 'Identity.getAuthorizationClient', 'getAuthorizationResultFromIntent', 'res.hasResolution()', 'StartIntentSenderForResult', 'needsUi', 'CANCELLED', 'getAccessToken'])
    assert.ok(src.includes(needle), 'missing ' + needle);
  assert.ok(!src.includes('${'));                                       // nothing left uninterpolated
  const imports = src.match(/^import .*;$/gm); for (const i of imports) assert.ok(/^import [a-z][\w.]*\.[A-Z]\w*;$/.test(i), 'odd import ' + i);
});
