import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const y = readFileSync(new URL('../../github/workflows/android.yml', import.meta.url), 'utf8');
test('the build signs with whatever key name the key file has', () => {
  assert.ok(y.includes('keytool -list') && y.includes('--ks-key-alias "$ALIAS"'));
  assert.ok(!/--ks-key-alias yotei\s/.test(y), 'the key name must not be hard-coded');
});
test('the build reads the signing key and its password from secrets only', () => {
  assert.ok(y.includes('secrets.KEYSTORE_B64') && y.includes('secrets.KEYSTORE_PASSWORD'));
  assert.ok(!/KEYSTORE_PASSWORD:\s*[^$\s]/.test(y));
});
