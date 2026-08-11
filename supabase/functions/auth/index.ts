// Spotify OAuth — Plan A, function 1 of 3.
//   GET /auth/start    → 302 redirect to Spotify's authorize page (PKCE)
//   GET /auth/callback → exchange code, store refresh token, redirect to the site
//
// Deployed URL: https://<ref>.supabase.co/functions/v1/auth/start
//               https://<ref>.supabase.co/functions/v1/auth/callback (the Spotify Redirect URI)

import {
  authorizeUrl,
  db,
  exchangeCode,
  generateChallenge,
  generateVerifier,
  randomBase64url,
  siteUrl,
} from "../_shared/spotify.ts";
import { handlePreflight, json } from "../_shared/cors.ts";

const HANDSHAKE_TTL_MS = 10 * 60 * 1000;

Deno.serve(async (req) => {
  const preflight = handlePreflight(req);
  if (preflight) return preflight;

  try {
    const url = new URL(req.url);
    const action = url.pathname.split("/").filter(Boolean).pop() ?? "";

    // ---- /auth/start -----------------------------------------------------
    if (req.method === "GET" && action === "start") {
      const verifier = generateVerifier();
      const [challenge, state] = await Promise.all([
        generateChallenge(verifier),
        randomBase64url(32),
      ]);
      // Verifier must survive across two separate function invocations → Postgres.
      const { error } = await db.from("pkce_store").upsert({
        state,
        verifier,
        created_at: new Date().toISOString(),
      });
      if (error) throw error;
      return Response.redirect(authorizeUrl(state, challenge), 302);
    }

    // ---- /auth/callback ----------------------------------------------------
    if (req.method === "GET" && action === "callback") {
      const errorParam = url.searchParams.get("error");
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");

      if (errorParam || !code || !state) {
        return Response.redirect(
          `${siteUrl()}/?error=${encodeURIComponent(errorParam ?? "missing_params")}`,
          302,
        );
      }

      const { data } = await db
        .from("pkce_store")
        .select("verifier, created_at")
        .eq("state", state)
        .maybeSingle();
      await db.from("pkce_store").delete().eq("state", state); // one-time use

      if (!data || Date.now() - new Date(data.created_at).getTime() > HANDSHAKE_TTL_MS) {
        return Response.redirect(`${siteUrl()}/?error=expired_state`, 302);
      }

      try {
        await exchangeCode(code, data.verifier);
      } catch (e) {
        return Response.redirect(
          `${siteUrl()}/?error=${encodeURIComponent((e as Error).message)}`,
          302,
        );
      }
      return Response.redirect(`${siteUrl()}/?connected=1`, 302);
    }

    // ---- /auth/logout -----------------------------------------------------
    // Clears the stored Spotify tokens so the site drops back to the connect
    // screen — a fresh authorize (with current scopes) fixes stale sessions.
    if (req.method === "POST" && action === "logout") {
      const { error } = await db
        .from("app_state")
        .update({
          refresh_token: null,
          access_token: null,
          expires_at: null,
          scope: null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", 1);
      if (error) throw error;
      return json({ ok: true });
    }

    return json({ error: "not found" }, 404);
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
