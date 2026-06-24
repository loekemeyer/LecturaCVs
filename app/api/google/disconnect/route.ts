// Desconecta Google Calendar (borra el token guardado).
import { isAuthorized, unauthorized } from "@/lib/auth";
import { supabaseAdmin, supabaseConfigured } from "@/lib/supabase";

export const runtime = "nodejs";

export async function POST(req: Request) {
  if (!isAuthorized(req)) return unauthorized();
  if (!supabaseConfigured()) return Response.json({ ok: true });
  try {
    await supabaseAdmin()
      .from("app_settings")
      .upsert({
        id: "default",
        google_refresh_token: null,
        google_email: null,
        updated_at: new Date().toISOString(),
      });
    return Response.json({ ok: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "No se pudo desconectar.";
    return Response.json({ error: msg }, { status: 502 });
  }
}
