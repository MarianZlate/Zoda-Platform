/**
 * Service Worker — Zoda PWA
 *
 * Strategie:
 * - Pagini HTML: network-first (mereu încearcă live, cade pe cache dacă nu are net,
 *   cade pe offline.html dacă nici cache nu are nimic) — nu vrem date vechi de platformă.
 * - Poze din R2 (capturi, avatare, standuri): cache-first — numele fișierelor sunt
 *   unice per upload (timestamp+random), deci o poză deja încărcată nu se mai schimbă
 *   niciodată sub același URL. Sigur de cache-uit agresiv, îmbunătățește mult viteza
 *   la semnal slab de la baltă.
 * - Assets statice proprii (logo, backgrounds, iconițe, manifest): stale-while-revalidate.
 * - Tot ce ține de Supabase (API/auth) și de Workers (upload, turnstile): NICIODATĂ cache,
 *   trece direct prin rețea — sunt date live, esențiale pentru corectitudinea platformei.
 *
 * Actualizează CACHE_VERSION când schimbi lista de shell assets, ca userii să
 * primească automat noua versiune la următoarea vizită.
 */

const CACHE_VERSION = 'zoda-v4';
const SHELL_CACHE = `zoda-shell-${CACHE_VERSION}`;
const R2_CACHE = 'zoda-r2-media';

const R2_HOST = 'pub-fda2d3aa026d452c90420b8823e31d3b.r2.dev';

const SHELL_ASSETS = [
  '/index.html',
  '/balta.html',
  '/cont.html',
  '/pescar.html',
  '/admin.html',
  '/ambasador-galerie.html',
  '/confidentialitate.html',
  '/cookie-uri.html',
  '/termeni.html',
  '/offline.html',
  '/manifest.json',
  '/zoda-logo.png',
  '/zoda-logo-light.png',
  '/hero-bg.jpg',
  '/balta-bg.jpg',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) =>
      // addAll ar eșua complet dacă UN SINGUR fișier lipsește — folosim
      // Promise.allSettled ca instalarea să nu pice dacă un asset opțional dă 404.
      Promise.allSettled(SHELL_ASSETS.map((url) => cache.add(url)))
    ).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== SHELL_CACHE && key !== R2_CACHE)
          .map((key) => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return; // POST-urile (upload, RPC) trec mereu direct

  const url = new URL(request.url);

  // ── Navigare (pagini HTML) — network-first ──────────────────────────────
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((resp) => {
          const clone = resp.clone();
          caches.open(SHELL_CACHE).then((cache) => cache.put(request, clone));
          return resp;
        })
        .catch(() =>
          caches.match(request).then((cached) => cached || caches.match('/offline.html'))
        )
    );
    return;
  }

  // ── Poze din R2 — cache-first (URL-uri unice, sigur de păstrat) ─────────
  if (url.hostname === R2_HOST) {
    event.respondWith(
      caches.open(R2_CACHE).then((cache) =>
        cache.match(request).then((cached) => {
          if (cached) return cached;
          return fetch(request).then((resp) => {
            if (resp.ok) cache.put(request, resp.clone());
            return resp;
          });
        })
      )
    );
    return;
  }

  // ── Supabase / Workers (date live) — niciodată cache, doar rețea ───────
  if (url.hostname.includes('supabase.co') || url.hostname.includes('workers.dev')) {
    return; // lăsăm browserul să facă fetch-ul normal, necache-uit
  }

  // ── Assets statice proprii (same-origin) — stale-while-revalidate ──────
  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.open(SHELL_CACHE).then((cache) =>
        cache.match(request).then((cached) => {
          const fetchPromise = fetch(request)
            .then((resp) => {
              if (resp.ok) cache.put(request, resp.clone());
              return resp;
            })
            .catch(() => cached);
          return cached || fetchPromise;
        })
      )
    );
  }
  // orice altceva (fonturi externe, CDN-uri terțe) — comportament implicit al browserului
});

// ── PUSH NOTIFICATIONS ───────────────────────────────────────────────────
// Primește mesajul push (trimis de Worker-ul zoda-push-send) și afișează
// notificarea nativă pe telefon, chiar și cu aplicația/tab-ul închis.
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) {}
  const title = data.title || 'Zoda';
  const options = {
    body: data.body || '',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    data: { url: data.url || '/cont.html' },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

// La click pe notificare — deschide pagina relevantă, sau focalizează
// tab-ul deja deschis dacă platforma e deja activă într-un tab.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const rawUrl = (event.notification.data && event.notification.data.url) || '/cont.html';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.url.includes(new URL(rawUrl, self.location.origin).pathname) && 'focus' in client) {
          return client.focus();
        }
      }
      // Tab nou — trecem prin index.html?redirect=... în loc de link direct.
      // Un tab deschis de OS (din notificare) n-are nicio pagină anterioară în
      // istoric; fără acest pas, butonul fizic "înapoi" al telefonului iese
      // direct din aplicație în loc să navigheze înapoi. Vezi index.html pentru
      // partea care consumă parametrul.
      const openUrl = '/index.html?redirect=' + encodeURIComponent(rawUrl);
      if (clients.openWindow) return clients.openWindow(openUrl);
    })
  );
});

