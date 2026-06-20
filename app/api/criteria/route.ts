import Anthropic from "@anthropic-ai/sdk";
import { suggestCriteria } from "@/lib/criteria";

export const runtime = "nodejs";
// Analizar el aviso con la IA puede tardar; damos margen.
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

  let body: { posting?: unknown; title?: unknown; companyValues?: unknown };
  try {
    body = await req.json();
  } catch {
    return bad("La petición no es un JSON válido.");
  }

  const posting = String(body?.posting ?? "").trim();
  const title = String(body?.title ?? "").trim();
  const companyValues = String(body?.companyValues ?? "").trim();
  if (!posting) return bad("Pegá el texto del aviso para que la IA sugiera los criterios.");

  try {
    const criteria = await suggestCriteria(posting, title, companyValues);
    return Response.json({ criteria });
  } catch (err) {
    console.error("Error al sugerir criterios:", err);

    if (err instanceof Anthropic.AuthenticationError) {
      return bad("La API key de Anthropic es inválida. Revisá ANTHROPIC_API_KEY.", 500);
    }
    if (err instanceof Anthropic.RateLimitError) {
      return bad("Se alcanzó el límite de la API de Anthropic. Esperá unos segundos y reintentá.", 429);
    }
    if (err instanceof Anthropic.APIError) {
      return bad(`Error de la API de Anthropic: ${err.message}`, 502);
    }
    const message = err instanceof Error ? err.message : "Error desconocido al analizar el aviso.";
    return bad(message, 500);
  }
}
