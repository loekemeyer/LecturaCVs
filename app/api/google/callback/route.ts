// Vuelta de Google: cambia el código por tokens y guarda el refresh token.
import { exchangeCode, redirectUri, originFromReq, emailFromIdToken } from "@/lib/google";
import { supabaseAdmin, supabaseConfigured } from "@/lib/supabase";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const origin = originFromReq(req);
  const code = new URL(req.url).searchParams.get("code");
  if (!code) return Response.redirect(`${origin}/?google=error`, 302);
  try {
    const tokens = await exchangeCode(code, redirectUri(req));
    const email = emailFromIdToken(tokens.id_token);
    if (tokens.refresh_token && supabaseConfigured()) {
      await supabaseAdmin().from("app_settings").upsert({
        id: "default",
        google_refresh_token: tokens.refresh_token,
        google_email: email,
        updated_at: new Date().toISOString(),
      });
    }
    return Response.redirect(`${origin}/?google=connected`, 302);
  } catch (err) {
    console.error("Error en callback de Google:", err);
    return Response.redirect(`${origin}/?google=error`, 302);
  }
}
