import { fetchEmailHtml } from "@/lib/gmail";

export const runtime = "nodejs";
export const maxDuration = 30;

// Devuelve el HTML original del mail (con la foto) para "Ver CV completo".
export async function POST(req: Request) {
  if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) {
    return Response.json({ error: "Correo no configurado en el servidor." }, { status: 500 });
  }
  let uid: unknown;
  try {
    ({ uid } = await req.json());
  } catch {
    return Response.json({ error: "Petición inválida." }, { status: 400 });
  }
  if (typeof uid !== "number") {
    return Response.json({ error: "uid inválido." }, { status: 400 });
  }
  try {
    const html = await fetchEmailHtml(uid);
    return Response.json({ html });
  } catch (err) {
    console.error("Error al leer el mail:", err);
    const msg = err instanceof Error ? err.message : "No se pudo leer el correo.";
    return Response.json({ error: msg }, { status: 502 });
  }
}
