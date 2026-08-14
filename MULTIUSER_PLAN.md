# Plan — let anyone log in and use the player (multi-user)

## 1. The situation today

The **visitor login flow already works for any person**:

1. Open `https://music.sidcandev.online` → tap **Connect Spotify**.
2. Spotify's permission screen → approve → you land back on the player.
3. Tap **▶** (or a playlist) — the tab streams via the Web Playback SDK.

But the backend is **single-user by design**. There is one row in
`app_state` (`id = 1`) holding *the* refresh token, device id, and default
playlist. Consequences:

- The **last person to connect wins**. Everyone else's browser now acts as
  that person (plays *their* playlists, sees *their* Liked Songs).
- Logging out clears the shared token — everyone is disconnected.
- There is no way to know *which* visitor is calling `/player/token` or
  `/control/play`, so we cannot isolate sessions.

So "anyone can log in" is really two jobs: **document the login steps** (done
above, already works) and **make sessions per-user** (the plan below).

## 2. Goal

Every visitor gets their own isolated Spotify session:

- Your token is stored for **you**, never shown to or shared with anyone else.
- Playlists, Liked Songs, daylist, device, default playlist — all per-user.
- Logout only clears *your* session.
- No Spotify-account login page changes; no new infra; still $0/month.

## 3. Identity model (the core change)

The browser keeps a persistent anonymous identity in `localStorage`:

```
music_player_id      — random id, generated on first visit (e.g. 16 bytes base64url)
music_player_secret  — random secret, issued by the server during OAuth
```

Both are sent as headers on every API call:

```
x-app-user:   <music_player_id>
x-app-secret: <music_player_secret>
```

The secret is what makes the id unforgeable: an id alone cannot read or
control anyone else's session. (Same idea as a bearer token; the id is public,
the secret is private to that browser.)

## 4. How the secret is handed out (safe)

OAuth already returns us a one-time `state` value. Extend it:

1. Frontend calls `/auth/start?user=<music_player_id>`.
2. The function generates a fresh `user_secret`, stores
   `(state, verifier, user, user_secret)` in `pkce_store`, and redirects to
   Spotify with `state` (unchanged) — **the secret never appears in the
   Spotify URL or the browser URL bar**.
3. `/auth/callback` looks up the row by `state`, stores the tokens under
   `user`, and redirects to the site with the secret in a fragment:
   `https://site/?connected=1#session=<user_secret>`.
   Fragments never leave the browser → the secret can't leak via Referer or
   server logs.
4. The frontend saves `music_player_secret` from the fragment and strips it
   from the URL (`history.replaceState`).

`pkce_store` is already one-time-use (deleted after callback), so a stolen
state can't be replayed.

## 5. Database changes

New table (one row per visitor):

```sql
create table if not exists user_tokens (
  user_id       text primary key,
  user_secret   text not null,             -- issued at connect time
  refresh_token text,
  access_token  text,
  expires_at    bigint,
  scope         text,
  device_id     text,
  playlist_id   text,                      -- per-user default playlist
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
```

`app_state` stays for **global** config only (e.g. a shared default playlist
for users who haven't picked one). All token/device/playlist reads become
`where user_id = <x-app-user>`.

## 6. Backend changes (all in `supabase/functions/`)

| Function | Change |
|---|---|
| `auth/start` | Accept `?user=`, generate `user_secret`, store in `pkce_store` |
| `auth/callback` | Write tokens to `user_tokens[user]`, redirect with `#session=…` |
| `auth/logout` | Clear only `user_tokens[user]` (needs the headers) |
| `_shared/spotify.ts` | `getValidTokens/refreshTokens/playPlaylist/device` become per-user: read `x-app-user` + verify `x-app-secret` against the row |
| `player/*` | Resolve tokens per user for `token`, `now-playing`, `playlists`, `liked`, `daylist`, `playlist` |
| `control/*` | All play/pause/seek act on the *caller's* tokens + device |

Verify the secret on every call that touches a user's data; on mismatch
return `403 {"error":"session_invalid"}` → the frontend shows **Reconnect
Spotify** instead of silently mixing sessions.

## 7. Frontend changes (`site/index.html`)

- On boot: `music_player_id = localStorage.music_player_id ?? random()`.
- `api()` adds `x-app-user`/`x-app-secret` headers when present.
- Connect button: `href = API_BASE + "/auth/start?user=" + id`.
- On load, if `location.hash` starts with `#session=`, save the secret,
  `history.replaceState` to strip it, then proceed.
- `showConnect()` shows "Connect Spotify" as today; a `403 session_invalid`
  response also lands the user there (with the reconnect toast).
- Logout: clears the stored secret + calls `/auth/logout`.

## 8. Multi-device / concurrency notes

- **One active device per Spotify account is inherent** — if the same person
  plays in the app and the tab, the tab steals/loses playback. That's Spotify's
  rule and unchanged.
- Same user, two tabs: last-connected device wins; acceptable (matches
  Spotify's own behavior).
- Different users, same browser profile: each tab keeps its own identity
  (localStorage is per-origin, so different browsers/profiles = different
  users — fine).

## 9. Security & abuse

- `user_secret` never travels through Spotify, never in URLs (fragment only),
  never in the repo.
- All user-data endpoints verify the secret server-side; `player`/`control`
  keep the existing JWT (anon key) gateway check too.
- Rate limits already exist at the Supabase gateway level; add a lightweight
  per-`x-app-user` burst check in `_shared` if abuse appears.
- **Optional privacy gate** (PLAN.md M5): before connect, require an access
  code the owner shares (stored in a `site_config` row or a secret). One
  `?code=` check in `/auth/start`. Zero extra infra.
- **Optional cleanup**: `delete from user_tokens where updated_at < now() - interval '90 days'` on a schedule, since nobody revokes tokens at Spotify's side.

## 10. Deploy steps (once implemented)

```bash
supabase db push                                   # migration: user_tokens
supabase functions deploy auth player control      # per-user resolution
# frontend: push to git → Cloudflare Pages rebuilds automatically
```

Verify: open the site in two different browsers, connect two different
Spotify accounts, confirm each sees only its own playlists and playback.
Then test logout in one browser — the other stays connected.

## 11. The resulting visitor experience

1. Open the site → **Connect Spotify** → approve → back on the player.
2. Your playlists, Liked Songs, and daylist — yours only.
3. Play/pause/seek/volume control your own playback.
4. **Log out** disconnects only you; everyone else keeps working.
5. Reconnect whenever you want — grants any new scopes (like the
   `user-library-read` fix) without affecting other users.

## 12. Effort

Roughly: one migration, ~30 lines in `_shared/spotify.ts`, ~40 lines across
`auth`, ~15 lines in `site/index.html`, plus header plumbing in every
endpoint. No new services, no cost change, no Spotify dashboard changes
(the single redirect URI keeps working for everyone).
