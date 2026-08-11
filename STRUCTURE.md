# Structure Plans — Pick One, Then We Build

> ✅ **Chosen: Plan A — Split functions.** Scaffolded and implemented in this repo
> (`supabase/functions/auth`, `player`, `control` + `site/index.html`). Remaining
> work is M0 (credentials) and M4 (deploy) per `PLAN.md`.

Three ways to slice the same app. All are **100% free**, all use your domain, all use Supabase. The difference is how many pieces there are to build, deploy, and debug.

## Comparison at a glance

| | **A — Split** | **B — Monolith** | **C — No backend** |
|---|---|---|---|
| Edge Functions | 3 (`auth`, `player`, `control`) | 1 (`api`, path-routed) | 0 |
| Postgres usage | Refresh token | Refresh token | None (optional) |
| Refresh token lives | Server (Postgres) | Server (Postgres) | Browser (localStorage) |
| Deploy commands | 3 | 1 | 1 file push |
| CORS config | 3 functions | 1 function | none |
| Code to write | ~300 lines | ~200 lines | ~150 lines |
| Uses your domain free | ✅ Pages | ✅ Pages | ✅ Pages |
| Time to working v1 | ~2 days | ~1.5 days | ~1 day |
| Best when | You like clean separation | **You want simplest ops** | You want absolute minimum |

**Recommendation: B.** One function, one deploy, one CORS config, one place to look when something breaks. For a solo project the "clean separation" of A buys you nothing — you're the only developer. C is fastest but moves the refresh token into the browser, which is fine for a personal site yet gives Supabase almost nothing to do (and that's the point of using it).

---

## Plan A — Split functions

Three small Edge Functions, each doing one job.

```
supabase/functions/
├── auth/index.ts        # GET  /auth/start      → Spotify authorize URL
│                        # GET  /auth/callback   → exchange code, save refresh token, redirect to site
├── player/index.ts      # GET  /player/token    → fresh access token for the Web Playback SDK
│                        # GET  /player/now-playing → track + progress
└── control/index.ts     # POST /control/play | pause | next | volume
```

**Flow:** identical to the locked plan — frontend on Cloudflare Pages, functions on `*.supabase.co`.

**Pros**
- Each function is ~60–100 lines, trivially readable.
- Deploy `auth` once and it never changes again; iterate on `control` without touching the rest.
- If something breaks, the failing function names itself.

**Cons**
- 3 deploys, 3 CORS configs, 3 places with shared token-refresh logic (or a shared `_shared/` helper folder).
- Overhead for a single-user app.

**Deploy:** `supabase functions deploy auth player control` (one command, three artifacts).

---

## Plan B — Monolith function (recommended)

One Edge Function `api` that routes on the URL path. The whole backend in one file.

```
supabase/functions/api/index.ts
│
├── POST /api/auth/start           → Spotify authorize URL
├── GET  /api/auth/callback        → exchange code, save refresh token, redirect
├── GET  /api/player/token         → fresh access token for the SDK
├── GET  /api/player/now-playing   → track + progress
└── POST /api/control/{play|pause|next|volume}
```

Internal helpers in the same file: `refreshAccessToken()`, `callSpotify()`, `requireAppKey()`, `cors()`. A tiny `switch` on `req.url` dispatches routes — ~200 lines total.

**Pros**
- One deploy, one URL (`https://<ref>.supabase.co/functions/v1/api`), one CORS config, one shared token helper.
- Token refresh logic written exactly once.
- Spotify redirect URI is single and stable: `.../functions/v1/api/auth/callback`.
- Easiest to debug: `supabase functions serve` locally, hit one base URL.

**Cons**
- One file grows as features land (fine up to a few hundred lines).
- No per-endpoint deploy granularity (not something you'll miss).

**Deploy:** `supabase functions deploy api` — that's the entire backend.

---

## Plan C — No backend (pure client-side)

No Edge Functions. The browser does the whole Spotify OAuth dance itself (Authorization Code + **PKCE** — the code verifier is client-side, no secret needed), keeps the refresh token in `localStorage`, and drives the Web Playback SDK directly.

```
site/
└── index.html        # everything: OAuth, SDK, UI — one self-contained file
```

**What Supabase is for (pick your flavor):**
- **C1 — Supabase as host:** serve `index.html` from an Edge Function or public Storage bucket. Truly all-Supabase... but your domain can't point at it for free (custom domain = paid), so the URL stays `*.supabase.co`.
- **C2 — Supabase as config store:** host the file on Cloudflare Pages (your domain, free) and keep playlist ID / settings in a Postgres table. Supabase involvement is thin.
- **C3 — Supabase optional:** honestly, C doesn't need Supabase at all. It's "Cloudflare Pages + Spotify" and that's it.

**Pros**
- Fewest moving parts: one file, no functions, no deploys, no CORS, no Postgres.
- No client secret ever exists — PKCE needs only the public Client ID.
- Fastest path to a working player (~1 day).

**Cons**
- **Refresh token in the browser** (`localStorage`): acceptable for a personal site, but any XSS in that page = token theft. Plan A/B keep it server-side.
- Supabase becomes peripheral — if the goal is "deploy on Supabase," this plan mostly skips it.
- If hosted purely on Supabase (C1), your own domain can't be attached for free.

---

## What stays the same in all three

- Frontend: one self-contained `index.html` on **Cloudflare Pages** at `music.yourdomain.com` (free, auto-HTTPS, one CNAME record).
- Player: **Web Playback SDK** in the browser (Premium required).
- Spotify scopes: `user-read-playback-state`, `user-modify-playback-state`, `user-read-currently-playing`, `playlist-read-private`.
- Secrets in Supabase (only A/B need the Client Secret; C needs just the Client ID in the page).
- Polling: now-playing every 10s.

---

## Impact on the milestone plan (PLAN.md §8)

- Pick **A** → milestones unchanged (M1 = `auth`, M2 = `player` + `control`).
- Pick **B** → M1 + M2 merge into one step: "build the `api` function."
- Pick **C** → M1–M3 collapse into "build `index.html` with client-side PKCE + SDK"; M0 shrinks (no CLI needed unless C1).

---

## Verdict

| You want… | Pick |
|---|---|
| Simplest to run and debug, still server-side tokens | **B** ← recommended |
| Textbook separation of concerns | A |
| Absolute minimum code, don't care about server-side tokens | C |

Reply **A**, **B**, or **C** (or tell me to pick) and I'll scaffold that structure and start on M0/M1.
