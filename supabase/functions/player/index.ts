// Player state — Plan A, function 2 of 3.
//   GET  /player/token       → fresh Spotify access token for the Web Playback SDK
//   GET  /player/now-playing → slim current-track payload (polled by the site)
//   POST /player/device      → register the SDK's device_id (body: { "device_id": "..." })

import { handlePreflight, json, requireAppKey } from "../_shared/cors.ts";
import {
  db,
  getNowPlaying,
  getValidTokens,
  SpotErr,
} from "../_shared/spotify.ts";

Deno.serve(async (req) => {
  const preflight = handlePreflight(req);
  if (preflight) return preflight;
  if (!requireAppKey(req)) return json({ error: "forbidden" }, 403);

  try {
    const url = new URL(req.url);
    const action = url.pathname.split("/").filter(Boolean).pop() ?? "";

    // ---- access token for the Web Playback SDK ----------------------------
    if (req.method === "GET" && action === "token") {
      const tokens = await getValidTokens();
      if (!tokens) return json({ error: "not_connected" }, 401);
      return json({ access_token: tokens.accessToken });
    }

    // ---- slim now-playing payload -----------------------------------------
    if (req.method === "GET" && action === "now-playing") {
      return json(await getNowPlaying());
    }

    // ---- register the browser's Web Playback SDK device -------------------
    if (req.method === "POST" && action === "device") {
      const { device_id } = await req.json();
      if (!device_id) return json({ error: "device_id required" }, 400);
      const { error } = await db
        .from("app_state")
        .upsert({ id: 1, device_id, updated_at: new Date().toISOString() });
      if (error) throw error;
      return json({ ok: true });
    }

    return json({ error: "not found" }, 404);
  } catch (e) {
    if (e instanceof SpotErr) return json({ error: e.message }, e.status);
    return json({ error: (e as Error).message }, 500);
  }
});
