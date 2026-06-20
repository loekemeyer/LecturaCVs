import { scanZonaJobsAvisos, fetchZonaJobsEmailsByUids } from "@/lib/gmail";
import { parseZonaJobsApplication } from "@/lib/zonajobs";

export const runtime = "nodejs";
export const maxDuration = 60;

function bad(error: string, status = 400) {
  return Response.json({ error }, { status });
}

// Dos acciones:
// - { action: "scan", months }  -> lista de avisos con su cantidad de CVs (liviano).
// - { action: "import", uids }   -> importa los CVs de los mails indicados (un aviso).
export async function POST(req: Request) {
  if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) {
    return bad(
      "El servidor no tiene configurada la casilla de correo (GMAIL_USER / GMAIL_APP_PASSWORD).",
      500,
    );
  }

  let body: { action?: unknown; months?: unknown; uids?: unknown } = {};
  try {
    body = await req.json();
  } catch {
    /* body vacío: lo tratamos como scan por defecto */
  }

  const action = String(body?.action ?? "scan");

  try {
    if (action === "scan") {
      const months = Number(body?.months) || 4;
      const avisos = await scanZonaJobsAvisos(months);
      return Response.json({ avisos });
    }

    // import
    const uids = Array.isArray(body?.uids)
      ? body.uids.map((u) => Number(u)).filter((n) => Number.isFinite(n))
      : [];
    if (!uids.length) return bad("No se indicaron avisos para importar.");

    const emails = await fetchZonaJobsEmailsByUids(uids);
    const applications = emails
      .map((e) => {
        const parsed = parseZonaJobsApplication(e.subject, e.text);
        return parsed ? { ...parsed, uid: e.uid, date: e.date } : null;
      })
      .filter((a): a is NonNullable<typeof a> => a !== null);

    return Response.json({ applications });
  } catch (err) {
    console.error("Error en /api/inbox:", err);
    const msg = err instanceof Error ? err.message : "No se pudo leer el correo.";
    return bad(msg, 502);
  }
}
