// Lista las evaluaciones por WhatsApp (para la pantalla de resultados).
import { isAuthorized, unauthorized } from "@/lib/auth";
import { supabaseAdmin, supabaseConfigured } from "@/lib/supabase";

export const runtime = "nodejs";

export async function GET(req: Request) {
  if (!isAuthorized(req)) return unauthorized();
  if (!supabaseConfigured()) return Response.json({ sessions: [] });
  const { data } = await supabaseAdmin()
    .from("bot_sessions")
    .select("*")
    .order("updated_at", { ascending: false })
    .limit(500);
  return Response.json({ sessions: data ?? [] });
}
