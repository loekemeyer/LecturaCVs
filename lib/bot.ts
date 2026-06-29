// Motor del bot de reclutamiento por WhatsApp: maneja la conversación (5 preguntas
// por puesto), guarda las respuestas y deja el estado listo para puntuar.
// La puntuación con IA y el módulo Excel se enchufan en una etapa siguiente.
import { supabaseAdmin } from "./supabase";
import { sendText, sendTemplate, sendDocumentByLink, downloadMedia } from "./whatsapp";

export interface BotQuestion {
  q: string;
  type?: string; // "abierta" | "si_no" | etc. (informativo por ahora)
}

interface SessionRow {
  id: string;
  candidate_id: string;
  search_id: string | null;
  phone: string;
  status: string;
  current_index: number;
  answers: { q: string; a: string; at: string }[];
}

const nowIso = () => new Date().toISOString();

async function activeSession(phone: string): Promise<SessionRow | null> {
  const { data } = await supabaseAdmin()
    .from("bot_sessions")
    .select("*")
    .eq("phone", phone)
    .in("status", ["pending", "in_progress", "awaiting_excel"])
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data as SessionRow | null) ?? null;
}

async function questionsFor(searchId: string | null): Promise<BotQuestion[]> {
  if (!searchId) return [];
  const { data } = await supabaseAdmin()
    .from("searches")
    .select("bot_questions")
    .eq("id", searchId)
    .maybeSingle();
  const q = (data as { bot_questions?: unknown } | null)?.bot_questions;
  return Array.isArray(q) ? (q as BotQuestion[]) : [];
}

async function logMsg(sessionId: string, phone: string, direction: "in" | "out", body: string) {
  await supabaseAdmin().from("bot_messages").insert({ session_id: sessionId, phone, direction, body });
}

async function patch(id: string, p: Record<string, unknown>) {
  await supabaseAdmin().from("bot_sessions").update({ ...p, updated_at: nowIso() }).eq("id", id);
}

async function ask(s: SessionRow, qs: BotQuestion[], index: number) {
  const text = `Pregunta ${index + 1} de ${qs.length}:\n\n${qs[index].q}`;
  await sendText(s.phone, text);
  await logMsg(s.id, s.phone, "out", text);
}

export interface InboundMsg {
  from: string;
  text?: string;
  documentId?: string;
  documentName?: string;
}

export async function handleInbound(msg: InboundMsg): Promise<void> {
  const phone = msg.from;
  const s = await activeSession(phone);
  if (!s) return; // no hay evaluación activa para este número
  await logMsg(
    s.id,
    phone,
    "in",
    msg.text || (msg.documentId ? `[documento ${msg.documentName || ""}]` : "[mensaje]"),
  );

  const qs = await questionsFor(s.search_id);

  // 1) Recién arranca: el candidato respondió a la plantilla → primera pregunta.
  if (s.status === "pending") {
    if (qs.length === 0) {
      await sendText(phone, "¡Gracias por tu interés! En breve te contactamos.");
      await patch(s.id, { status: "completed", completed_at: nowIso() });
      return;
    }
    await patch(s.id, { status: "in_progress", current_index: 0 });
    await sendText(phone, "¡Perfecto, arrancamos! Son unas preguntas cortas.");
    await ask(s, qs, 0);
    return;
  }

  // 2) En curso: guardamos la respuesta y avanzamos.
  if (s.status === "in_progress" && msg.text) {
    const answers = Array.isArray(s.answers) ? s.answers : [];
    const idx = s.current_index;
    answers.push({ q: qs[idx]?.q || "", a: msg.text, at: nowIso() });
    const next = idx + 1;
    if (next < qs.length) {
      await patch(s.id, { answers, current_index: next });
      await ask({ ...s }, qs, next);
    } else {
      // Terminó las preguntas. Si hay Excel configurado, lo mandamos.
      const excel = process.env.RECRUIT_EXCEL_URL;
      if (excel) {
        await patch(s.id, { answers, status: "awaiting_excel" });
        await sendDocumentByLink(
          phone,
          excel,
          "Prueba Excel.xlsx",
          "Resolvé esta prueba y reenviá el archivo por este chat. En una hoja está el ejercicio y en otra la explicación.",
        );
        await sendText(phone, "Cuando lo tengas, mandá el Excel resuelto por acá. ¡Gracias!");
      } else {
        await patch(s.id, { answers, status: "completed", completed_at: nowIso() });
        await sendText(
          phone,
          "¡Listo! Terminamos por ahora. Gracias por responder, te contactamos por los próximos pasos.",
        );
      }
    }
    return;
  }

  // 3) Esperando el Excel resuelto.
  if (s.status === "awaiting_excel" && msg.documentId) {
    try {
      const media = await downloadMedia(msg.documentId);
      const path = `${s.id}/${media.filename}`;
      // Guardado y corrección automática se completan en la etapa del módulo Excel.
      await patch(s.id, {
        excel_path: path,
        excel_detail: { mediaId: msg.documentId, filename: media.filename, bytes: media.buffer.length },
        status: "completed",
        completed_at: nowIso(),
      });
      await sendText(phone, "¡Recibido! Gracias, ya lo revisamos y te contactamos. 👍");
    } catch {
      await sendText(phone, "No pude recibir el archivo, ¿lo reenviás como documento de Excel?");
    }
    return;
  }

  // Fuera de flujo.
  if (msg.text) {
    await sendText(phone, "Gracias por tu mensaje. Seguí las indicaciones que te enviamos para continuar.");
  }
}

/** Crea una sesión y manda el primer mensaje (plantilla aprobada). */
export async function startSession(opts: {
  candidateId: string;
  searchId: string;
  phone: string;
  templateName?: string;
  params?: string[];
}): Promise<string> {
  const id = `${opts.candidateId}-${Date.now()}`;
  await supabaseAdmin().from("bot_sessions").insert({
    id,
    candidate_id: opts.candidateId,
    search_id: opts.searchId || null,
    phone: opts.phone,
    status: "pending",
    current_index: 0,
    answers: [],
  });
  const tpl = opts.templateName || process.env.RECRUIT_WA_TEMPLATE;
  if (tpl) {
    await sendTemplate(opts.phone, tpl, "es_AR", opts.params || []);
    await logMsg(id, opts.phone, "out", `[plantilla ${tpl}]`);
  }
  return id;
}
