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

// Borra una evaluación (sesión) y sus mensajes. Para limpiar pruebas, etc.
export async function DELETE(req: Request) {
  if (!isAuthorized(req)) return unauthorized();
  if (!supabaseConfigured()) return Response.json({ error: "Sin base de datos." }, { status: 500 });
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return Response.json({ error: "Falta el id." }, { status: 400 });
  const sb = supabaseAdmin();
  await sb.from("bot_messages").delete().eq("session_id", id);
  const { error } = await sb.from("bot_sessions").delete().eq("id", id);
  if (error) return Response.json({ error: error.message }, { status: 502 });
  return Response.json({ ok: true });
}
