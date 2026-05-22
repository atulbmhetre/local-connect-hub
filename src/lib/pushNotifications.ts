import { Capacitor } from "@capacitor/core";
import { PushNotifications } from "@capacitor/push-notifications";
import { supabase } from "@/lib/supabase";

export async function registerPushToken(vendorId: string) {
  if (!Capacitor.isNativePlatform()) return;

  const permission = await PushNotifications.requestPermissions();
  if (permission.receive !== "granted") return;

  await PushNotifications.createChannel({
    id: "default",
    name: "Default Channel",
    description: "General App Notifications",
    importance: 5,
    visibility: 1,
    sound: "default",
  });

  await PushNotifications.register();

  await PushNotifications.removeAllListeners();

  await PushNotifications.addListener("registration", async (token) => {
    const { error } = await supabase
      .from("vendors")
      .update({ fcm_token: token.value })
      .eq("id", vendorId);
    if (error) {
      console.error("Push token save failed", error);
    }
  });

  await PushNotifications.addListener("registrationError", (error) => {
    console.error("Push registration failed", error);
  });

  await PushNotifications.addListener("pushNotificationReceived", (notification) => {
    console.info("Push received in foreground", notification);
  });

  await PushNotifications.addListener("pushNotificationActionPerformed", (action) => {
    console.info("Push tapped", action);
  });
}
