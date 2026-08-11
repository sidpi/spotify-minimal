# spotify-minimal

Minimalist Spotify playlist player — one dark screen, Web Playback SDK in the browser, Supabase Edge Functions backend. 100% free tier. Plan A structure (see `PLAN.md` / `STRUCTURE.md`).

```
site/index.html        → Cloudflare Pages (music.sidcandev.online)
supabase/functions/
  auth/                → /auth/start, /auth/callback  (Spotify OAuth, PKCE)
  player/              → /player/token, /player/now-playing, /player/device
  control/             → /control/play, /control/pause, /control/next, /control/previous
  _shared/             → cors.ts, spotify.ts (tokens, PKCE, Spotify API)
supabase/migrations/   → app_state + pkce_store tables
```

## API keys — where they fit (and don't)

Supabase projects expose two keys (Settings → API → Project API keys):

| Key | Used here? | Where it goes |
|---|---|---|
| **Publishable (anon)** | ❌ Not used | The site never talks to Supabase directly — it only calls our Edge Functions (deployed with `--no-verify-jwt`), so no key is needed in the frontend. Never put the **service role** key in the frontend. |
| **Secret (service_role)** | ✅ Auto-injected | Edge Functions automatically receive `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` from the runtime (deployed *and* local `supabase functions serve`). The functions use it to store the refresh token. You don't paste it anywhere; it never reaches the browser. |

> Why `verify_jwt = false`? The OAuth flow is a plain browser redirect to
> `/auth/start` — a navigation can't attach an Authorization header, so JWT
> verification would 401 it before the function runs. Instead the JSON
> endpoints (`player`, `control`) are gated by the `APP_KEY` shared secret
> (sent as `x-app-key`), and `auth` only redirects and stores tokens.

## Prerequisites

- Spotify account with **Premium** (required by the Web Playback SDK)
- [Supabase CLI](https://supabase.com/docs/guides/cli) installed and logged in
- A Supabase project (free) — note its **project ref** (the `abcdefgh` part of `wrnidxaoijyopcfnenlw.supabase.co`)

## 1. Spotify app

1. Go to <https://developer.spotify.com/dashboard> → Create app.
2. Copy **Client ID** and **Client Secret**.
3. Add a **Redirect URI** — exactly:
   `https://wrnidxaoijyopcfnenlw.supabase.co/functions/v1/auth/callback`

## 2. Supabase: link, migrate, secrets

```bash
supabase login
supabase init                     # keep the existing supabase/config.toml
supabase link --project-ref wrnidxaoijyopcfnenlw
supabase db push                  # runs supabase/migrations/*.sql

supabase secrets set \
  SPOTIFY_CLIENT_ID=... \
  SPOTIFY_CLIENT_SECRET=... \
  SPOTIFY_REDIRECT_URI=https://wrnidxaoijyopcfnenlw.supabase.co/functions/v1/auth/callback \
  SITE_URL=https://music.sidcandev.online \
  ALLOWED_ORIGIN=https://music.sidcandev.online \
  APP_KEY=<your-app-key>   # keep in sync with site/index.html
```

> JWT verification is off for all three functions via the `--no-verify-jwt` deploy
> flag (the old `verify_jwt` config key is gone in CLI 2.113+ — don't add a
> `[functions]` section to `config.toml`, it fails to parse). The `APP_KEY`
> (sent as `x-app-key`) protects `player`/`control`; `auth` stays open — it only
> redirects and stores tokens.

## 3. Deploy the backend

```bash
supabase functions deploy auth player control --no-verify-jwt
```

Test: open `https://wrnidxaoijyopcfnenlw.supabase.co/functions/v1/auth/start` → you should be
redirected to Spotify's login.

## 4. Frontend + your domain

1. Edit `site/index.html`:
   - `API_BASE` → `https://wrnidxaoijyopcfnenlw.supabase.co/functions/v1`
   - `APP_KEY` → the same value you set above
2. Push the repo to GitHub/GitLab, then in **Cloudflare Pages** → Create project →
   connect the repo, build command **none**, output directory `site`.
3. Cloudflare Pages → Custom domains → add `music.sidcandev.online`.
   DNS is at Spaceship (nameservers `launch1/launch2.spaceship.net`), so add the
   record in the **Spaceship dashboard**: `CNAME  music  → <your-project>.pages.dev`
   Cloudflare verifies and issues HTTPS automatically.

> `?api=<url>` query param overrides `API_BASE` — handy for testing a function
> URL before you push the real site.

## 5. Connect once

Visit `https://music.sidcandev.online` → **Connect Spotify** → allow → you land back
on the site with playback ready. Press **▶** to start the playlist.

- To change the playlist: set the `PLAYLIST_ID` secret
  (`supabase secrets set PLAYLIST_ID=spotify:playlist:xxx`) or update the
  `playlist_id` column in the `app_state` table.

## Local dev

```bash
supabase start                    # local Postgres + functions runtime
supabase functions serve          # serves on http://127.0.0.1:54321/functions/v1
```

Point your browser at `http://127.0.0.1:54321/functions/v1/auth/start` with
`SPOTIFY_REDIRECT_URI` set to the local callback and `SITE_URL`/`ALLOWED_ORIGIN`
to your local frontend origin. If you don't run the local frontend, you can test
with `site/index.html?api=http://127.0.0.1:54321/functions/v1`.

## Gotchas

- **Premium required** — the SDK refuses free accounts.
- Music stops when the tab closes (by design — no 24/7).
- One active device per account — playing in the Spotify app elsewhere steals playback.
- Supabase free projects auto-pause after 7 days idle; the first request after a
  pause is slow while it wakes.
