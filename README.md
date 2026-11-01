<p align="center">
  <img src="assets/icon-192.png" width="120" alt="Yoteii logo">
</p>
<h1 align="center">Yoteii</h1>
<p align="center">A daily schedule that flows from your wake time.</p>

Installable web app (PWA), no build step, no dependencies.

## Run locally
`npm start` (or any static server, e.g. `python3 -m http.server 8080`) and open http://localhost:8080.
ES modules need a server; opening index.html directly from disk will not work.

## Layout
```
index.html               page shell
sw.js                    service worker (offline cache); stays in the root so it controls the whole app
manifest.webmanifest     PWA manifest
src/
  styles.css             all styles
  js/                    main.js (app logic), engine.js (scheduling engine, pure functions),
                         dates.js, migrate.js, tasks.js, inbox.js, todo.js, history.js, wave.js, edui.js, storage.js, validate.js,
                         icons.js, about.js, templates.js, science.js, util.js
assets/                  icon.svg, favicon.svg, icon-*.png, favicon-32.png
scripts/                 build-www.mjs, android-prepare.mjs
tests/
  mjs/                   unit tests (npm test)
  py/                    browser parity checks (Playwright)
.github/workflows/       android.yml, pages.yml, test.yml
capacitor.config.json, package.json, CHANGELOG-v3.md
```
`sw.js` keeps its `SHELL` list of cached files in sync with the files above: add a new module there too.

## If the app looks broken
A red box at the bottom of the screen names the file that failed to load, or the error that stopped the app. Screenshot it.

## Releasing
Add an entry at the top of `CHANGELOG` in `src/js/about.js`, bump `APP_VERSION`, bump `version` in `package.json`, and bump `CACHE` in `sw.js` (a new cache name is what makes installed copies update).

## Deploy
Push to `main`; `.github/workflows/pages.yml` publishes to GitHub Pages (enable Pages with source "GitHub Actions" in the repo settings).

## Android app
The Android app is this same web app inside a Capacitor shell. GitHub builds it; nothing is installed locally.
- `capacitor.config.json`: app id (`app.yotei`), name and web folder.
- `scripts/build-www.mjs`: gathers the web files into `www/` (same set Pages publishes) and checks that every import and referenced file exists.
- `scripts/android-prepare.mjs`: sets the version and makes the launcher icons from `assets/icon.svg`.
- `.github/workflows/android.yml`: builds the APK and puts it on the Releases page (Actions, Android APK, Run workflow).
- Signing: add two repository secrets, `KEYSTORE_B64` and `KEYSTORE_PASSWORD`, and every build installs over the last one. Without them the build is debug-signed and cannot be updated in place.
- The Android app keeps its own data (separate from the website). Use Export, then Import to move data across.

## Parity tests (used while splitting v2.6.5 into modules)
`python3 tests/py/parity.py <site-dir> out.json` and `python3 tests/py/flows.py <site-dir> out.json` load the app in headless Chromium with a fixed clock and fixture data and save what it renders; run them on two versions and compare the JSON to prove nothing changed. `tests/py/offline.py <site-dir>` checks offline reload.
Needs `pip install playwright` and `playwright install chromium`.
