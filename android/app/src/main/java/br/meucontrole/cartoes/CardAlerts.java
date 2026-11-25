package br.meucontrole.cartoes;

import android.app.Notification;
import android.content.Context;
import android.content.SharedPreferences;
import android.os.Bundle;
import android.service.notification.NotificationListenerService;
import android.service.notification.StatusBarNotification;
import java.time.Instant;
import java.time.ZoneId;
import java.util.Locale;
import org.json.JSONException;
import org.json.JSONObject;

public class CardAlerts extends NotificationListenerService {
    private static String bankFor(String packageName) {
        switch (packageName) {
            case "com.itau":
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
        if (bank == null) return;
        Notification notification = alert.getNotification();
        if ((notification.flags & Notification.FLAG_GROUP_SUMMARY) != 0) return;
        Bundle fields = notification.extras;
        CharSequence title = fields.getCharSequence(Notification.EXTRA_TITLE, "");
        CharSequence body = fields.getCharSequence(Notification.EXTRA_BIG_TEXT,
            fields.getCharSequence(Notification.EXTRA_TEXT, ""));
        String text = title + "\n" + body;
        String lower = text.toLowerCase(Locale.ROOT);
        if (!lower.contains("compra") || !lower.contains("r$") ||
            lower.matches("(?s).*(negad|recusad|cancelad|estorn|tentativa|não aprovad|nao aprovad).*")) return;
        String key = alert.getKey() + ":" + alert.getPostTime();
        try {
            JSONObject entry = new JSONObject()
                .put("key", key).put("bank", bank).put("text", text)
                .put("date", Instant.ofEpochMilli(alert.getPostTime()).atZone(ZoneId.systemDefault()).toLocalDate().toString());
            queue(this).edit().putString(key, entry.toString()).apply();
        } catch (JSONException ignored) {
            // A malformed alert leaves the pending purchases untouched.
        }
    }
}
