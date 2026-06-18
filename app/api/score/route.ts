import Anthropic from "@anthropic-ai/sdk";
import { scoreCv, type ScoreCvInput } from "@/lib/scoring";
import { detectMediaType, MAX_UPLOAD_BYTES } from "@/lib/upload";
import type { Criterion } from "@/lib/types";

export const runtime = "nodejs";
// Puntuar un CV con la IA puede tardar; damos margen.
export const maxDuration = 60;

function bad(error: string, status = 400) {
  return Response.json({ error }, { status });
}

export async function POST(req: Request) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return bad(
      "El servidor no tiene configurada ANTHROPIC_API_KEY. Agregala en .env.local (ver README).",
      500,
    );
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return bad("La petición no es un formulario válido.");
  }

  const file = form.get("file");
  const cvText = ((form.get("cvText") as string | null) ?? "").trim();
  const criteriaRaw = form.get("criteria");
  const jobContext = (form.get("jobContext") as string | null) ?? "";
  const offeredSalary = (form.get("offeredSalary") as string | null) ?? "";
  const expectedSalary = (form.get("expectedSalary") as string | null) ?? "";

  let criteria: Criterion[];
  try {
    criteria = JSON.parse(String(criteriaRaw));
  } catch {
    return bad("Los criterios enviados no son válidos.");
  }
  if (!Array.isArray(criteria) || criteria.length === 0) {
    return bad("Definí al menos un criterio de evaluación.");
  }

  // Dos modos: archivo (PDF/imagen) o el CV como texto (cuerpo de un mail).
  let source: Pick<ScoreCvInput, "fileBase64" | "mediaType" | "cvText" | "fileName">;
  if (file instanceof File) {
    const mediaType = detectMediaType(file);
    if (!mediaType) return bad("El archivo debe ser un PDF o una imagen (PNG, JPG, WEBP).");
    if (file.size === 0) return bad("El archivo está vacío.");
    if (file.size > MAX_UPLOAD_BYTES) return bad("El archivo supera el límite de 15 MB.", 413);
    const fileBase64 = Buffer.from(await file.arrayBuffer()).toString("base64");
    source = { fileBase64, mediaType, fileName: file.name };
  } else if (cvText) {
    source = { cvText, fileName: (form.get("fileName") as string | null) || "CV" };
  } else {
    return bad("Falta el archivo (PDF/imagen) o el texto del CV.");
  }

  try {
    const evaluation = await scoreCv({
      ...source,
      criteria,
      jobContext,
      offeredSalary,
      expectedSalary,
    });
    return Response.json(evaluation);
  } catch (err) {
    console.error("Error al puntuar CV:", err);

    if (err instanceof Anthropic.AuthenticationError) {
      return bad("La API key de Anthropic es inválida. Revisá ANTHROPIC_API_KEY.", 500);
    }
    if (err instanceof Anthropic.RateLimitError) {
      return bad(
        "Se alcanzó el límite de la API de Anthropic. Esperá unos segundos y reintentá.",
        429,
      );
    }
    if (err instanceof Anthropic.APIError) {
      return bad(`Error de la API de Anthropic: ${err.message}`, 502);
    }
    const message = err instanceof Error ? err.message : "Error desconocido al procesar el CV.";
    return bad(message, 500);
  }
}
