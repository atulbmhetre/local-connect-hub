importScripts("https://www.gstatic.com/firebasejs/11.0.2/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/11.0.2/firebase-messaging-compat.js");

firebase.initializeApp({
  apiKey: "AIzaSyA1QoL-WUuyj8ETULNF3jiB1TiquipMFf8",
  authDomain: "aaspaas-pro.firebaseapp.com",
  projectId: "aaspaas-pro",
  storageBucket: "aaspaas-pro.firebasestorage.app",
  messagingSenderId: "922374070559",
  appId: "1:922374070559:web:c75ca96c5050eaa5a9d02a",
});

const messaging = firebase.messaging();

function clickPathFromData(data) {
  const payload = data && typeof data === "object" ? data : {};
  const route = typeof payload.route === "string" ? payload.route.trim() : "";
  const params = new URLSearchParams();
  if (route) params.set("push_route", route);
  const routeParams = payload.route_params;
  if (typeof routeParams === "string" && routeParams.trim()) {
    params.set("push_route_params", routeParams);
  } else if (routeParams && typeof routeParams === "object") {
    params.set("push_route_params", JSON.stringify(routeParams));
  }
  const qs = params.toString();
  return qs ? "/?" + qs : "/";
}

messaging.onBackgroundMessage((payload) => {
  const data = payload?.data || {};
  const title = payload?.notification?.title || data.title || "Aaspaas";
  const body = payload?.notification?.body || data.body || "";
  return self.registration.showNotification(title, {
    body,
    data,
    icon: "/favicon.ico",
  });
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const path = clickPathFromData(event.notification.data || {});
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ("focus" in client) {
          const target = new URL(path, self.location.origin).href;
          if ("navigate" in client) {
            return client.navigate(target).then((c) => (c && "focus" in c ? c.focus() : client.focus()));
          }
          return client.focus();
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(path);
      }
      return undefined;
    }),
  );
});
