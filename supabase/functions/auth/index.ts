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
  getSession,
  randomBase64url,
  saveTokens,
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
      // The visitor's anonymous id (optional for legacy links, required for
      // multi-user): must look like a random id, not a URL or weird input.
      const user = url.searchParams.get("user") ?? "";
      if (user && !/^[A-Za-z0-9_-]{8,128}$/.test(user)) {
        return json({ error: "invalid_user" }, 400);
      }
      const verifier = generateVerifier();
      const [challenge, state] = await Promise.all([
        generateChallenge(verifier),
        randomBase64url(32),
      ]);
      // Verifier must survive across two separate function invocations →
      // Postgres. For multi-user, the visitor's id + a fresh session secret
      // ride along in the same row; the callback hands the secret back to the
      // browser via a URL fragment (never through Spotify or server logs).
      const userSecret = randomBase64url(32);
      const { error } = await db.from("pkce_store").upsert({
        state,
        verifier,
        user_id: user || null,
        user_secret: userSecret,
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
        .select("verifier, created_at, user_id, user_secret")
        .eq("state", state)
        .maybeSingle();
      await db.from("pkce_store").delete().eq("state", state); // one-time use

      if (!data || Date.now() - new Date(data.created_at).getTime() > HANDSHAKE_TTL_MS) {
        return Response.redirect(`${siteUrl()}/?error=expired_state`, 302);
      }

      try {
        const tokens = await exchangeCode(code, data.verifier);
        if (data.user_id) {
          await saveTokens(tokens, { user: data.user_id, secret: data.user_secret });
        } else {
          await saveTokens(tokens); // legacy single-user row
        }
        const frag = data.user_id
          ? `#session=${encodeURIComponent(data.user_secret)}`
          : "";
        return Response.redirect(`${siteUrl()}/?connected=1${frag}`, 302);
      } catch (e) {
        return Response.redirect(
          `${siteUrl()}/?error=${encodeURIComponent((e as Error).message)}`,
          302,
        );
      }
    }

    // ---- /auth/logout -----------------------------------------------------
    // Clears the *caller's* stored Spotify tokens so the site drops back to
    // the connect screen. With an identity this only touches that user's row;
    // the secret must match or we refuse (a public id alone can't log someone
    // else out).
    if (req.method === "POST" && action === "logout") {
      const session = getSession(req);
      if (session) {
        const { data } = await db
          .from("user_tokens")
          .select("user_secret")
          .eq("user_id", session.user)
          .maybeSingle();
        if (!data || data.user_secret !== session.secret) {
          return json({ error: "session_invalid" }, 403);
        }
        await db.from("user_tokens").delete().eq("user_id", session.user);
      } else {
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
      }
      return json({ ok: true });
    }

    return json({ error: "not found" }, 404);
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
