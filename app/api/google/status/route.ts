// Estado de la conexión con Google Calendar (conectado + con qué cuenta).
import { isAuthorized, unauthorized } from "@/lib/auth";
import { supabaseAdmin, supabaseConfigured } from "@/lib/supabase";

export const runtime = "nodejs";

export async function GET(req: Request) {
  if (!isAuthorized(req)) return unauthorized();
  if (!supabaseConfigured()) return Response.json({ connected: false, email: "" });
  try {
    const { data } = await supabaseAdmin()
      .from("app_settings")
      .select("google_refresh_token, google_email")
      .eq("id", "default")
      .maybeSingle();
    return Response.json({
      connected: !!data?.google_refresh_token,
      email: (data?.google_email as string) || "",
    });
  } catch {
    return Response.json({ connected: false, email: "" });
  }
}
