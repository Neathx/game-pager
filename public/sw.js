// Service worker: shows the pages as phone notifications and opens the app when tapped.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("push", (e) => {
  let d = {};
  try {
    d = e.data ? e.data.json() : {};
  } catch {
    d = { body: e.data ? e.data.text() : "" };
  }
  e.waitUntil(
    (async () => {
      await self.registration.showNotification(d.title || "Game Pager", {
        body: d.body || "",
        tag: d.tag || undefined,
        renotify: !!d.tag,
        icon: "/icons/icon-192.png",
        badge: "/icons/badge-96.png",
        data: { url: "/" },
      });
      const windows = await self.clients.matchAll({ type: "window" });
      windows.forEach((w) => w.postMessage("refresh"));
    })()
  );
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const w of windows) if ("focus" in w) return w.focus();
      return self.clients.openWindow("/");
    })()
  );
});
