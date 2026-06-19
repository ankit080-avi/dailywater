# DailyWater

A mobile-first **water-delivery management** app for water suppliers — handles customers, daily deliveries, billing, pauses, extra orders, and subscriptions. Multi-tenant: one admin oversees many independent supplier "owners," each managing their own customers and delivery staff.

Rebranded from the **MilkMate** dairy-manager template (same engine, water-themed).

- **Live PWA:** https://ankit080-avi.github.io/dailywater/
- **Repo:** https://github.com/ankit080-avi/dailywater (branch `main`)
- **Android package:** `com.dailywater.app`

---

## Tech stack

| Layer | Choice |
|---|---|
| Frontend | Vanilla JS single-page app (no framework), built via a small `el()` DOM helper |
| Styling | Plain CSS with design tokens (CSS variables); light + dark themes |
| Backend | Supabase (Postgres + REST), client via `@supabase/supabase-js` |
| Auth | **Custom** phone + OTP / password (NOT Supabase Auth) |
| PWA | `manifest.webmanifest` + `sw.js` (network-first service worker) |
| Android | Capacitor 8 wrapper → debug APK |
| Push (optional) | Firebase Cloud Messaging — currently **stubbed/disabled** |
| PDF | jsPDF + autotable (bills) |

---

## Project structure (this dir)

```
dailywater/
├── index.html                  # App shell (#view, #tabbar, #modal, layers)
├── app.js                      # Entire SPA: data layer, router, all screens (~6000 lines)
├── styles.css                  # Design tokens + all component styles
├── sw.js                       # Service worker (network-first, offline fallback)
├── manifest.webmanifest        # PWA manifest
├── firebase-config.js          # FCM web config (empty/stubbed — push disabled)
├── firebase-messaging-sw.js    # FCM service worker (inactive until configured)
├── qrcode.min.js               # QR code lib (UPI QR etc.)
├── icon-192/512/maskable.png   # App icons
├── DailyWater.apk              # Latest built debug APK (version-controlled for distribution)
├── DEPLOY.md                   # Deployment notes
├── i.md                        # This file
├── supabase/
│   ├── schema.sql              # Full 13-table schema (paste into SQL editor)
│   └── functions/send-push/    # Edge function for FCM push (Deno)
└── capacitor-app/
    ├── build.ps1               # One-shot APK build script
    ├── www/                    # ⚠️ SEPARATE copy of web assets bundled into the APK
    └── android/                # Generated Android project (mostly gitignored)
```

> ⚠️ **Two copies of the web app.** The root files (`app.js`, `styles.css`, `index.html`) serve the **PWA / GitHub Pages**. The APK bundles `capacitor-app/www/`. They are **not** auto-synced — after editing root files you must `cp` them into `www/` before rebuilding the APK (see Build below).

---

## Backend (Supabase)

- **Project:** `udclccwehhnhstngvgam` (`https://udclccwehhnhstngvgam.supabase.co`) — DailyWater's **own** project (org `vajjadabswtdhylarvhn`), separate from MilkMate.
- **Client config:** `SUPABASE_URL` / `SUPABASE_KEY` (publishable key) at the top of `app.js` (and the mirrored `capacitor-app/www/app.js`).
- **Schema:** `supabase/schema.sql` — run it in the Supabase dashboard SQL editor to provision a fresh project.

### Tables (13)
`users`, `deliveries`, `pauses`, `extra_orders`, `payments`, `notifications`, `holidays`, `products`, `product_ratings`, `dairy_settings`, `subscription_plans`, `subscription_payments`, `device_tokens`

### Schema conventions (important)
- **IDs are `text`, not `uuid`.** The app generates its own short ids via `uid()` (`Math.random().toString(36).slice(2,10)`) and supplies them on insert — a `uuid` PK with `gen_random_uuid()` would reject every write.
- **camelCase columns are quoted** (`"ownerId"`, `"customerId"`, `"dailyMl"`, …) to preserve case the JS client sends.
- **Upsert conflict keys → UNIQUE constraints:** `holidays(ownerId,date)`, `products(ownerId,key)`, `dairy_settings(ownerId)`, `device_tokens(userId,token)`.
- **RLS is permissive** (`using(true)` for `anon`/`authenticated`) because there's no Supabase Auth session. Tighten to `auth.uid()` policies if/when real auth is added.
- Multi-tenant scoping is by `ownerId` (each supplier sees only their own rows; admin sees all).

