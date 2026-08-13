// Shared Spotify backend helpers used by the auth, player, and control functions.
import { createClient } from "npm:@supabase/supabase-js@2";

// ---------------------------------------------------------------------------
// Supabase client (service role — server-side only, never exposed to the site)
// ---------------------------------------------------------------------------
const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "http://127.0.0.1:54321";
const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
export const db = createClient(supabaseUrl, supabaseKey);

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const AUTH_ENDPOINT = "https://accounts.spotify.com/authorize";
const TOKEN_ENDPOINT = "https://accounts.spotify.com/api/token";
const API_BASE = "https://api.spotify.com/v1";

export const SCOPES = [
  "streaming", // required by the Web Playback SDK — without it no audio plays
  "user-read-playback-state",
  "user-modify-playback-state",
  "user-read-currently-playing",
  "playlist-read-private",
  "user-library-read", // lets us list Liked Songs so the site can browse them
].join(" ");

const env = (name: string): string => Deno.env.get(name) ?? "";
export const clientId = () => env("SPOTIFY_CLIENT_ID");
export const clientSecret = () => env("SPOTIFY_CLIENT_SECRET");
export const redirectUri = () => env("SPOTIFY_REDIRECT_URI");
export const siteUrl = () => env("SITE_URL") ?? "http://localhost:8888";

// ---------------------------------------------------------------------------
// PKCE helpers (Deno edge runtime has WebCrypto)
// ---------------------------------------------------------------------------
export function base64url(data: ArrayBuffer | string): string {
  const bytes = typeof data === "string"
    ? new TextEncoder().encode(data)
    : new Uint8Array(data);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function randomBase64url(nBytes: number): string {
  const bytes = new Uint8Array(nBytes);
  crypto.getRandomValues(bytes);
  return base64url(bytes.buffer);
}

/** 43–128 chars — 64 random bytes is the max-entropy sweet spot. */
export const generateVerifier = () => randomBase64url(64);

export const generateChallenge = (verifier: string) =>
  crypto.subtle
    .digest("SHA-256", new TextEncoder().encode(verifier))
    .then(base64url);

export function authorizeUrl(state: string, challenge: string): string {
  const params = new URLSearchParams({
    client_id: clientId(),
    response_type: "code",
    redirect_uri: redirectUri(),
    scope: SCOPES,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  return `${AUTH_ENDPOINT}?${params}`;
}

// ---------------------------------------------------------------------------
// Token storage (single row in app_state) + refresh
// ---------------------------------------------------------------------------
interface Tokens {
  accessToken: string;
  refreshToken: string;
  scope: string;
}

export async function saveTokens(t: {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scope?: string;
}): Promise<void> {
  const { error } = await db.from("app_state").upsert({
    id: 1,
    refresh_token: t.refreshToken,
    access_token: t.accessToken,
    expires_at: t.expiresAt,
    scope: t.scope ?? null,
    updated_at: new Date().toISOString(),
  });
  if (error) throw error;
}

/** Returns cached tokens if fresh, otherwise refreshes and stores. */
export async function getValidTokens(): Promise<Tokens | null> {
  const { data, error } = await db
    .from("app_state")
    .select("refresh_token, access_token, expires_at, scope")
    .eq("id", 1)
    .maybeSingle();
  if (error) throw error;
  if (!data?.refresh_token) return null;

  const expiresAt = (data.expires_at as number | null) ?? 0;
  const hasScope = !!(data.scope && data.scope.includes("streaming"));
  if (data.access_token && Date.now() < expiresAt && hasScope) {
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      scope: data.scope,
    };
  }
  // Expired, or we don't know the granted scopes yet — refresh once to find out.
  return refreshTokens(data.refresh_token);
}

export async function refreshTokens(refreshToken: string): Promise<Tokens> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: clientId(),
    client_secret: clientSecret(),
  });
  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) throw new Error(`Spotify token refresh failed (${res.status})`);
  const t = await res.json();
  const next = {
    accessToken: t.access_token,
    refreshToken: t.refresh_token ?? refreshToken,
    scope: t.scope ?? "",
  };
  await saveTokens({
    ...next,
    expiresAt: Date.now() + (t.expires_in ?? 3600) * 1000,
  });
  return next;
}

