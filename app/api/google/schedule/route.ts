// Crea un evento de entrevista en Google Calendar y, si es online, genera el link
// de Meet. Devuelve el link de Meet y el del evento.
import { isAuthorized, unauthorized } from "@/lib/auth";
import { refreshAccessToken } from "@/lib/google";
import { supabaseAdmin, supabaseConfigured } from "@/lib/supabase";

export const runtime = "nodejs";
export const maxDuration = 30;

const TZ = "America/Argentina/Buenos_Aires";

function bad(error: string, status = 400) {
  return Response.json({ error }, { status });
}

export async function POST(req: Request) {
  if (!isAuthorized(req)) return unauthorized();
  if (!supabaseConfigured()) return bad("Base de datos no configurada.", 500);

  let body: {
    summary?: unknown;
    description?: unknown;
    startISO?: unknown;
    durationMin?: unknown;
    online?: unknown;
    location?: unknown;
    attendees?: unknown;
    force?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return bad("Petición inválida.");
  }

  const summary = String(body.summary ?? "Entrevista").trim();
  const description = String(body.description ?? "");
  const startISO = String(body.startISO ?? "");
  const durationMin = Number(body.durationMin ?? 30) || 30;
  const online = !!body.online;
  const location = String(body.location ?? "").trim();
  const force = !!body.force; // saltear el aviso de superposición
  const attendees = Array.isArray(body.attendees)
    ? (body.attendees as unknown[]).map((a) => String(a)).filter((a) => /@/.test(a))
    : [];

  const start = new Date(startISO);
  if (isNaN(start.getTime())) return bad("Fecha/hora de la entrevista inválida.");
  const end = new Date(start.getTime() + durationMin * 60000);

  // Token de la cuenta conectada.
  const { data } = await supabaseAdmin()
    .from("app_settings")
    .select("google_refresh_token")
    .eq("id", "default")
    .maybeSingle();
  const refresh = (data?.google_refresh_token as string) || "";
  if (!refresh) return bad("Google Calendar no está conectado. Conectalo en «Mi perfil».", 400);

  try {
    const accessToken = await refreshAccessToken(refresh);

    // Aviso (no bloqueante) si ya hay entrevistas en ese horario. Solo se chequea
    // cuando NO se forzó: el cliente vuelve a llamar con force=true para confirmar.
    if (!force) {
      const q = new URLSearchParams({
        timeMin: start.toISOString(),
        timeMax: end.toISOString(),
        singleEvents: "true",
        orderBy: "startTime",
        maxResults: "10",
      });
      const cRes = await fetch(
        `https://www.googleapis.com/calendar/v3/calendars/primary/events?${q.toString()}`,
        { headers: { authorization: `Bearer ${accessToken}` } },
      );
      if (cRes.ok) {
        const cData = await cRes.json();
        type Ev = { status?: string; summary?: string; start?: { dateTime?: string; date?: string } };
        const items: Ev[] = Array.isArray(cData.items) ? cData.items : [];
        const conflicts = items
          .filter((e) => e.status !== "cancelled" && (e.start?.dateTime || e.start?.date))
          .map((e) => ({ summary: e.summary || "(sin título)", start: e.start?.dateTime || e.start?.date || "" }));
        if (conflicts.length) return Response.json({ conflict: true, conflicts });
      }
    }

    const event: Record<string, unknown> = {
      summary,
      description,
      start: { dateTime: start.toISOString(), timeZone: TZ },
      end: { dateTime: end.toISOString(), timeZone: TZ },
    };
    if (location && !online) event.location = location;
    if (attendees.length) event.attendees = attendees.map((email) => ({ email }));
    if (online) {
      event.conferenceData = {
        createRequest: {
          requestId: `lcv-${Date.now()}-${Math.random().toString(36).slice(2)}`,
          conferenceSolutionKey: { type: "hangoutsMeet" },
        },
      };
    }

    const res = await fetch(
      "https://www.googleapis.com/calendar/v3/calendars/primary/events?conferenceDataVersion=1",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(event),
      },
    );
    const ev = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = ev?.error?.message || `Error ${res.status} al crear el evento.`;
      return bad(msg, 502);
    }

    const meetLink =
      ev.hangoutLink ||
      ev.conferenceData?.entryPoints?.find((p: { entryPointType?: string; uri?: string }) =>
        p.entryPointType === "video",
      )?.uri ||
      "";

    return Response.json({ ok: true, meetLink, htmlLink: ev.htmlLink || "" });
  } catch (err) {
    console.error("Error al agendar en Google Calendar:", err);
    const msg = err instanceof Error ? err.message : "No se pudo agendar la entrevista.";
    return bad(msg, 502);
  }
}
