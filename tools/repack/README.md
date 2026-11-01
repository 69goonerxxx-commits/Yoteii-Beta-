# Repacking the APK without Android tools

Use this when only the web side changed (anything in index.html, src/, assets/, sw.js). No Android SDK or GitHub build needed.

    export YOTEII_P12=/path/to/yoteii-release.p12
    export YOTEII_P12_PASSWORD=...            # never save this in the project
    python3 tools/repack/build_apk.py Yoteii-4_0_1.apk Yoteii-4_0_2.apk
    python3 tools/repack/verify_apk.py Yoteii-4_0_2.apk

It needs Python 3 and the `cryptography` package (and `openssl` for the check). The build keeps every native file of the
previous APK byte for byte, replaces the web files, and signs with v1 and v2 using your key, so it installs over the old app.
`verify_apk.py` checks the zip, the v1 and v2 signatures and the certificate; run it on the previous APK first to see it pass.
Limits: it cannot change anything native (new plugins, permissions, the version number inside the manifest). For that, build on GitHub.
