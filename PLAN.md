# Minimalist Spotify Playlist Website — Plan (100% Free)

## 1. Goal

A dead-simple website that plays your Spotify playlist and shows a minimal "now playing" screen. Backend on **Supabase free tier**, site on **Cloudflare Pages free tier**, live at your own domain — **total cost: $0/mo**.

**Success criteria:**
- One dark, minimalist screen: current track, progress, play/pause/skip, volume.
- Music plays from the browser tab via Spotify Web Playback SDK (Premium account required — that's Spotify's cost, not ours).
- No server to manage; deploys via the `supabase` CLI + git push.

---

## 2. Architecture

```
                    ┌──────────────────────────────────────────┐
  Your browser ───▶ │  Cloudflare Pages (free)                │
                    │  music.yourdomain.com ──▶ index.html    │
                    │  minimalist UI + Web Playback SDK       │
                    │  ◀── plays audio from Spotify here      │
                    └─────────────────┬────────────────────────┘
                                      │ HTTPS / JSON (CORS-enabled)
                    ┌─────────────────▼────────────────────────┐
                    │  Supabase Edge Functions (free, Deno)   │
                    │  • OAuth with Spotify                   │
                    │  • refreshes tokens                     │
                    │  • proxies Spotify API for the UI      │
                    └─────────────────┬────────────────────────┘
                                      │ secrets + Postgres (free)
                    ┌─────────────────▼────────────────────────┐
                    │  Supabase Postgres (free, 500 MB)       │
                    │  • refresh token                        │
                    │  • playlist / device config             │
                    └──────────────────────────────────────────┘
```

