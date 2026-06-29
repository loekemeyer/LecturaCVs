// Inicia una evaluación por WhatsApp para un candidato (lo dispara el botón de la app).
import { isAuthorized, unauthorized } from "@/lib/auth";
import { startSession } from "@/lib/bot";
import { recruitWaConfigured } from "@/lib/whatsapp";

export const runtime = "nodejs";
export const maxDuration = 30;

export async function POST(req: Request) {
  if (!isAuthorized(req)) return unauthorized();
  if (!recruitWaConfigured()) {
    return Response.json(
      { error: "El WhatsApp de reclutamiento todavía no está configurado en el servidor." },
      { status: 500 },
    );
  }
  let body: { candidateId?: unknown; searchId?: unknown; phone?: unknown; params?: unknown };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Petición inválida." }, { status: 400 });
  }
  const candidateId = String(body.candidateId ?? "");
  const searchId = String(body.searchId ?? "");
  const phone = String(body.phone ?? "").replace(/\D/g, "");
  const params = Array.isArray(body.params) ? (body.params as unknown[]).map(String) : [];
  if (!candidateId || !phone) {
    return Response.json({ error: "Faltan el candidato o el teléfono." }, { status: 400 });
  }
  try {
    const sessionId = await startSession({ candidateId, searchId, phone, params });
    return Response.json({ ok: true, sessionId });
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : "No se pudo iniciar la evaluación." },
      { status: 502 },
    );
  }
}
