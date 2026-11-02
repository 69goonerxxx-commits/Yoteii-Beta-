// Adds Google sign-in to the generated Android project: a small Capacitor plugin (YoteiGoogle) that asks Google for an access
// token with the Drive "app data" scope, the Google Play services dependency, and the plugin's registration in MainActivity.
// Called from android-prepare.mjs after `npx cap add android`. Like the other steps it warns instead of failing, and it never
// leaves the project half done: the plugin is only written when the dependency was added.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

export const PLAY_AUTH = 'com.google.android.gms:play-services-auth:21.3.0';

export function pluginSource(appId){
  return `package ${appId};

import android.app.Activity;
import android.app.PendingIntent;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.IntentSenderRequest;
import androidx.activity.result.contract.ActivityResultContracts;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.android.gms.auth.api.identity.AuthorizationRequest;
import com.google.android.gms.auth.api.identity.AuthorizationResult;
import com.google.android.gms.auth.api.identity.Identity;
import com.google.android.gms.common.api.ApiException;
import com.google.android.gms.common.api.Scope;
import java.util.Arrays;
import java.util.List;

// Gives the web side a Google access token for the signed-in account. The web side then talks to Google Drive itself.
// The token is limited to Drive's private app data folder plus the person's email and name.
@CapacitorPlugin(name = "YoteiGoogle")
public class YoteiGooglePlugin extends Plugin {
    private static final String DRIVE_APPDATA = "https://www.googleapis.com/auth/drive.appdata";
    private ActivityResultLauncher<IntentSenderRequest> launcher;
    private PluginCall pending;

    @Override
    public void load() {
        // Must be registered while the activity is starting, which is when Capacitor loads its plugins.
        launcher = getActivity().registerForActivityResult(new ActivityResultContracts.StartIntentSenderForResult(), result -> {
            PluginCall call = pending;
            pending = null;
            if (call == null) return;
            if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null) {
                call.reject("Sign-in was cancelled.", "CANCELLED");
                return;
            }
            try {
                AuthorizationResult res = Identity.getAuthorizationClient(getActivity()).getAuthorizationResultFromIntent(result.getData());
                deliver(call, res);
            } catch (ApiException e) {
                call.reject("Google sign-in failed: " + e.getStatusCode() + ": " + e.getMessage(), "FAILED");
            }
        });
    }

    // authorize({ interactive }): with interactive false it only answers when Google already has the person's consent,
    // and otherwise resolves { needsUi: true } so the app can ask on a screen the person can see.
    @PluginMethod
    public void authorize(PluginCall call) {
        Boolean wanted = call.getBoolean("interactive", true);
        final boolean interactive = wanted == null || wanted;
        List<Scope> scopes = Arrays.asList(new Scope(DRIVE_APPDATA), new Scope("email"), new Scope("profile"));
        AuthorizationRequest request = AuthorizationRequest.builder().setRequestedScopes(scopes).build();
        Identity.getAuthorizationClient(getActivity())
            .authorize(request)
            .addOnSuccessListener(res -> {
                if (!res.hasResolution()) {
                    deliver(call, res);
                    return;
                }
                if (!interactive) {
                    JSObject out = new JSObject();
                    out.put("needsUi", true);
                    call.resolve(out);
                    return;
                }
                PendingIntent pi = res.getPendingIntent();
                if (pi == null) {
                    call.reject("Google sign-in could not start.", "FAILED");
                    return;
                }
                pending = call;
                try {
                    launcher.launch(new IntentSenderRequest.Builder(pi.getIntentSender()).build());
                } catch (Exception e) {
                    pending = null;
                    call.reject("Google sign-in could not start: " + e.getMessage(), "FAILED");
                }
            })
            .addOnFailureListener(e -> call.reject("Google sign-in failed: " + e.getMessage(), "FAILED"));
    }

    private void deliver(PluginCall call, AuthorizationResult res) {
        String token = res.getAccessToken();
        if (token == null) {
            call.reject("Google did not give access.", "FAILED");
            return;
        }
        JSObject out = new JSObject();
        out.put("accessToken", token);
        call.resolve(out);
    }
}
`;
}

export function mainActivitySource(appId, plugins){
  return `package ${appId};

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
${plugins.map(p => `        registerPlugin(${p}.class);`).join('\n')}
        super.onCreate(savedInstanceState);
    }
}
`;
}

// root: the folder that holds android/ (the project root). Returns true when everything was added.
export function addGooglePlugin({ root = '.', warn = m => console.warn('WARNING: ' + m) } = {}){
  const APP = `${root}/android/app/src/main`, gradleFile = `${root}/android/app/build.gradle`;
  const appId = JSON.parse(readFileSync(`${root}/capacitor.config.json`, 'utf8')).appId || 'app.yotei';
  const dir = `${APP}/java/${appId.replace(/\./g, '/')}`, mainFile = `${dir}/MainActivity.java`;
  if (!existsSync(mainFile) || !existsSync(gradleFile)){ warn('MainActivity.java or app/build.gradle not found, so Google sign-in was not added'); return false; }
  const main = readFileSync(mainFile, 'utf8');
  if (!/extends\s+BridgeActivity/.test(main)){ warn('MainActivity.java looks different from expected, so Google sign-in was not added'); return false; }

  let g = readFileSync(gradleFile, 'utf8');
  if (!g.includes('play-services-auth')){
    const next = g.replace(/dependencies\s*\{/, m => `${m}\n    implementation "${PLAY_AUTH}"`);
    if (next === g){ warn('could not add the Google Play services dependency, so Google sign-in was not added'); return false; }
    writeFileSync(gradleFile, next);
  }
  writeFileSync(`${dir}/YoteiGooglePlugin.java`, pluginSource(appId));
  const plugins = ['YoteiFilesPlugin', 'YoteiGooglePlugin'].filter(p => existsSync(`${dir}/${p}.java`));
  writeFileSync(mainFile, mainActivitySource(appId, plugins));
  console.log('Google sign-in plugin added');
  return true;
}
