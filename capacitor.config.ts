import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.aaspaas.pro',
  appName: 'Aaspaas Pro',
  webDir: 'dist',
  android: {
    // Required by @capgo/background-geolocation so JS location callbacks
    // keep flowing after ~5 minutes in the background.
    useLegacyBridge: true,
  },
  plugins: {
    PushNotifications: {
      presentationOptions: ["badge", "sound", "alert"],
    },
    // Native HTTP so patchVendorOwn keeps working while the WebView is
    // background-throttled during FGS location tracking.
    CapacitorHttp: {
      enabled: true,
    },
  },
};

export default config;
