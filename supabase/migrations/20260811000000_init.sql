-- Single-row app state (id = 1): Spotify tokens + app config.
create table if not exists public.app_state (
  id integer primary key default 1 check (id = 1),
  refresh_token text,
  access_token text,
  expires_at bigint,           -- epoch ms; when the access token expires
  device_id text,              -- Web Playback SDK device id
  playlist_id text,            -- "spotify:playlist:xxx" (optional; env fallback exists)
  updated_at timestamptz not null default now()
);

-- One-time PKCE handshake, written by /auth/start, read by /auth/callback.
create table if not exists public.pkce_store (
  state text primary key,
  verifier text not null,
  created_at timestamptz not null default now()
);

create index if not exists pkce_store_created_at_idx on public.pkce_store (created_at);
