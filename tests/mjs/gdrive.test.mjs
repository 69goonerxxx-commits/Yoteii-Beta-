import test from 'node:test';
import assert from 'node:assert/strict';
import { createDrive, DriveError, mapNativeError, summarizeBackup, shouldAutoBackup, BACKUP_NAME } from '../../src/js/gdrive.js';

// A tiny pretend Google: records every request and answers from a table.
function fake(answers){
  const calls = [];
  const fetchFn = async (url, init = {}) => {
    calls.push({ url, ...init });
    const a = answers.find(x => url.includes(x.match) && (!x.method || x.method === (init.method || 'GET')));
    if (!a) return { ok:false, status:404, json:async () => ({}), text:async () => '' };
    if (a.throws) throw new TypeError('Failed to fetch');
    return { ok:a.status ? a.status < 300 : true, status:a.status || 200, json:async () => a.json, text:async () => a.text };
  };
  return { calls, fetchFn };
}
const plugin = (r) => () => ({ authorize: async () => { if (r instanceof Error) throw r; return r; } });

test('sign-in asks the plugin for a token and reads the profile with it', async () => {
  const f = fake([{ match:'oauth2/v3/userinfo', json:{ email:'a@x.com', name:'Alex Doe', given_name:'Alex' } }]);
  const d = createDrive({ getPlugin:plugin({ accessToken:'tok' }), fetchFn:f.fetchFn });
  assert.deepEqual(await d.signIn(true), { token:'tok', email:'a@x.com', name:'Alex Doe', given:'Alex' });
  assert.equal(f.calls[0].headers.Authorization, 'Bearer tok');
});
test('a silent token that needs the screen is an auth error, not a crash', async () => {
  const d = createDrive({ getPlugin:plugin({ needsUi:true }), fetchFn:fake([]).fetchFn });
  await assert.rejects(d.token(false), e => e instanceof DriveError && e.code === 'auth');
});
test('finding the backup looks only in the private app folder, newest first', async () => {
  const f = fake([{ match:'/files?', json:{ files:[{ id:'f1', modifiedTime:'2026-11-01T10:00:00Z' }] } }]);
  const d = createDrive({ getPlugin:plugin({}), fetchFn:f.fetchFn });
  assert.equal((await d.findBackup('tok')).id, 'f1');
  const u = f.calls[0].url; assert.match(u, /spaces=appDataFolder/); assert.match(u, /orderBy=modifiedTime%20desc/); assert.ok(u.includes(encodeURIComponent("name='" + BACKUP_NAME + "'")));
});
test('no backup yet gives null', async () => {
  const d = createDrive({ getPlugin:plugin({}), fetchFn:fake([{ match:'/files?', json:{ files:[] } }]).fetchFn });
  assert.equal(await d.findBackup('tok'), null);
});
test('the first upload creates the file inside the app folder', async () => {
  const f = fake([{ match:'uploadType=multipart', method:'POST', json:{ id:'new1', modifiedTime:'t' } }]);
  const d = createDrive({ getPlugin:plugin({}), fetchFn:f.fetchFn });
  assert.equal((await d.upload('tok', '{"app":"yotei"}', null)).id, 'new1');
  const c = f.calls[0]; assert.match(c.headers['Content-Type'], /^multipart\/related; boundary=/);
  assert.ok(c.body.includes('"parents":["appDataFolder"]') && c.body.includes('"name":"' + BACKUP_NAME + '"') && c.body.includes('{"app":"yotei"}'));
});
test('later uploads update the same file instead of making copies', async () => {
  const f = fake([{ match:'/files/f1?uploadType=media', method:'PATCH', json:{ id:'f1', modifiedTime:'t2' } }]);
  const d = createDrive({ getPlugin:plugin({}), fetchFn:f.fetchFn });
  await d.upload('tok', 'DATA', 'f1'); assert.equal(f.calls[0].method, 'PATCH'); assert.equal(f.calls[0].body, 'DATA');
});
test('download returns the file text', async () => {
  const d = createDrive({ getPlugin:plugin({}), fetchFn:fake([{ match:'alt=media', text:'HELLO' }]).fetchFn });
  assert.equal(await d.download('tok', 'f1'), 'HELLO');
});
test('Google errors become clear codes', async () => {
  const mk = (status) => createDrive({ getPlugin:plugin({}), fetchFn:fake([{ match:'/files?', status, json:{} }]).fetchFn });
  await assert.rejects(mk(401).findBackup('t'), e => e.code === 'auth');
  await assert.rejects(mk(403).findBackup('t'), e => e.code === 'denied');
  await assert.rejects(mk(500).findBackup('t'), e => e.code === 'api');
  await assert.rejects(createDrive({ getPlugin:plugin({}), fetchFn:fake([{ match:'/files?', throws:true }]).fetchFn }).findBackup('t'), e => e.code === 'network');
});
test('native failures are sorted into cancelled, not set up, network, other', () => {
  assert.equal(mapNativeError({ code:'CANCELLED', message:'x' }).code, 'cancelled');
  assert.equal(mapNativeError(new Error('Sign-in was cancelled.')).code, 'cancelled');
  assert.equal(mapNativeError(new Error('Google sign-in failed: 10: Developer Error')).code, 'notsetup');
  assert.equal(mapNativeError(new Error('Network error')).code, 'network');
  assert.equal(mapNativeError(new Error('boom')).code, 'api');
});
test('a missing plugin is reported, not thrown as a TypeError', async () => {
  await assert.rejects(createDrive({ getPlugin:() => null }).token(true), e => e instanceof DriveError);
});
test('the backup summary counts days of history', () => {
  assert.deepEqual(summarizeBackup({ data:{ yotei_v2_hist:JSON.stringify({ a:1, b:2, c:3 }) } }), { days:3 });   // the app saves each value as JSON text
  assert.deepEqual(summarizeBackup({ data:{ yotei_v2_hist:{ a:1, b:2 } } }), { days:2 });
  assert.deepEqual(summarizeBackup({ data:{ yotei_v2_hist:'not json' } }), { days:0 });
  assert.deepEqual(summarizeBackup(null), { days:0 }); assert.deepEqual(summarizeBackup({ data:{} }), { days:0 });
});
test('automatic backup runs at most once a day, and only when signed in, switched on and there is something to save', () => {
  const base = { signedIn:true, on:true, hasData:true, now:1e12 };
  assert.equal(shouldAutoBackup({ ...base, last:0 }), true);
  assert.equal(shouldAutoBackup({ ...base, last:1e12 - 3600e3 }), false);
  assert.equal(shouldAutoBackup({ ...base, last:1e12 - 864e5 }), true);
  assert.equal(shouldAutoBackup({ ...base, last:0, signedIn:false }), false);
  assert.equal(shouldAutoBackup({ ...base, last:0, on:false }), false);
  assert.equal(shouldAutoBackup({ ...base, last:0, hasData:false }), false);
});
