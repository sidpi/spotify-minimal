# 🎧 spotify-minimal

A minimalist, single-page Spotify player. One dark screen, the **Web Playback SDK**
in the browser, and a **Supabase Edge Functions** backend. No build step, no
framework, no cost — everything runs on free tiers.

![Spotify](https://img.shields.io/badge/Spotify-1DB954?style=flat-square&logo=spotify&logoColor=white)
![Supabase](https://img.shields.io/badge/Supabase-3ECF8E?style=flat-square&logo=supabase&logoColor=white)
![Cloudflare Pages](https://img.shields.io/badge/Cloudflare%20Pages-F38020?style=flat-square&logo=cloudflare&logoColor=white)

## Features

- **Minimalist player** — Spotify-black UI with green accents, album art, and
  live background blur
- **Web Playback SDK** — the browser tab *is* the player
- **Playlist browser** — your playlists with covers, plus a per-playlist track
  list that plays from any position
- **Full transport controls** — play/pause, previous/next, seek bar,
  shuffle, and repeat (off · all · one)
- **Upcoming queue** — the next tracks peek out when you hover the player;
  click one to jump to it
- **Multi-user** — every visitor gets their own isolated Spotify session
  (anonymous id + server-issued secret), so anyone can log in and play
  without sharing the owner's account
- **Focus mode** — click the album art to center the player; a button restores
  the two-column layout
- **Volume popover** — hover the speaker icon next to the seek bar
- **Secure by default** — PKCE OAuth, JWT-verified functions, and the Spotify
  refresh token never leaves the server

## How it works

```
┌─────────────┐  fetch (Bearer anon key)   ┌──────────────────────┐
│  site/      │ ──────────────────────────▶│  Supabase Edge       │
│  index.html │ ◀──────────────────────────│  Functions (auth,    │
│  (static)   │      JSON                  │  player, control)    │
└─────────────┘                            └──────────┬───────────┘
        │                                             │ Spotify Web API
        │ Web Playback SDK (audio)                    ▼
        └────────────────────────────────▶ Spotify (Premium account)
```

1. **Connect** — `/auth/start` redirects to Spotify with PKCE; `/auth/callback`
   exchanges the code and stores the refresh token in the database.
2. **Listen** — the browser SDK asks `/player/token` for short-lived access
   tokens (minted server-side from the stored refresh token).
3. **Control** — play/pause/seek/volume hit `/control/*`, which drive the same
   active SDK device via Spotify's API.

## Repository layout

```
site/
  index.html            Static frontend — no build step. Deploy as-is.
supabase/
  functions/
    auth/               OAuth start / callback / logout (PKCE)
    player/             token, now-playing, device, playlists, playlist tracks
    control/            play, pause, next, previous
    _shared/            CORS helpers + Spotify API client
  migrations/           app_state + pkce_store tables
```

## Getting started

### Prerequisites

- A **Spotify Premium** account (the Web Playback SDK refuses free accounts)
- A Spotify app in the [Developer Dashboard](https://developer.spotify.com/dashboard)
- [Supabase CLI](https://supabase.com/docs/guides/cli) and a free Supabase project
- Any static host for the frontend (Cloudflare Pages, Netlify, GitHub Pages…)

### 1. Create the Spotify app

1. Go to the Developer Dashboard → **Create app**.
2. Copy the **Client ID** and **Client Secret**.
3. Add a **Redirect URI** — exactly this (fill in your project ref):

   ```
   https://<project-ref>.supabase.co/functions/v1/auth/callback
   ```

### 2. Link and migrate the Supabase project

```bash
supabase login
supabase init
supabase link --project-ref <project-ref>
supabase db push          # applies supabase/migrations/*.sql
```

### 3. Set the secrets

```bash
supabase secrets set \
  SPOTIFY_CLIENT_ID=<client-id> \
  SPOTIFY_CLIENT_SECRET=<client-secret> \
  SPOTIFY_REDIRECT_URI=https://<project-ref>.supabase.co/functions/v1/auth/callback \
  SITE_URL=https://<your-domain> \
  ALLOWED_ORIGIN=https://<your-domain> \
  PLAYLIST_ID=spotify:playlist:<playlist-id>
```

> **CLI 2.113+ note:** the old `[functions]` section in `config.toml` was
> removed — do **not** add one, the parser rejects it. JWT settings are now a
> deploy flag (below), not config.

### 4. Deploy the functions

```bash
supabase functions deploy auth --no-verify-jwt
supabase functions deploy player control
```

`auth` runs without JWT verification because a browser redirect can't attach
an `Authorization` header; `player` and `control` keep the default
verification, so Supabase's gateway rejects any call without the anon key.

Verify the backend with:

```
https://<project-ref>.supabase.co/functions/v1/auth/start
```

It should redirect you to Spotify's login page.

### 5. Point the frontend at your project

In `site/index.html`, set two values:

| Constant | Value |
|---|---|
| `API_BASE` | `https://<project-ref>.supabase.co/functions/v1` |
| `ANON_KEY` | your project's publishable (anon) key — public by design |

Then deploy `site/` as a static site: **build command** none, **output
directory** `site`. On Cloudflare Pages: connect the repo → add your custom
domain → add the `CNAME` at your DNS provider pointing at the Pages project.

> `?api=<url>` overrides `API_BASE` in the browser — handy for testing against
> a local functions server before you deploy.

### 6. Connect and play

Open your site → **Connect Spotify** → approve the permission screen → you land
back on the player. Press **▶** or open a playlist.

To change the default playlist, update the `PLAYLIST_ID` secret or the
`playlist_id` row in the `app_state` table.

## Keys: what goes where

| Key | Where it lives | Why it's safe |
|---|---|---|
| Publishable (anon) | Embedded in `site/index.html`, sent as `Authorization: Bearer` | Public by design; the gateway JWT-verifies `player`/`control` calls with it |
| Service role (secret) | Auto-injected into Edge Functions only | Used to store the refresh token; never reaches the browser or the repo |
| Spotify client secret | Supabase secrets | Never in the repo or frontend |

## Security notes

- The Spotify **refresh token is stored in the database**; the browser only ever
  sees short-lived access tokens minted server-side.
- `player`/`control` are **JWT-verified** at the gateway, so unauthenticated
  calls are rejected before any code runs.
- **CORS is locked down** via the `ALLOWED_ORIGIN` secret — browsers on other
  origins can't call your functions.
- **No secrets in the repo** — everything sensitive lives in Supabase secrets
  and `.env` (gitignored).

## Limitations

- **Premium required** — the Web Playback SDK refuses free accounts.
- **The tab is the player** — music stops when the tab closes (no 24/7 playback; by design).
- **One active device per account** — playing in the Spotify app elsewhere steals playback.
- Free Supabase projects **auto-pause after 7 days idle**; the first request after a pause is slow while it wakes.

## Local development

```bash
supabase start          # local Postgres + functions runtime
supabase functions serve
```

Set `SPOTIFY_REDIRECT_URI` to the local callback and
`SITE_URL`/`ALLOWED_ORIGIN` to your local frontend origin, then open
`site/index.html?api=http://127.0.0.1:54321/functions/v1`.

## License

[MIT](LICENSE)
