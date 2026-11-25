package br.meucontrole.cartoes;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.app.NotificationManager;
import android.content.ComponentName;
import android.provider.Settings;
import android.webkit.JavascriptInterface;
import android.webkit.JsPromptResult;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.EditText;
import android.text.InputType;
import android.app.AlertDialog;
import androidx.webkit.WebViewAssetLoader;
import java.io.ByteArrayInputStream;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

public class MainActivity extends Activity {
    private static final int PICK_FILE = 1;
    private ValueCallback<Uri[]> picker;

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        WebView web = new WebView(this);
        WebViewAssetLoader assets = new WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this))
            .build();
        web.getSettings().setJavaScriptEnabled(true);
        web.getSettings().setDomStorageEnabled(true);
        web.getSettings().setAllowFileAccess(false);
        web.addJavascriptInterface(new AlertsBridge(), "AndroidAlerts");
        web.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest request) {
                return !local(request.getUrl());
            }

            @Override public WebResourceResponse shouldInterceptRequest(WebView v, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if (local(uri)) {
                    WebResourceResponse response = assets.shouldInterceptRequest(uri);
                    if (response != null) {
                        if (uri.getPath().endsWith(".mjs")) response.setMimeType("text/javascript");
                        return response;
                    }
                }
                if ("https".equals(uri.getScheme()) && "api.github.com".equals(uri.getHost())
                        && ("/repos/picuuai/meu-controle_dados".equals(uri.getPath())
                            || "/repos/picuuai/meu-controle_dados/contents/meu-controle/lancamentos.json".equals(uri.getPath()))) {
                    return null;
                }
                return new WebResourceResponse("text/plain", "UTF-8", new ByteArrayInputStream(new byte[0]));
            }

            private boolean local(Uri uri) {
                return "https".equals(uri.getScheme()) && "appassets.androidplatform.net".equals(uri.getHost())
                    && uri.getPath() != null && uri.getPath().startsWith("/assets/");
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override public boolean onJsPrompt(WebView view, String url, String message, String value, JsPromptResult result) {
                EditText password = new EditText(MainActivity.this);
                password.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
                new AlertDialog.Builder(MainActivity.this).setTitle(message).setView(password)
                    .setPositiveButton("Abrir", (dialog, which) -> result.confirm(password.getText().toString()))
                    .setNegativeButton("Cancelar", (dialog, which) -> result.cancel())
                    .setOnCancelListener(dialog -> result.cancel()).show();
                return true;
            }

            @Override public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (picker != null) picker.onReceiveValue(null);
                picker = callback;
                try {
                    Intent file = new Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE);
                    file.setType("application/pdf");
                    startActivityForResult(file, PICK_FILE);
                } catch (android.content.ActivityNotFoundException failure) {
                    picker.onReceiveValue(null);
                    picker = null;
                }
                return true;
            }
        });
        setContentView(web);
        web.loadUrl("https://appassets.androidplatform.net/assets/index.html");
    }

    @Override protected void onActivityResult(int request, int status, Intent data) {
        super.onActivityResult(request, status, data);
        if (request != PICK_FILE || picker == null) return;
        Uri uri = status == RESULT_OK && data != null ? data.getData() : null;
        picker.onReceiveValue(uri == null ? null : new Uri[]{uri});
        picker = null;
    }

    private final class AlertsBridge {
        @JavascriptInterface public boolean enabled() {
            NotificationManager manager = getSystemService(NotificationManager.class);
            return manager.isNotificationListenerAccessGranted(new ComponentName(MainActivity.this, CardAlerts.class));
        }

        @JavascriptInterface public void openSettings() {
            runOnUiThread(() -> startActivity(new Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS)));
        }

        @JavascriptInterface public String pending() {
            JSONArray alerts = new JSONArray();
            for (Object value : CardAlerts.queue(MainActivity.this).getAll().values()) {
                if (value instanceof String) {
                    try { alerts.put(new JSONObject((String) value)); }
                    catch (JSONException ignored) { }
                }
            }
            return alerts.toString();
        }

        @JavascriptInterface public void acknowledge(String key) {
            CardAlerts.queue(MainActivity.this).edit().remove(key).apply();
        }
    }
}
