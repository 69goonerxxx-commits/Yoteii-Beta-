// Runs after `npx cap add android`: sets the version number, makes the launcher icons from assets/icon.svg,
// and (later) any manifest changes. Every step reports what it did, and warns instead of failing
// if the generated project looks different from what is expected.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';

const APP = 'android/app/src/main';
const warn = m => console.warn('WARNING: ' + m);

// ---- version: 3.0.0 -> name "3.0.0", code 3 * 10000 + 0 * 100 + 0, times 1000, plus the build number ----
const version = JSON.parse(readFileSync('package.json', 'utf8')).version;
const [maj, min, pat] = version.split('.').map(n => parseInt(n, 10) || 0);
const code = (maj * 10000 + min * 100 + pat) * 1000 + Math.min(parseInt(process.env.BUILD_NUMBER || '0', 10) || 0, 999);
{
  const f = 'android/app/build.gradle';
  let g = readFileSync(f, 'utf8'), n = 0;
  g = g.replace(/versionCode\s+\d+/, () => { n++; return 'versionCode ' + code; }).replace(/versionName\s+"[^"]*"/, () => { n++; return 'versionName "' + version + '"'; });
  if (n !== 2) warn('could not set the version in ' + f);
  writeFileSync(f, g);
  console.log(`version ${version}, versionCode ${code}`);
}

// ---- launcher icons, drawn from assets/icon.svg ----
const { default: sharp } = await import('sharp');
const svg = readFileSync('assets/icon.svg', 'utf8');
const inner = svg.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '');
const defs = (inner.match(/<defs>[\s\S]*?<\/defs>/) || [''])[0];
const art = inner.replace(defs, '').replace(/<rect[^>]*\/>/g, '').replace('<g clip-path="url(#corners)">', '<g>');   // no rounded-square clip, so the glow is not cut off
const wrap = body => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">${body}</svg>`;
const foreground = wrap(defs + `<g transform="translate(97.28 97.28) scale(0.62)">${art}</g>`);
const maskable = wrap(defs + '<rect width="512" height="512" fill="#0a1222"/><g transform="translate(51.2 51.2) scale(0.8)">' + art + '</g>');   // the logo at 80% on a full background, for the round legacy icon
const DENSITY = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };
const roundMask = n => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${n}" height="${n}"><circle cx="${n / 2}" cy="${n / 2}" r="${n / 2}"/></svg>`);
for (const [d, k] of Object.entries(DENSITY)) {
  const dir = `${APP}/res/mipmap-${d}`; mkdirSync(dir, { recursive: true });
  const px = Math.round(48 * k), big = Math.round(108 * k);
  const square = await sharp(Buffer.from(svg), { density: 384 }).resize(px, px).png().toBuffer();
  await sharp(square).toFile(`${dir}/ic_launcher.png`);
  const roundSq = await sharp(Buffer.from(maskable), { density: 384 }).resize(px, px).png().toBuffer();
  await sharp(roundSq).composite([{ input: roundMask(px), blend: 'dest-in' }]).png().toFile(`${dir}/ic_launcher_round.png`);
  await sharp(Buffer.from(foreground), { density: 384 }).resize(big, big).png().toFile(`${dir}/ic_launcher_foreground.png`);
}
mkdirSync(`${APP}/res/mipmap-anydpi-v26`, { recursive: true });
mkdirSync(`${APP}/res/values`, { recursive: true });
const adaptive = '<?xml version="1.0" encoding="utf-8"?>\n<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">\n    <background android:drawable="@color/ic_launcher_background"/>\n    <foreground android:drawable="@mipmap/ic_launcher_foreground"/>\n</adaptive-icon>\n';
writeFileSync(`${APP}/res/mipmap-anydpi-v26/ic_launcher.xml`, adaptive);
writeFileSync(`${APP}/res/mipmap-anydpi-v26/ic_launcher_round.xml`, adaptive);
writeFileSync(`${APP}/res/values/ic_launcher_background.xml`, '<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">#0A1222</color>\n</resources>\n');
console.log('launcher icons written');

// ---- plain launch screen ----
// Android shows its own icon splash before Yotei starts. Make it a plain colour (the same as the loading screen) with no icon,
// so the first thing you see is the Yotei dots screen. Only done when the template is the one we expect.
{
  const f = `${APP}/res/values/styles.xml`;
  if (!existsSync(f)) warn('styles.xml not found, so the Android launch screen stays as it is');
  else {
    let x = readFileSync(f, 'utf8');
    const re = /(<style\s+name="AppTheme\.NoActionBarLaunch"\s+parent="Theme\.SplashScreen"[^>]*>)([\s\S]*?)(<\/style>)/;
    const mm = re.exec(x);
    if (!mm) warn('launch theme looks different from expected, so the Android launch screen stays as it is');
    else if (!/windowSplashScreenBackground/.test(mm[2])) {
      const inner = mm[2].replace(/<item\s+name="android:background">[^<]*<\/item>/, '<item name="android:background">#0A1222</item>');
      x = x.replace(re, `${mm[1]}\n        <item name="windowSplashScreenBackground">#0A1222</item>\n        <item name="windowSplashScreenAnimatedIcon">@android:color/transparent</item>${inner}${mm[3]}`);
      writeFileSync(f, x); console.log('plain launch screen set');
    }
  }
}

