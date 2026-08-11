// Playback control — Plan A, function 3 of 3.
//   POST /control/play      body: { "device_id"?: "...", "context_uri"?: "spotify:playlist:..." }
//                            → start the playlist (explicit one or the configured default)
//   POST /control/pause
//   POST /control/next
//   POST /control/previous
//
// These hit the Spotify Web API, so they work from anywhere (not just the
// browser tab that owns the SDK). The UI uses the SDK for instant local
// control; these are the server-side truth.

import { handlePreflight, json } from "../_shared/cors.ts";
import {
  playPlaylist,
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
    if (req.method !== "POST") return json({ error: "POST only" }, 405);

    switch (action) {
      case "play": {
        const { device_id, context_uri } = await req.json().catch(() => ({}));
        await playPlaylist(device_id, context_uri);
        return json({ ok: true });
      }
      case "pause":
        await spotifyFetch("/me/player/pause", { method: "PUT" });
        return json({ ok: true });
      case "next":
        await spotifyFetch("/me/player/next", { method: "POST" });
        return json({ ok: true });
      case "previous":
        await spotifyFetch("/me/player/previous", { method: "POST" });
        return json({ ok: true });
      default:
        return json({ error: "not found" }, 404);
    }
  } catch (e) {
    if (e instanceof SpotErr) return json({ error: e.message }, e.status);
    return json({ error: (e as Error).message }, 500);
  }
});
