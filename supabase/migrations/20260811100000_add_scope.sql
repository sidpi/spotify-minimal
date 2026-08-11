-- Track which OAuth scopes were actually granted, so we can detect a token
-- missing the `streaming` scope (Web Playback SDK requires it for audio).
alter table public.app_state add column if not exists scope text;