// ---- native helper: save the backup straight into Downloads ----
// (a web page inside the app cannot download files, so Export asks this small plugin to write into the Downloads folder.
//  If anything here looks different from what is expected we skip it, and the app falls back to the share sheet.)
{
  const appId = JSON.parse(readFileSync('capacitor.config.json', 'utf8')).appId || 'app.yotei';
  const dir = `${APP}/java/${appId.replace(/\./g, '/')}`, mainFile = `${dir}/MainActivity.java`;
  if (!existsSync(mainFile)) warn('MainActivity.java not found, so Export will use the share sheet');
  else {
    const main = readFileSync(mainFile, 'utf8');
    if (!/extends\s+BridgeActivity/.test(main)) warn('MainActivity.java looks different from expected, so Export will use the share sheet');
    else {
      writeFileSync(`${dir}/YoteiFilesPlugin.java`, `package ${appId};

import android.annotation.TargetApi;
import android.content.ContentResolver;
import android.content.ContentUris;
import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;

@CapacitorPlugin(name = "YoteiFiles")
public class YoteiFilesPlugin extends Plugin {
    @TargetApi(Build.VERSION_CODES.Q)
    @PluginMethod
    public void saveToDownloads(PluginCall call) {
        String name = call.getString("name");
        String data = call.getString("data");
        String mime = call.getString("mime", "application/octet-stream");
        if (name == null || data == null) {
            call.reject("Missing name or data");
            return;
        }
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            call.reject("Needs Android 10 or newer");
            return;
        }
        try {
            Context ctx = getContext();
            ContentValues values = new ContentValues();
            values.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
            values.put(MediaStore.MediaColumns.MIME_TYPE, mime);
            values.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/Yotei");
            Uri uri = ctx.getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
            if (uri == null) {
                call.reject("Could not create the file");
                return;
            }
            try (OutputStream out = ctx.getContentResolver().openOutputStream(uri)) {
                if (out == null) {
                    call.reject("Could not open the file");
                    return;
                }
                out.write(data.getBytes(StandardCharsets.UTF_8));
            }
            JSObject ret = new JSObject();
            ret.put("uri", uri.toString());
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("Could not save: " + e.getMessage());
        }
    }

    @TargetApi(Build.VERSION_CODES.Q)
    @PluginMethod
    public void trimBackups(PluginCall call) {
        String prefix = call.getString("prefix");
        Integer keep = call.getInt("keep", 8);
        if (prefix == null) {
            call.reject("Missing prefix");
            return;
        }
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            call.resolve();
            return;
        }
        try {
            ContentResolver cr = getContext().getContentResolver();
            Uri collection = MediaStore.Downloads.EXTERNAL_CONTENT_URI;
            String[] projection = { MediaStore.MediaColumns._ID };
            String selection = MediaStore.MediaColumns.RELATIVE_PATH + " = ? AND " + MediaStore.MediaColumns.DISPLAY_NAME + " LIKE ?";
            String[] args = { Environment.DIRECTORY_DOWNLOADS + "/Yotei/", prefix + "%" };
            int removed = 0;
            try (Cursor c = cr.query(collection, projection, selection, args, MediaStore.MediaColumns.DATE_ADDED + " DESC")) {
                if (c != null) {
                    int idCol = c.getColumnIndexOrThrow(MediaStore.MediaColumns._ID);
                    int n = 0;
                    while (c.moveToNext()) {
                        n++;
                        if (n <= keep) continue;
                        Uri u = ContentUris.withAppendedId(collection, c.getLong(idCol));
                        removed += cr.delete(u, null, null);
                    }
                }
            }
            JSObject ret = new JSObject();
            ret.put("removed", removed);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("Could not tidy old backups: " + e.getMessage());
        }
    }
}
`);
      if (!/registerPlugin\(\s*YoteiFilesPlugin/.test(main)) {
        writeFileSync(mainFile, `package ${appId};

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(YoteiFilesPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
`);
      }
      console.log('Downloads helper added');
    }
  }
}

// ---- small icon for reminder notifications: Android wants a white shape on a transparent background ----
{
  const glyph = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><defs><mask id="k" maskUnits="userSpaceOnUse" x="0" y="0" width="512" height="512"><rect width="512" height="512" fill="#fff"/><path fill="#000" transform="translate(256 256) scale(0.3548 -0.3548) translate(-508.0 -355.5)" d="M283 530C333 513 394 491 454 468H43V330H431V61C431 46 425 43 405 42C385 42 307 42 253 45C274 7 298 -54 306 -95C391 -95 460 -93 513 -73C567 -53 583 -16 583 56V330H755C736 292 716 255 697 227L822 155C876 227 934 330 973 427L853 478L828 468H695L724 515L652 542C730 597 806 663 867 723L763 806L730 798H142V665H590C561 640 528 615 497 595L355 640Z"/></mask></defs><circle cx="256" cy="256" r="248" fill="#fff" mask="url(#k)"/></svg>`;   // the 予 disc, cut out of a solid white circle
  for (const [d, k] of Object.entries(DENSITY)) {
    const dir = `${APP}/res/drawable-${d}`; mkdirSync(dir, { recursive: true });
    const px = Math.round(24 * k);
    await sharp(Buffer.from(glyph), { density: 384 }).resize(px, px).png().toFile(`${dir}/ic_stat_yotei.png`);
  }
  console.log('notification icon written');
}

if (!existsSync(`${APP}/AndroidManifest.xml`)) warn('AndroidManifest.xml not found');
