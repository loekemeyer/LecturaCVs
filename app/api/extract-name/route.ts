import Anthropic from "@anthropic-ai/sdk";
import { extractCandidateName } from "@/lib/scoring";
import { detectMediaType, MAX_UPLOAD_BYTES } from "@/lib/upload";

export const runtime = "nodejs";
export const maxDuration = 30;

// Lee el CV (PDF o imagen) y devuelve solo el nombre del postulante.
export async function POST(req: Request) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return Response.json({ error: "Falta ANTHROPIC_API_KEY." }, { status: 500 });
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return Response.json({ error: "Petición inválida." }, { status: 400 });
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    return Response.json({ error: "Falta el archivo." }, { status: 400 });
  }
  const mediaType = detectMediaType(file);
  if (!mediaType) {
    return Response.json({ error: "Tipo de archivo no soportado." }, { status: 400 });
  }
  if (file.size === 0 || file.size > MAX_UPLOAD_BYTES) {
    return Response.json({ error: "Archivo inválido." }, { status: 400 });
  }

  const fileBase64 = Buffer.from(await file.arrayBuffer()).toString("base64");

  try {
    const name = await extractCandidateName({ fileBase64, mediaType });
    return Response.json({ name });
  } catch (err) {
    console.error("Error al extraer nombre:", err);
    if (err instanceof Anthropic.APIError) {
      return Response.json({ error: err.message }, { status: 502 });
    }
    return Response.json({ error: "No se pudo leer el nombre." }, { status: 500 });
  }
}
