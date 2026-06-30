// Devuelve un enlace temporal (firmado) para descargar el Excel que envió un
// candidato, a partir del id de la evaluación (sesión). Para verificar a mano.
import { isAuthorized, unauthorized } from "@/lib/auth";
import { supabaseAdmin, supabaseConfigured } from "@/lib/supabase";

export const runtime = "nodejs";

export async function GET(req: Request) {
  if (!isAuthorized(req)) return unauthorized();
  if (!supabaseConfigured()) return Response.json({ error: "Sin base de datos." }, { status: 500 });
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return Response.json({ error: "Falta el id." }, { status: 400 });

  const sb = supabaseAdmin();
  const { data: sess } = await sb
    .from("bot_sessions")
    .select("excel_path")
    .eq("id", id)
    .maybeSingle();
  const path = (sess as { excel_path?: string } | null)?.excel_path;
  if (!path) {
    return Response.json({ error: "Esta evaluación no tiene un Excel guardado." }, { status: 404 });
  }
  const bucket = process.env.RECRUIT_EXCEL_BUCKET || "bot-assets";
  const { data, error } = await sb.storage.from(bucket).createSignedUrl(path, 300);
  if (error || !data?.signedUrl) {
    return Response.json(
      { error: "No se pudo generar el enlace (puede ser una evaluación vieja, sin archivo guardado)." },
      { status: 404 },
    );
  }
  return Response.json({ url: data.signedUrl });
}
