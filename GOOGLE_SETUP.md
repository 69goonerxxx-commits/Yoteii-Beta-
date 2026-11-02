# Setting up Google sign-in (one time)

Yoteii 4.0.2 can sign in with Google and keep a backup in the person's own Google Drive. The app code is done; Google also has to know about the app. You do this once, in a web browser.

The backup goes in Drive's private "app data" folder. Only Yoteii can read it, and it does not appear in the person's Drive files.

## 1. Google Cloud

1. Go to https://console.cloud.google.com and sign in with the Google account you want to own the app.
2. Create a project. Call it Yoteii.
3. Menu, APIs and services, Library. Search for **Google Drive API** and press **Enable**.
4. Menu, APIs and services, **OAuth consent screen** (it may be called Google Auth Platform).
   - User type: **External**. App name: Yoteii. Add your email as the support email and developer contact.
   - Data access, Add scopes: `.../auth/drive.appdata`, plus `email` and `profile`.
   - Audience: add your own Google account as a test user.
5. Menu, APIs and services, **Credentials**, Create credentials, **OAuth client ID**.
   - Application type: **Android**.
   - Package name: `app.yotei`
   - SHA-1 certificate fingerprint: `85:C3:C3:22:0E:58:5F:76:63:F3:EE:5A:4F:2C:03:04:11:31:39:69` (this is the fingerprint of yoteii-release.p12)
   - Press Create. There is nothing to copy into the app: Google matches the app by its package name and signature.
6. When it works for you, go back to the OAuth consent screen and press **Publish app** (In production). The scope Yoteii asks for is not a sensitive one, so no review is needed. While the app stays in Testing, Google ends the sign-in after 7 days and people have to sign in again.

If you ever publish the app on Google Play with Play App Signing, add Google's signing SHA-1 as a second Android client.

## 2. Build the app on GitHub

1. Upload the project to a GitHub repository. Rename the folder `github` to `.github`.
2. Settings, Secrets and variables, Actions: add `KEYSTORE_B64` (yoteii-release.p12 as base64 text) and `KEYSTORE_PASSWORD`. Without them the build is signed with a throwaway key and will not install over your current app.
3. Actions, run the Android workflow. Download the APK it makes and install it over the old app.
4. If the build stops with a Java error in the "Build" step, copy the red lines and send them over. The Google plugin was written and checked here but could not be compiled against Android's real libraries.

## 3. What you will see

- First launch: Continue with Google, or Continue without an account.
- If a backup exists in the Drive of the account you pick: "We found a backup", with Restore this backup or Start fresh.
- Settings, Google Drive: Back up now, Restore, automatic backup on or off, Sign out.
- "Google sign-in is not set up for this app yet": step 5 above does not match the app's signature, or the Drive API (step 3) is not enabled.