// ── RENEWAL AUTOMATĂ A ABONAMENTULUI (pushsubscriptionchange) ───────────
// De ce există acest bloc: browserul poate invalida sau roti SINGUR endpoint-ul
// de push al userului (de obicei tocmai după o perioadă în care userul NU a mai
// deschis pagina/PWA-ul) — fără avertisment vizibil pentru user. Până acum,
// service worker-ul nu asculta deloc acest eveniment, deci endpoint-ul vechi
// rămânea salvat, neschimbat, în `push_subscriptions`. Worker-ul zoda-push-send
// continua să trimită push-uri spre acel endpoint mort, care eșuau silențios —
// userul nu primea nimic pe telefon, deși rândul din `notificari` se crea normal
// și apărea în listă abia când redeschidea manual aplicația. Acest listener
// reabonează automat, din fundal, ȘI ÎNCEARCĂ să actualizeze rândul din Supabase
// fără să aștepte vreo vizită — repară situația chiar dacă userul nu deschide
// aplicația o vreme.
//
// Necesită funcția RPC `zoda_renew_push_subscription` în Supabase (livrată
// separat ca fișier .sql, de rulat manual în SQL Editor) — vezi
// 2026-09-04_renew_push_subscription.sql.
const SW_SUPA_URL = 'https://emnesflrzptqfttlzusw.supabase.co';
const SW_SUPA_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVtbmVzZmxyenB0cWZ0dGx6dXN3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE5NTc5NDUsImV4cCI6MjA5NzUzMzk0NX0.LoR6peujcdm1SLZ8SUSdtSH8wDa_ptCUEYT3qtAPZXk';
// Aceeași cheie publică VAPID ca în cont.html/index.html — dacă o schimbi
// acolo vreodată, schimb-o și aici (nu există un singur loc comun, fiind
// fișiere HTML separate + acest worker, fără build step).
const SW_VAPID_PUBLIC_KEY = 'BME-SOgjhV3uy7WCn1AGeYju0XnBsOqGqGW2Vp9SCrwGFlJr9L_d3Ni82FuDqkKDpDh6O9wx2EGAxukg9Wrfwqo';

function swUrlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  return Uint8Array.from([...rawData].map((c) => c.charCodeAt(0)));
}

self.addEventListener('pushsubscriptionchange', (event) => {
  // Unele browsere dau event.oldSubscription, altele nu — dacă lipsește, nu
  // avem cum să identificăm rândul vechi din Supabase ca să-l actualizăm;
  // reabonarea tot merge, dar sincronizarea cu DB va aștepta următoarea
  // deschidere a paginii (initPushToggleState din cont.html/index.html).
  const oldEndpoint = event.oldSubscription ? event.oldSubscription.endpoint : null;
  const appServerKey =
    (event.oldSubscription && event.oldSubscription.options && event.oldSubscription.options.applicationServerKey) ||
    swUrlBase64ToUint8Array(SW_VAPID_PUBLIC_KEY);

  event.waitUntil(
    self.registration.pushManager
      .subscribe({ userVisibleOnly: true, applicationServerKey: appServerKey })
      .then((newSub) => {
        if (!oldEndpoint) return;
        const json = newSub.toJSON();
        return fetch(`${SW_SUPA_URL}/rest/v1/rpc/zoda_renew_push_subscription`, {
          method: 'POST',
          headers: {
            'apikey': SW_SUPA_ANON_KEY,
            'Authorization': `Bearer ${SW_SUPA_ANON_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            p_old_endpoint: oldEndpoint,
            p_new_endpoint: json.endpoint,
            p_p256dh: json.keys.p256dh,
            p_auth_key: json.keys.auth,
          }),
        });
      })
      .catch(() => {
        // Eșec silențios (ex. reabonare refuzată de browser) — la următoarea
        // deschidere a paginii, initPushToggleState() detectează getSubscription()
        // == null și userul poate reactiva manual din "Contul meu".
      })
  );
});
