// Shared CORS + response helpers for all Edge Functions.
const origin = Deno.env.get("ALLOWED_ORIGIN");

export const corsHeaders = {
  "Access-Control-Allow-Origin": origin ?? "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-app-key",
  "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
};

/** Return a preflight response for OPTIONS requests, or null. */
export function handlePreflight(req: Request): Response | null {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  return null;
}

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

/**
 * Simple shared-secret gate for player/control endpoints.
 * If APP_KEY is unset or still the placeholder, the endpoints are open.
 * The frontend sends it as the `x-app-key` header.
 */
export function requireAppKey(req: Request): boolean {
  const key = Deno.env.get("APP_KEY");
  if (!key || key === "change-me") return true;
  return req.headers.get("x-app-key") === key;
}
