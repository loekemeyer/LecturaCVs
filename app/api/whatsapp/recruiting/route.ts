// Webhook del bot de reclutamiento (número dedicado).
// GET  → verificación que pide Meta al configurar el webhook.
// POST → mensajes entrantes del candidato.
import { handleInbound } from "@/lib/bot";

export const runtime = "nodejs";
export const maxDuration = 30;

export async function GET(req: Request) {
  const u = new URL(req.url);
  const mode = u.searchParams.get("hub.mode");
  const token = u.searchParams.get("hub.verify_token");
  const challenge = u.searchParams.get("hub.challenge");
  if (mode === "subscribe" && token && token === process.env.RECRUIT_WA_VERIFY_TOKEN) {
    return new Response(challenge || "", { status: 200 });
  }
  return new Response("forbidden", { status: 403 });
}

interface WaMessage {
  from?: string;
  type?: string;
  text?: { body?: string };
  document?: { id?: string; filename?: string };
}

export async function POST(req: Request) {
  let body: { entry?: { changes?: { value?: { messages?: WaMessage[] } }[] }[] };
  try {
    body = await req.json();
  } catch {
    return new Response("ok");
  }
  try {
    for (const e of body.entry ?? []) {
      for (const ch of e.changes ?? []) {
        for (const m of ch.value?.messages ?? []) {
          const from = m.from;
          if (!from) continue;
          if (m.type === "text") {
            await handleInbound({ from, text: m.text?.body || "" });
          } else if (m.type === "document") {
            await handleInbound({ from, documentId: m.document?.id, documentName: m.document?.filename });
          } else {
            await handleInbound({ from, text: "" });
          }
        }
      }
    }
  } catch (err) {
    console.error("Error en webhook de reclutamiento:", err);
  }
  // A Meta siempre le devolvemos 200 (si no, reintenta).
  return new Response("ok", { status: 200 });
}
