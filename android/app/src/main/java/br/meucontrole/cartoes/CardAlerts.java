package br.meucontrole.cartoes;

import android.app.Notification;
import android.app.Person;
import android.content.Context;
import android.content.SharedPreferences;
import android.os.Build;
import android.os.Bundle;
import android.provider.Telephony;
import android.service.notification.NotificationListenerService;
import android.service.notification.StatusBarNotification;
import java.time.Instant;
import java.time.ZoneId;
import java.nio.charset.StandardCharsets;
import java.util.Locale;
import java.util.UUID;
import org.json.JSONException;
import org.json.JSONObject;

public class CardAlerts extends NotificationListenerService {
    private static volatile boolean connected;

    static boolean isConnected() {
        return connected;
    }
    private static String bankFor(String packageName) {
        switch (packageName) {
            case "com.itau":
            case "com.itau.pers":
            case "com.itaucard.activity":
                return "Itaú";
            case "br.com.gabba.Caixa":
            case "br.gov.caixa.cartoes":
            case "br.gov.caixa.superapp":
                return "CAIXA";
            default:
                return null;
        }
    }

    static SharedPreferences queue(Context context) {
        return context.getSharedPreferences("pending_card_purchases", MODE_PRIVATE);
    }

    @Override public void onNotificationPosted(StatusBarNotification alert) {
        String bank = bankFor(alert.getPackageName());
        if (bank == null) {
            if (alert.getPackageName().equals(Telephony.Sms.getDefaultSmsPackage(this))) captureSms(alert);
            return;
        }
        Notification notification = alert.getNotification();
        if ((notification.flags & Notification.FLAG_GROUP_SUMMARY) != 0) return;
        Bundle fields = notification.extras;
        if (fields == null) return;
        CharSequence title = fields.getCharSequence(Notification.EXTRA_TITLE, "");
        CharSequence body = fields.getCharSequence(Notification.EXTRA_BIG_TEXT, "");
        CharSequence[] lines = fields.getCharSequenceArray(Notification.EXTRA_TEXT_LINES);
        if (body.length() == 0 && lines != null) body = android.text.TextUtils.join("\n", lines);
        if (body.length() == 0) body = fields.getCharSequence(Notification.EXTRA_TEXT, "");
        String text = title + "\n" + body;
        String lower = text.toLowerCase(Locale.ROOT);
        if (!lower.contains("compra") || !lower.contains("r$") ||
            lower.matches("(?s).*(negad|recusad|cancelad|estorn|tentativa|não aprovad|nao aprovad).*")) return;
        String key = alert.getKey() + ":" + alert.getPostTime();
        save(key, bank, text, alert.getPostTime());
    }

    @Override public void onListenerConnected() {
        connected = true;
        String smsPackage = Telephony.Sms.getDefaultSmsPackage(this);
        if (smsPackage == null) return;
        StatusBarNotification[] active = getActiveNotifications();
        if (active == null) return;
        for (StatusBarNotification alert : active) {
            if (smsPackage.equals(alert.getPackageName())) captureSms(alert);
        }
    }

    @Override public void onListenerDisconnected() {
        connected = false;
    }

    private void captureSms(StatusBarNotification alert) {
        Notification notification = alert.getNotification();
        if ((notification.flags & Notification.FLAG_GROUP_SUMMARY) != 0 || notification.extras == null) return;
        Bundle fields = notification.extras;
        if (Build.VERSION.SDK_INT >= 30 && fields.containsKey(Notification.EXTRA_MESSAGES)) {
            for (Notification.MessagingStyle.Message message :
                    Notification.MessagingStyle.Message.getMessagesFromBundleArray(fields.getParcelableArray(Notification.EXTRA_MESSAGES))) {
                Person sender = message.getSenderPerson();
                if (sender != null && (isCaixaNumber(sender.getName()) || isCaixaNumber(sender.getUri()))) {
                    saveSms(message.getText(), message.getTimestamp());
                }
            }
            return;
        }
        if (!isCaixaNumber(fields.getCharSequence(Notification.EXTRA_TITLE))) return;
        CharSequence text = fields.getCharSequence(Notification.EXTRA_BIG_TEXT);
        if (text == null) text = fields.getCharSequence(Notification.EXTRA_TEXT);
        saveSms(text, alert.getPostTime());
    }

    private static boolean isCaixaNumber(CharSequence sender) {
        return sender != null && sender.toString().trim().matches("(?i)(?:tel:)?29194");
    }

    private void saveSms(CharSequence message, long timestamp) {
        if (message == null) return;
        String text = message.toString().trim();
        if (!text.matches("(?is)^(?:caixa\\s*:\\s*)?compra\\s+aprovada\\s+em\\s+.+R\\s*\\$\\s*[\\d.]+,\\d{2}.*")) return;
        if (!text.regionMatches(true, 0, "CAIXA", 0, 5)) text = "CAIXA: " + text;
        String key = "sms:" + UUID.nameUUIDFromBytes((timestamp + "\n" + text).getBytes(StandardCharsets.UTF_8));
        if (queue(this).getBoolean("seen:" + key, false)) return;
        save(key, "CAIXA", text, timestamp);
    }

    static void acknowledge(Context context, String key) {
        SharedPreferences.Editor editor = queue(context).edit().remove(key);
        if (key.startsWith("sms:")) editor.putBoolean("seen:" + key, true);
        editor.apply();
    }

    private void save(String key, String bank, String text, long timestamp) {
        try {
            JSONObject entry = new JSONObject()
                .put("key", key).put("bank", bank).put("text", text)
                .put("date", Instant.ofEpochMilli(timestamp).atZone(ZoneId.systemDefault()).toLocalDate().toString());
            queue(this).edit().putString(key, entry.toString()).apply();
        } catch (JSONException ignored) {
            // A malformed alert leaves the pending purchases untouched.
        }
    }
}
