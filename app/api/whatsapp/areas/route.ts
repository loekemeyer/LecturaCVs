// Administrar las áreas/preguntas del bot + el mensaje inicial (selector).
import { isAuthorized, unauthorized } from "@/lib/auth";
import { supabaseAdmin, supabaseConfigured } from "@/lib/supabase";

export const runtime = "nodejs";

export async function GET(req: Request) {
  if (!isAuthorized(req)) return unauthorized();
  if (!supabaseConfigured()) return Response.json({ areas: [], initialMessage: "" });
  const sb = supabaseAdmin();
  const [areasRes, settingsRes] = await Promise.all([
    sb.from("bot_areas").select("*").order("position", { ascending: true }),
    sb.from("app_settings").select("bot_initial_message").eq("id", "default").maybeSingle(),
  ]);
  return Response.json({
    areas: areasRes.data ?? [],
    initialMessage:
      (settingsRes.data as { bot_initial_message?: string } | null)?.bot_initial_message ?? "",
  });
}

export async function POST(req: Request) {
  if (!isAuthorized(req)) return unauthorized();
  if (!supabaseConfigured()) return Response.json({ error: "Sin base de datos." }, { status: 500 });
  let body: {
    initialMessage?: unknown;
    area?: {
      id?: string;
      label?: string;
      questions?: unknown;
      excel_message?: string;
      final_message?: string;
      enabled?: boolean;
    };
  };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Petición inválida." }, { status: 400 });
  }
  const sb = supabaseAdmin();
  try {
    if (body.initialMessage !== undefined) {
      await sb.from("app_settings").upsert({
        id: "default",
        bot_initial_message: String(body.initialMessage || ""),
        updated_at: new Date().toISOString(),
      });
      return Response.json({ ok: true });
    }
    const a = body.area;
    if (a?.id) {
      await sb
        .from("bot_areas")
        .update({
          label: a.label ?? "",
          questions: Array.isArray(a.questions) ? a.questions : [],
          excel_message: a.excel_message ?? null,
          final_message: a.final_message ?? null,
          enabled: a.enabled !== false,
          updated_at: new Date().toISOString(),
        })
        .eq("id", a.id);
      return Response.json({ ok: true });
    }
    return Response.json({ error: "Nada para guardar." }, { status: 400 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Error";
    return Response.json({ error: msg }, { status: 502 });
  }
}
