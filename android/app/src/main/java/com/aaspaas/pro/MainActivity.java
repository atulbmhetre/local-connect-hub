package com.aaspaas.pro;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.media.AudioAttributes;
import android.media.RingtoneManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.webkit.WebView;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
  @Override
  public void onCreate(Bundle savedInstanceState) {
    super.onCreate(savedInstanceState);
    WebView.setWebContentsDebuggingEnabled(true);
    createOrderAlertChannel();
  }

  private void createOrderAlertChannel() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      NotificationManager nm = getSystemService(NotificationManager.class);
      if (nm.getNotificationChannel("order_alert") != null) return;
      NotificationChannel channel = new NotificationChannel(
        "order_alert",
        "Order Alerts",
        NotificationManager.IMPORTANCE_HIGH
      );
      channel.setDescription("Incoming order notifications");
      channel.enableVibration(true);
      channel.setVibrationPattern(new long[]{0, 500, 200, 500});
      channel.setBypassDnd(true);
      Uri soundUri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM);
      AudioAttributes audioAttributes = new AudioAttributes.Builder()
        .setUsage(AudioAttributes.USAGE_ALARM)
        .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
        .build();
      channel.setSound(soundUri, audioAttributes);
      nm.createNotificationChannel(channel);
    }
  }
}
