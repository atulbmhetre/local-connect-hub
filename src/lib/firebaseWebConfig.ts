/**
 * Public Firebase web config (same project as Android, distinct Web app id).
 * VAPID is a client key — env overrides the fallback so TEST/PROD builds can mint tokens.
 */
export type FirebaseWebConfig = {
  apiKey: string;
  authDomain: string;
  projectId: string;
  storageBucket: string;
  messagingSenderId: string;
  appId: string;
};

export const FIREBASE_WEB_CONFIG: FirebaseWebConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY || "AIzaSyA1QoL-WUuyj8ETULNF3jiB1TiquipMFf8",
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN || "aaspaas-pro.firebaseapp.com",
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID || "aaspaas-pro",
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET || "aaspaas-pro.firebasestorage.app",
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID || "922374070559",
  appId:
    import.meta.env.VITE_FIREBASE_APP_ID || "1:922374070559:web:c75ca96c5050eaa5a9d02a",
};

const VAPID_FALLBACK =
  "BGXzp4CYQSBuwSRkcrCt37RXUCq9k7uuYFf2UYgxetAOR_ubZMRw6D0pGFp8HCpk_RY8N3mrzuarQPN_qc_8Lrs";

export function getFirebaseVapidKey(): string {
  return String(import.meta.env.VITE_FIREBASE_VAPID_KEY || VAPID_FALLBACK).trim();
}

export function isWebPushConfigReady(): boolean {
  return getFirebaseVapidKey().length > 0 && FIREBASE_WEB_CONFIG.apiKey.length > 0;
}
