// Google Drive backup. The Android app asks a small native plugin (YoteiGoogle) for an access token,
// then this file talks to Google's REST API with fetch. Everything goes in Drive's private "app data" folder,
// which only Yoteii can read and which does not show up in the person's own Drive files.
export const BACKUP_NAME = 'yoteii-backup.json';
const DRIVE = 'https://www.googleapis.com/drive/v3', UPLOAD = 'https://www.googleapis.com/upload/drive/v3';

// code: 'cancelled' | 'network' | 'notsetup' | 'auth' | 'denied' | 'api'
export class DriveError extends Error { constructor(code, message){ super(message || code); this.code = code; } }

// Turns whatever the native plugin throws into a DriveError.
export function mapNativeError(e){
  if (e instanceof DriveError) return e;
  const code = String((e && e.code) || ''), msg = String((e && e.message) || e || '');
  if (code === 'CANCELLED' || /cancel/i.test(msg)) return new DriveError('cancelled', msg);
  if (/developer.?error|\b10:|\b12500\b|\b12501\b.*config|invalid_client|not.*registered/i.test(msg)) return new DriveError('notsetup', msg);
  if (/network|timeout|unreachable|offline|UnknownHost/i.test(msg)) return new DriveError('network', msg);
  return new DriveError('api', msg);
}

// Pure helpers, so they can be tested without a phone.
export function summarizeBackup(j){
  // Backups keep each value as JSON text (the way the app stores it), so read it first.
  const d = (j && j.data) || {}, count = k => { let v = d['yotei_v2_' + k]; if (typeof v === 'string'){ try{ v = JSON.parse(v); }catch{ v = null; } } return v && typeof v === 'object' ? Object.keys(v).length : 0; };
  return { days:count('hist') };
}
// Back up on open when it has been a day since the last one.
export function shouldAutoBackup({ signedIn, on, last, now, hasData }){
  if (!signedIn || !on || !hasData) return false;
  return !last || now - last >= 864e5;
}

export function createDrive({ getPlugin, fetchFn = (...a) => fetch(...a) }){
  async function token(interactive){
    const p = getPlugin(); if (!p) throw new DriveError('api', 'Google sign-in is not available on this device.');
    let r; try{ r = await p.authorize({ interactive:!!interactive }); }catch(e){ throw mapNativeError(e); }
    if (!r || r.needsUi) throw new DriveError('auth', 'Google needs you to sign in again.');
    if (!r.accessToken) throw new DriveError('api', 'Google did not give access.');
    return r.accessToken;
  }
  async function call(tk, url, init = {}){
    let res; try{ res = await fetchFn(url, { ...init, headers:{ Authorization:'Bearer ' + tk, ...(init.headers || {}) } }); }
    catch(e){ throw new DriveError('network', String((e && e.message) || e)); }
    if (res.ok) return res;
    if (res.status === 401) throw new DriveError('auth', 'Google asked you to sign in again.');
    if (res.status === 403) throw new DriveError('denied', 'Google Drive refused the request.');
    throw new DriveError('api', 'Google Drive answered ' + res.status + '.');
  }
  async function userinfo(tk){
    const j = await (await call(tk, 'https://www.googleapis.com/oauth2/v3/userinfo')).json();
    return { email:j.email || '', name:j.name || '', given:j.given_name || '' };
  }
  async function signIn(interactive = true){
    const tk = await token(interactive), u = await userinfo(tk);
    return { token:tk, ...u };
  }
  async function findBackup(tk){
    const q = encodeURIComponent("name='" + BACKUP_NAME + "' and trashed=false");
    const j = await (await call(tk, DRIVE + '/files?spaces=appDataFolder&orderBy=modifiedTime%20desc&pageSize=1&fields=files(id,name,modifiedTime,size)&q=' + q)).json();
    return (j.files && j.files[0]) || null;
  }
  async function download(tk, id){ return (await call(tk, DRIVE + '/files/' + encodeURIComponent(id) + '?alt=media')).text(); }
  // Creates the file the first time, then updates the same file.
  async function upload(tk, text, existingId){
    if (existingId) return (await call(tk, UPLOAD + '/files/' + encodeURIComponent(existingId) + '?uploadType=media&fields=id,modifiedTime', { method:'PATCH', headers:{ 'Content-Type':'application/json' }, body:text })).json();
    const b = 'yoteii' + Math.random().toString(36).slice(2);
    const body = '--' + b + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' + JSON.stringify({ name:BACKUP_NAME, parents:['appDataFolder'] }) +
      '\r\n--' + b + '\r\nContent-Type: application/json\r\n\r\n' + text + '\r\n--' + b + '--';
    return (await call(tk, UPLOAD + '/files?uploadType=multipart&fields=id,modifiedTime', { method:'POST', headers:{ 'Content-Type':'multipart/related; boundary=' + b }, body })).json();
  }
  return { token, signIn, userinfo, findBackup, download, upload };
}