/** Exchange the authorization code for tokens (called by /auth/callback). */
export async function exchangeCode(
  code: string,
  verifier: string,
): Promise<void> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri(),
    client_id: clientId(),
    client_secret: clientSecret(),
    code_verifier: verifier,
  });
  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    throw new Error(`Spotify code exchange failed (${res.status})`);
  }
  const t = await res.json();
  await saveTokens({
    accessToken: t.access_token,
    refreshToken: t.refresh_token,
    expiresAt: Date.now() + (t.expires_in ?? 3600) * 1000,
    scope: t.scope ?? "",
  });
}

// ---------------------------------------------------------------------------
// Spotify Web API calls
// ---------------------------------------------------------------------------
export class SpotErr extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export async function spotifyFetch(
  path: string,
  init: RequestInit = {},
): Promise<any | null> {
  const tokens = await getValidTokens();
  if (!tokens) throw new SpotErr(401, "not_connected");
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${tokens.accessToken}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  if (res.status === 401) throw new SpotErr(401, "token_rejected");
  if (res.status === 204) return null;
  if (!res.ok) throw new SpotErr(res.status, `Spotify API ${res.status}`);
  // Spotify sometimes returns 200 with a non-JSON body (e.g. a random token
  // string from /me/player/pause) — treat unparseable bodies as null.
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Slim now-playing shape the frontend polls every ~10s. */
export async function getNowPlaying(): Promise<object> {
  const data = await spotifyFetch("/me/player/currently-playing");
  if (!data?.item) return { playing: false, track: null, progress_ms: 0 };
  const item = data.item;
  return {
    playing: data.is_playing,
    progress_ms: data.progress_ms,
    track: {
      id: item.id,
      name: item.name,
      artists: (item.artists ?? []).map((a: { name: string }) => a.name).join(", "),
      album: item.album?.name ?? "",
      image: item.album?.images?.[0]?.url ?? "",
      duration_ms: item.duration_ms,
    },
  };
}

/**
 * Start a playlist on Spotify. Pass an explicit playlist id/context_uri (e.g.
 * from the playlists browser), otherwise fall back to the configured default.
 */
export async function playPlaylist(
  deviceId?: string,
  contextUri?: string,
  offsetPosition?: number,
): Promise<void> {
  let uri = contextUri;
  // Liked Songs is a special collection, not a playlist: resolve it to
  // spotify:user:<id>:collection using the connected user's Spotify id.
  if (uri === "spotify:liked" || uri === "liked") {
    const me = await spotifyFetch("/me");
    const userId = me?.id ?? "";
    if (!userId) throw new SpotErr(400, "could not resolve your Spotify user");
    uri = `spotify:user:${userId}:collection`;
  }
  if (!uri) {
    const { data } = await db
      .from("app_state")
      .select("playlist_id")
      .eq("id", 1)
      .maybeSingle();
    uri = data?.playlist_id ?? env("PLAYLIST_ID");
  }
  if (!uri) throw new SpotErr(400, "no playlist configured");
  const finalUri = uri.startsWith("spotify:") ? uri : `spotify:playlist:${uri}`;
  const qs = deviceId ? `?device_id=${encodeURIComponent(deviceId)}` : "";
  await spotifyFetch(`/me/player/play${qs}`, {
    method: "PUT",
    body: JSON.stringify({
      context_uri: finalUri,
      offset: { position: offsetPosition ?? 0 },
    }),
  });
  if (deviceId) {
    await db
      .from("app_state")
      .upsert({ id: 1, device_id: deviceId, updated_at: new Date().toISOString() });
  }
}

interface TrackShape {
  id: string;
  name: string;
  artists: { name: string }[];
  album: { images: { url: string }[] };
  duration_ms: number;
  uri: string;
}

interface TrackEntry {
  item?: TrackShape | null;
  track?: TrackShape | null;
}

/** Slim a raw Spotify track into the shape the frontend renders. */
function slimTrack(tr: TrackShape | null | undefined): object | null {
  if (!tr) return null; // unavailable tracks come back null
  return {
    id: tr.id,
    name: tr.name,
    artists: (tr.artists ?? []).map((a: { name: string }) => a.name).join(", "),
    image: tr.album?.images?.[0]?.url ?? "",
    duration_ms: tr.duration_ms,
    uri: tr.uri,
  };
}

/**
 * Slim track list for a playlist.
 *
 * Spotify's current API embeds the playlist items in the playlist details
 * object (top-level `items` paging object, each entry's track under `item`)
 * and, for many playlists, the separate `/playlists/{id}/tracks` endpoint
 * returns 403. Embedded items only exist for playlists the user owns — for
 * playlists followed from other users, Spotify usually returns bare metadata
 * with no track list at all. Spotify-curated playlists (like "daylist")
 * often still answer the dedicated tracks endpoint, so we try it as a
 * fallback before giving up. `listable` tells the frontend which case it is.
 */
export async function getPlaylistTracks(playlistId: string): Promise<{
  tracks: object[];
  listable: boolean;
}> {
  const data = await spotifyFetch(`/playlists/${playlistId}`);
  let entries: TrackEntry[] = data?.items?.items ?? data?.tracks?.items ?? [];
  if (!entries.length) {
    // No embedded items (e.g. Spotify-curated playlists) — try the dedicated
    // tracks endpoint; it still works for many public playlists.
    try {
      const tracks = await spotifyFetch(`/playlists/${playlistId}/tracks?limit=50`);
      entries = tracks?.items ?? [];
      if (entries.length) {
        return {
          listable: true,
          tracks: entries
            .map((e) => slimTrack(e.item ?? e.track))
            .filter((t: object | null): t is object => t !== null),
        };
      }
    } catch (e) {
      // 403 / no track list — the frontend falls back to play-only.
    }
  }
  return {
    listable: !!(data?.items || data?.tracks) || entries.length > 0,
    tracks: entries
      .map((e) => slimTrack(e.item ?? e.track))
      .filter((t: object | null): t is object => t !== null),
  };
}

/**
 * Walk a Spotify paging object, collecting up to `max` items across pages.
 * `path` must not already contain a query string (all our callers pass bare
 * endpoint paths like `/me/tracks`).
 */
async function paginate(path: string, max = 200): Promise<any[]> {
  const items: any[] = [];
  let offset = 0;
  while (items.length < max) {
    const data = await spotifyFetch(`${path}?limit=50&offset=${offset}`);
    const batch = data?.items ?? [];
    items.push(...batch);
    if (!batch.length || items.length >= (data?.total ?? 0)) break;
    offset += batch.length;
  }
  return items.slice(0, max);
}

/**
 * Slim track list of the user's Liked Songs (requires `user-library-read`,
 * added to the OAuth scope list — reconnect once if the list won't load).
 * Paginates a few pages so the list shows more than the default 50.
 */
export async function getLikedTracks(): Promise<{ tracks: object[] }> {
  const items = await paginate("/me/tracks", 200);
  return {
    tracks: items
      .map((e: TrackEntry) => slimTrack(e.track))
      .filter((t: object | null): t is object => t !== null),
  };
}

/**
 * Find the user's current "daylist". Spotify regenerates it several times a
 * day under a brand-new playlist id, so any pinned id goes 404 within hours.
 * The live one always sits in the user's own playlist list (its name starts
 * with "daylist"), which is exactly what the app's Made For You hub shows.
 */
export async function getDaylist(): Promise<{ id: string; name: string } | null> {
  const items = await paginate("/me/playlists", 200);
  const daylist = items.find((p) =>
    typeof p?.name === "string" && p.name.toLowerCase().startsWith("daylist")
  );
  if (!daylist?.id) return null;
  return { id: daylist.id, name: daylist.name };
}

/** Slim shape of the user's playlists (GET /v1/me/playlists). */
export async function getPlaylists(): Promise<object[]> {
  const data = await spotifyFetch("/me/playlists?limit=50");
  // Note: Spotify removed `tracks.total` from playlist items in the API, so
  // we no longer try to show a track count.
  return (data?.items ?? []).map((p: {
    id: string;
    name: string;
    images: { url: string }[];
    owner: { display_name: string };
    public: boolean | null;
  }) => ({
    id: p.id,
    name: p.name,
    image: p.images?.[0]?.url ?? "",
    owner: p.owner?.display_name ?? "",
    public: p.public,
  }));
}
