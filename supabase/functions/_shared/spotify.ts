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
  "user-read-playback-state",
  "user-modify-playback-state",
  "user-read-currently-playing",
  "playlist-read-private",
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
}

export async function saveTokens(t: {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}): Promise<void> {
  const { error } = await db.from("app_state").upsert({
    id: 1,
    refresh_token: t.refreshToken,
    access_token: t.accessToken,
    expires_at: t.expiresAt,
    updated_at: new Date().toISOString(),
  });
  if (error) throw error;
}

/** Returns cached tokens if fresh, otherwise refreshes and stores. */
export async function getValidTokens(): Promise<Tokens | null> {
  const { data, error } = await db
    .from("app_state")
    .select("refresh_token, access_token, expires_at")
    .eq("id", 1)
    .maybeSingle();
  if (error) throw error;
  if (!data?.refresh_token) return null;

  const expiresAt = (data.expires_at as number | null) ?? 0;
  if (data.access_token && Date.now() < expiresAt) {
    return { accessToken: data.access_token, refreshToken: data.refresh_token };
  }
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
  return res.json();
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

/** Start the configured playlist on Spotify (optionally targeting a device). */
export async function playPlaylist(deviceId?: string): Promise<void> {
  const { data } = await db
    .from("app_state")
    .select("playlist_id")
    .eq("id", 1)
    .maybeSingle();
  const playlistId = data?.playlist_id ?? env("PLAYLIST_ID");
  if (!playlistId) throw new SpotErr(400, "no playlist configured");
  const contextUri = playlistId.startsWith("spotify:")
    ? playlistId
    : `spotify:playlist:${playlistId}`;
  const qs = deviceId ? `?device_id=${encodeURIComponent(deviceId)}` : "";
  await spotifyFetch(`/me/player/play${qs}`, {
    method: "PUT",
    body: JSON.stringify({ context_uri: contextUri, offset: { position: 0 } }),
  });
  if (deviceId) {
    await db
      .from("app_state")
      .upsert({ id: 1, device_id: deviceId, updated_at: new Date().toISOString() });
  }
}
