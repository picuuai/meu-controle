package br.meucontrole.cartoes;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Bundle;
import android.os.Build;
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
import android.widget.Toast;
import android.text.InputType;
import android.app.AlertDialog;
import androidx.webkit.WebViewAssetLoader;
import com.google.zxing.integration.android.IntentIntegrator;
import com.google.zxing.integration.android.IntentResult;
import java.io.ByteArrayInputStream;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.atomic.AtomicReference;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

public class MainActivity extends Activity {
    private static final int PICK_FILE = 1;
    private static final int SCAN_PAIRING = 2;
    private ValueCallback<Uri[]> picker;
    private final ConcurrentLinkedQueue<String> sharedMessages = new ConcurrentLinkedQueue<>();
    private final AtomicReference<String> pairingCode = new AtomicReference<>();

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        receiveSharedMessage(getIntent());
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
                            || "/repos/picuuai/meu-controle_dados/contents/meu-controle/lancamentos.json".equals(uri.getPath())
                            || "/repos/picuuai/meu-controle/releases/latest".equals(uri.getPath()))) {
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
                    if (String.join(",", params.getAcceptTypes()).contains("application/pdf")) {
                        file.setType("application/pdf");
                    } else {
                        file.setType("*/*").putExtra(Intent.EXTRA_MIME_TYPES, new String[]{"application/xml","text/xml","text/plain"});
                    }
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
        if (sharedMessages.isEmpty()) offerNotificationAccess();
    }

    @Override protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        receiveSharedMessage(intent);
    }

    private void receiveSharedMessage(Intent intent) {
        if (intent == null || !Intent.ACTION_SEND.equals(intent.getAction()) || !"text/plain".equals(intent.getType())) return;
        CharSequence text = intent.getCharSequenceExtra(Intent.EXTRA_TEXT);
        if (text != null && text.length() > 0 && text.length() <= 8192) {
            sharedMessages.add(text.toString());
            intent.removeExtra(Intent.EXTRA_TEXT);
        }
    }

    private ComponentName notificationListener() {
        return new ComponentName(this, CardAlerts.class);
    }

    private boolean notificationAccessGranted() {
        return getSystemService(NotificationManager.class).isNotificationListenerAccessGranted(notificationListener());
    }

    private void offerNotificationAccess() {
        SharedPreferences preferences = getSharedPreferences("device_setup", MODE_PRIVATE);
        if (notificationAccessGranted() || preferences.getBoolean("notification_access_explained", false)) return;
        new AlertDialog.Builder(this)
            .setTitle("Autorizar alertas de compra")
            .setMessage("O Android precisa da sua autorização para mostrar no Meu Controle os alertas de compras dos bancos e do SMS 29194. Os avisos ficam na fila para sua revisão. Para usar um SMS antigo, compartilhe o texto pelo app Mensagens.")
            .setPositiveButton("Abrir configurações", (dialog, which) -> openNotificationSettings())
            .setNegativeButton("Agora não", null)
            .setOnDismissListener(dialog -> preferences.edit().putBoolean("notification_access_explained", true).apply())
            .show();
    }

    private void openNotificationSettings() {
        if (Build.VERSION.SDK_INT >= 30) {
            Intent details = new Intent(Settings.ACTION_NOTIFICATION_LISTENER_DETAIL_SETTINGS)
                .putExtra(Settings.EXTRA_NOTIFICATION_LISTENER_COMPONENT_NAME, notificationListener().flattenToString());
            try {
                startActivity(details);
                return;
            } catch (ActivityNotFoundException ignored) {
                // Some manufacturers only expose the general list.
            }
        }
        try {
            startActivity(new Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS));
        } catch (ActivityNotFoundException ignored) {
            Toast.makeText(this, "Nas configurações do Android, procure Acesso às notificações.", Toast.LENGTH_LONG).show();
        }
    }

    @Override protected void onActivityResult(int request, int status, Intent data) {
        super.onActivityResult(request, status, data);
        if (request == SCAN_PAIRING) {
            IntentResult scan = IntentIntegrator.parseActivityResult(status, data);
            String result = scan == null ? null : scan.getContents();
            if (result != null && result.length() <= 1024 && result.startsWith("MC1.")) pairingCode.set(result);
            else if (result != null) Toast.makeText(this, "QR de pareamento inválido.", Toast.LENGTH_SHORT).show();
            return;
        }
        if (request != PICK_FILE || picker == null) return;
        Uri uri = status == RESULT_OK && data != null ? data.getData() : null;
        picker.onReceiveValue(uri == null ? null : new Uri[]{uri});
        picker = null;
    }

    private final class AlertsBridge {
        @JavascriptInterface public boolean enabled() {
            return notificationAccessGranted();
        }

        @JavascriptInterface public boolean connected() {
            return CardAlerts.isConnected();
        }

        @JavascriptInterface public void openSettings() {
            runOnUiThread(MainActivity.this::openNotificationSettings);
        }

        @JavascriptInterface public String takeSharedMessage() {
            return sharedMessages.poll();
        }

        @JavascriptInterface public void scanPairing() {
            runOnUiThread(() -> new IntentIntegrator(MainActivity.this)
                .setRequestCode(SCAN_PAIRING)
                .setDesiredBarcodeFormats(IntentIntegrator.QR_CODE)
                .setPrompt("Aponte para o QR gerado no Meu Controle web")
                .setBeepEnabled(false)
                .initiateScan());
        }

        @JavascriptInterface public String takePairingCode() {
            return pairingCode.getAndSet(null);
        }

        @JavascriptInterface public int installedVersion() {
            return BuildConfig.VERSION_CODE;
        }

        @JavascriptInterface public void downloadUpdate(String url) {
            if (url == null || !url.matches("https://github\\.com/picuuai/meu-controle/releases/download/android-\\d+/meu-controle-android\\.apk")) return;
            runOnUiThread(() -> {
              try {
                startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
              } catch (ActivityNotFoundException ignored) {
                Toast.makeText(MainActivity.this, "Abra o link de download em um navegador.", Toast.LENGTH_LONG).show();
              }
            });
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
            CardAlerts.acknowledge(MainActivity.this, key);
        }
    }
}