- **Player:** Web Playback SDK inside the browser tab (this is why we don't need a 24/7 device).
- **Backend:** Supabase Edge Functions — no servers, free HTTPS, built-in secrets.
- **Frontend hosting:** Cloudflare Pages — chosen over Vercel because it's unlimited-bandwidth free and custom domains are free (Vercel Hobby works too; swap anytime).

---

## 3. The $0 stack (locked)

| Piece | Service | Cost | Used for |
|---|---|---|---|
| Frontend hosting | Cloudflare Pages | $0 (unlimited requests, 100 builds/mo) | Serving `index.html` at `music.yourdomain.com` |
| Backend | Supabase Edge Functions | $0 (500K invocations/mo) | Auth, token refresh, Spotify API proxy |
| Database | Supabase Postgres | $0 (500 MB) | Refresh token + config |
| Secrets | Supabase Edge Function secrets | $0 | Client ID / Client Secret |
| Domain | Yours | $0 (already bought) | Branding + HTTPS |
| TLS/HTTPS | Cloudflare (auto) | $0 | Secure everything |

**Not used (on purpose):** Supabase custom domains (paid add-on, Pro required), Vercel Pro, any VPS.

---

## 4. Spotify integration

### 4.1 Setup in the Spotify Developer Dashboard
1. Create an app at <https://developer.spotify.com/dashboard>.
2. Copy **Client ID** + **Client Secret** → become Supabase secrets.
3. Set the **Redirect URI** to:
   `https://<your-project-ref>.supabase.co/functions/v1/auth/callback`
   (This exact URL — including `.supabase.co` — is what the free path uses. Register it once and it never changes.)

### 4.2 Auth flow (Authorization Code + PKCE)
1. Frontend calls `/auth/start` → gets Spotify authorize URL (with code verifier).
2. User clicks "Connect Spotify" → Spotify login → redirects to `/auth/callback`.
3. Callback exchanges the code, stores the **refresh token in Postgres**, redirects back to the site.
4. Frontend calls `/player/token` → function returns a fresh **access token** → handed to the Web Playback SDK.
5. Access token expires hourly; the function refreshes silently forever.

### 4.3 Scopes
```
streaming                    → Web Playback SDK (required, else no audio!)
user-read-playback-state     → show current track / playing state
user-modify-playback-state   → play, pause, skip
user-read-currently-playing  → what's on right now
playlist-read-private        → your private playlists
user-library-read            → browse your Liked Songs list
```

### 4.4 The two APIs
| API | Used for | Runs in |
|---|---|---|
| **Web Playback SDK** | Streaming audio; instant local play/pause/next/seek/volume | Frontend (browser) |
| **Web API (REST)** | Playlist metadata, now-playing state, transfer playback | Edge Functions (proxied) |

### 4.5 Gotchas
- **Premium required** for both APIs. Non-negotiable.
- SDK needs a user gesture (click) before it initializes in some browsers.
- Rate limits (~1 req/sec): poll now-playing every 5–10s.
- One active device per account — playing in the Spotify app elsewhere steals playback.

---

## 5. UI spec (minimalist)

One screen, dark, one accent color, system fonts:

```
┌────────────────────────────────────────┐
│                                        │
│        ♫  Current Track Title         │
│          Artist — Album               │
│                                        │
│        ▓▓▓▓▓▓▓░░░░░░░░░  3:42 / 4:10 │
│                                        │
│        [ ⏮ ]   [ ⏯ ]   [ ⏭ ]         │
│                                        │
│   Playlist: Lo-Fi Study Beats (12/∞)   │
│                                        │
│        ● ● ○ ○ ○  ••• volume          │
└────────────────────────────────────────┘
```

- Mobile-first (it'll live on your phone).
- **Single self-contained `index.html`** (inline CSS/JS) — trivial to host, no build step, no asset pipeline. This is what keeps Cloudflare Pages a one-file deploy.
- Optional touches: equalizer bars while playing, album art as a blurred backdrop.

---

## 6. Security & config

- **Secrets** (never in code or git):
  `supabase secrets set SPOTIFY_CLIENT_ID=... SPOTIFY_CLIENT_SECRET=...`
- Postgres holds the **refresh token** (written at connect time).
- `.env` for local dev, gitignored.
- **CORS:** Edge Functions must allow the origin `https://music.yourdomain.com` (Deno `cors()` helper or manual headers).
- **Access code:** skipped for now (private/single-user). Add later if you share the URL.
- Simple `X-App-Key` header check on functions = personal-site level protection.

---

## 7. Project structure

```
spotify-minimal/
├── .env                     # local dev secrets (gitignored)
├── .gitignore               # .env, node_modules, supabase/.temp
├── README.md
├── supabase/
│   ├── config.toml          # from `supabase init`
│   └── functions/
│       ├── auth/
│       │   └── index.ts     # /auth/start, /auth/callback (route on URL path)
│       ├── player/
│       │   └── index.ts     # /player/token, /player/now-playing
│       └── control/
│           └── index.ts     # /control/play, /control/pause, /control/next
└── site/
    └── index.html           # the one screen (deployed to Cloudflare Pages)
```

Each function is one Deno file: parse the URL, switch on the sub-route, call Spotify's REST API with `fetch`, return JSON. ~60–100 lines each.

---

## 8. Milestones

### M0 — Accounts & credentials (30 min)
- [ ] Create Spotify app → Client ID/Secret.
- [ ] Create Supabase project (free), install CLI, `supabase init`.
- [ ] Create Cloudflare Pages project; add `music.yourdomain.com` (CNAME → `.pages.dev`).

### M1 — Supabase backend: auth (half day)
- [ ] `supabase functions new auth` — `/auth/start` + `/auth/callback` (PKCE).
- [ ] Set secrets; store refresh token in Postgres on connect.
- [ ] Test locally (`supabase functions serve`), then `supabase functions deploy auth`.

### M2 — Supabase backend: player proxy (half day)
- [ ] `/player/token` — mint fresh access token for the SDK.
- [ ] `/player/now-playing` — proxy track + progress.
- [ ] `/control/*` — play/pause/skip/volume via Web API.
- [ ] CORS headers set for `https://music.yourdomain.com`.

### M3 — Frontend (half day)
- [ ] Self-contained `index.html`: Web Playback SDK + the one-screen UI.
- [ ] Poll now-playing every 10s; SDK for instant local control.
- [ ] Test on phone.

### M4 — Domain + deploy (half day)
- [ ] Deploy functions: `supabase functions deploy`.
- [ ] Push `site/index.html` to Cloudflare Pages (connected to a git repo).
- [ ] Update Spotify redirect URI to the real `*.supabase.co` callback; re-connect once.
- [ ] End-to-end test from phone on cellular.

### M5 — Harden (as needed)
- [ ] Graceful token-expiry handling (auto re-auth prompt).
- [ ] Error-state UI (not Premium, SDK failed, network down).
- [ ] Access code if you make it public.

---

## 9. Deployment plan (your domain, $0)

```
music.yourdomain.com ──▶ Cloudflare Pages (free, auto-HTTPS)
                            └─ index.html (Web Playback SDK)

<ref>.supabase.co/functions/v1/* ──▶ Spotify API (free tier)
```

| Type | Host | Value |
|---|---|---|
| CNAME | `music` | `<your-project>.pages.dev` |

1. In Cloudflare Pages → Custom domains → add `music.yourdomain.com` → it verifies ownership and issues a cert automatically.
2. Your registrar just needs that one CNAME record (add it where your DNS is managed).
3. Backend stays on `*.supabase.co` — no DNS work, no paid add-ons.

**Free-tier gotchas to know:**
- Supabase projects **auto-pause after 7 days of inactivity** — the first request after a pause wakes the project and can take a few extra seconds. Daily use means you'll rarely hit it.
- Cloudflare Pages: 100 builds/month on free — plenty for a personal site.
- Edge Functions: 500K invocations/month free — your 10s polling is ~8.6K calls/day ≈ 260K/mo. Comfortable, but keep polling at 10s+.

---

## 10. Risks & honest caveats

- **Premium required** — Web Playback SDK + Playback API refuse free Spotify accounts.
- **No true 24/7** — tab closes, music stops (per your call).
- **Refresh token can be revoked** — if playback 401s, re-connect once (5-min fix).
- **Web Playback SDK quirks** — user gesture on first load; one active device per account.
- **Edge Functions are stateless** — always read the refresh token from Postgres, never hold it in memory.

---

## 11. Decisions (defaults chosen — change any time)

> ✅ **Structure locked: Plan A — split Edge Functions** (`auth`, `player`, `control`) per `STRUCTURE.md`. Code scaffolded in this repo; milestones M1–M3 are effectively implemented — remaining work is credentials + deploy (M0, M4).

| Question | Default | Changeable? |
|---|---|---|
| Frontend host | **Cloudflare Pages** | Yes → Vercel Hobby (same steps) |
| Backend URL | **`*.supabase.co` free** (no custom domain) | Yes → Pro + paid add-on later |
| Subdomain | **`music.yourdomain.com`** | Yes → root or other subdomain |
| Audience | **Private / just you** (no access code) | Yes → add code later |
| Language | **TypeScript (Deno)** for functions, vanilla JS for the page | Yes → Python via Edge Functions isn't supported; stay TS |

Everything above the line is decided. Pick a subdomain if you don't like the default, then we start with **M0**.