---

## Auth & roles

Custom auth (no Supabase Auth). Login is phone-based; data is read with the publishable key.

| Role | Logs in with | Dashboard | Notes |
|---|---|---|---|
| `admin` | phone + OTP | `viewAdmin()` | Software seller; approves owners, sets quotas. Built-in: `8858141463`, demo OTP **1235**. No bottom nav. |
| `owner` | phone + OTP | `viewOwner()` | Water supplier; manages customers/deliveries/bills. Demo OTP **1234**. Tabs: home, customers, today, bills, reports. Subscription-gated. |
| `customer` | phone + password | `viewCustomer()` | End customer; sees deliveries, pauses, bills, extras. Tabs: home, schedule, bill, extras. |
| `delivery_boy` | phone + password | `viewDeliveryBoy()` | Marks deliveries on a route. No bottom nav. |

The admin user row (`id = 'u_admin'`) is auto-seeded by the app if missing.

---

## UI / theme

Two themes, both **token-driven** in `styles.css` (`:root` = light, `[data-theme="dark"]` = dark; auto-selected by `prefers-color-scheme`):

- **Tidal (light):** airy teal — `--primary #0F6E56`, soft surfaces, hairline borders.
- **Slate (dark):** dark canvas `#0F1419` with cyan accent `--primary #0E8FA6` / bright `#2BC0D8`.

Shared geometry: **pill buttons** (`--radius-pill`), border-driven (no heavy drop-shadows), **floating pill bottom nav**, large-title blended header, filled stat tiles. (Restructured away from MilkMate's flat top-bar + edge-to-edge tab-bar skeleton.)

A `✦ New look · build N` tag on the login screen identifies the build.

---

## Build & deploy

### PWA (web)
GitHub Pages serves `main`/root. To deploy: commit & push root files to `main`.
```
git add -A && git commit -m "..." && git push origin main
```
Pages redeploys in ~1–2 min. (SW is network-first; assets use a `?v=NN` cache-bust query bumped on releases.)

### Android APK
```powershell
# 1. Sync web changes into the APK's copy (root files are NOT auto-copied)
cp app.js styles.css index.html capacitor-app/www/

# 2. Build (runs npm install, cap sync, gradle assembleDebug)
& 'D:\cl\dailywater\capacitor-app\build.ps1'
# → outputs D:\cl\dailywater\DailyWater.apk
```
- Toolchain: Node, JDK, Android SDK at `D:\android-sdk` (platform android-36; build pins compile/target SDK **36** via `variables.gradle`).
- App version in `capacitor-app/android/app/build.gradle` (`versionCode` / `versionName`) — bump on each release so Android treats installs as updates.
- **Gotcha:** gradle `.gradle` config files must be written **without a UTF-8 BOM** (use `Set-Content -Encoding ascii`), or Groovy rejects them.

### Installing the APK
Uninstall the existing app first (or clear its data) before installing a new build — Android persists WebView localStorage and cached assets across updates, so an over-install can show stale UI/data.

---

## Key gotchas / notes

- **Root vs `www/`**: forgetting to `cp` root files into `capacitor-app/www/` means the APK ships old web assets even after a rebuild.
- **Modals & Android back:** `openModal`/`closeModal` use a `history.pushState` back-handler stack; `popBack()` runs the handler asynchronously via `history.back()`. When swapping one modal for another, reuse the open modal (don't `closeModal()` then immediately `openModal()` — the deferred `popstate` would tear the new one down).
- **Local-first sync:** the app caches a snapshot in `localStorage` (`dailywater-v1`) for fast/offline boot; `loadFromRemote()` **replaces** local state with remote on load and re-caches. If the remote `users` table is *empty*, the app treats it as first-run and uploads the local cache.
- **Push** is off until a Firebase project is configured in `firebase-config.js` (+ VAPID key) and the `send-push` edge function gets its service-account secret.

---

## Commit identity (this repo)

Local git config: name `ankit080-avi`, email `ankit788726@gmail.com`. `gh` is authed as `ankit080-avi`.
