// Player state — Plan A, function 2 of 3.
//   GET  /player/token       → fresh Spotify access token for the Web Playback SDK
//   GET  /player/now-playing → slim current-track payload (polled by the site)
//   POST /player/device      → register the SDK's device_id (body: { "device_id": "..." })
//
// Every endpoint resolves Spotify tokens for the *caller*: the visitor's
// anonymous id (x-app-user) + session secret (x-app-secret) select their own
// user_tokens row, so each person sees only their own playlists/liked/daylist.

import { handlePreflight, json } from "../_shared/cors.ts";
import {
  db,
  getDaylist,
  getLikedTracks,
  getNowPlaying,
  getPlaylistTracks,
  getPlaylists,
  getSession,
  getValidTokens,
  spotifyFetch,
  SpotErr,
} from "../_shared/spotify.ts";

Deno.serve(async (req) => {
  const preflight = handlePreflight(req);
  if (preflight) return preflight;
  // JWT verification is handled by Supabase's gateway (default for deploy).

  try {
    const url = new URL(req.url);
    const action = url.pathname.split("/").filter(Boolean).pop() ?? "";
    const session = getSession(req);

    // ---- access token for the Web Playback SDK ----------------------------
    if (req.method === "GET" && action === "token") {
      const tokens = await getValidTokens(session);
      if (!tokens) return json({ error: "not_connected" }, 401);
      // Include the connected account's profile so the site can show who's
      // logged in next to the log out button (best-effort, never fatal).
      let display_name = "";
      let image = "";
      try {
        const me = await spotifyFetch("/me", {}, session);
        display_name = me?.display_name ?? me?.id ?? "";
        image = me?.images?.[0]?.url ?? "";
      } catch (e) { /* profile is optional */ }
      return json({
        access_token: tokens.accessToken,
        scopes: tokens.scope,
        display_name,
        image,
      });
    }

    // ---- slim now-playing payload -----------------------------------------
    if (req.method === "GET" && action === "now-playing") {
      return json(await getNowPlaying(session));
    }

    // ---- the user's playlists (for the site's playlist browser) ------------
    if (req.method === "GET" && action === "playlists") {
      return json({ playlists: await getPlaylists(session) });
    }

    // ---- tracks inside a playlist (for the drill-down view) ----------------
    if (req.method === "GET" && action === "playlist") {
      const id = url.searchParams.get("id");
      if (!id) return json({ error: "id required" }, 400);
      return json(await getPlaylistTracks(id, session));
    }

    // ---- the user's Liked Songs (for the drill-down view) ------------------
    if (req.method === "GET" && action === "liked") {
      return json(await getLikedTracks(session));
    }

    // ---- the user's current daylist ----------------------------------------
    // The daylist playlist id rotates several times a day, so a pinned id
    // 404s as soon as the day rolls over. Resolve the live one from the
    // user's own playlist list each time instead.
    if (req.method === "GET" && action === "daylist") {
      const daylist = await getDaylist(session);
      if (!daylist) {
        return json(
          { error: "no daylist found — open the daylist in the Spotify app once, then retry" },
          404,
        );
      }
      const { tracks, listable } = await getPlaylistTracks(daylist.id, session);
      return json({ id: daylist.id, name: daylist.name, tracks, listable });
    }

    // ---- register the browser's Web Playback SDK device -------------------
    if (req.method === "POST" && action === "device") {
      const { device_id } = await req.json();
      if (!device_id) return json({ error: "device_id required" }, 400);
      if (session) {
        // update only — never overwrite the user_secret with an upsert.
        const { error } = await db
          .from("user_tokens")
          .update({ device_id, updated_at: new Date().toISOString() })
          .eq("user_id", session.user);
        if (error) throw error;
      } else {
        const { error } = await db
          .from("app_state")
          .upsert({ id: 1, device_id, updated_at: new Date().toISOString() });
        if (error) throw error;
      }
      return json({ ok: true });
    }

    return json({ error: "not found" }, 404);
  } catch (e) {
    if (e instanceof SpotErr) return json({ error: e.message }, e.status);
    return json({ error: (e as Error).message }, 500);
  }
});
