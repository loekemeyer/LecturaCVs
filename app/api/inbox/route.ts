import { fetchZonaJobsEmails } from "@/lib/gmail";
import { parseZonaJobsApplication } from "@/lib/zonajobs";

export const runtime = "nodejs";
export const maxDuration = 60;

// Lee Gmail, filtra los mails de ZonaJobs y devuelve las postulaciones parseadas.
export async function POST() {
  if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) {
    return Response.json(
      {
        error:
          "El servidor no tiene configurada la casilla de correo (GMAIL_USER / GMAIL_APP_PASSWORD).",
      },
      { status: 500 },
    );
  }

  try {
    const emails = await fetchZonaJobsEmails(50);
    const applications = emails
      .map((e) => {
        const parsed = parseZonaJobsApplication(e.subject, e.text);
        return parsed ? { ...parsed, uid: e.uid, date: e.date } : null;
      })
      .filter((a): a is NonNullable<typeof a> => a !== null);

    return Response.json({ applications });
  } catch (err) {
    console.error("Error al leer Gmail:", err);
    const msg = err instanceof Error ? err.message : "No se pudo leer el correo.";
    return Response.json({ error: msg }, { status: 502 });
  }
}
