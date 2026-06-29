// Motor del bot de reclutamiento por WhatsApp.
// Flujo: 1er mensaje (plantilla) = saludo + selector de área (1-4). El candidato
// elige → corremos las preguntas de ESA área (tabla bot_areas) → al final mandamos
// el Excel y, al recibirlo resuelto, el mensaje final. Las preguntas se editan en
// la app (por área). El área arranca por la búsqueda pero el candidato la confirma.
import { supabaseAdmin } from "./supabase";
import { sendText, sendTemplate, sendDocumentByLink, downloadMedia } from "./whatsapp";

export interface BotQuestion {
  q: string;
}

interface AreaRow {
  id: string;
  label: string;
  position: number;
  questions: BotQuestion[];
  excel_message: string | null;
  final_message: string | null;
  enabled: boolean;
}

interface SessionRow {
  id: string;
  candidate_id: string;
  search_id: string | null;
  phone: string;
  status: string;
  current_index: number;
  area: string | null;
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

async function areaById(id: string | null): Promise<AreaRow | null> {
  if (!id) return null;
  const { data } = await supabaseAdmin().from("bot_areas").select("*").eq("id", id).maybeSingle();
  return (data as AreaRow | null) ?? null;
}

async function areaByPosition(pos: number): Promise<AreaRow | null> {
  const { data } = await supabaseAdmin()
    .from("bot_areas")
    .select("*")
    .eq("position", pos)
    .maybeSingle();
  return (data as AreaRow | null) ?? null;
}

async function initialMessage(): Promise<string> {
  const { data } = await supabaseAdmin()
    .from("app_settings")
    .select("bot_initial_message")
    .eq("id", "default")
    .maybeSingle();
  return (data as { bot_initial_message?: string } | null)?.bot_initial_message || "";
}

async function logMsg(sessionId: string, phone: string, direction: "in" | "out", body: string) {
  await supabaseAdmin().from("bot_messages").insert({ session_id: sessionId, phone, direction, body });
}

async function patch(id: string, p: Record<string, unknown>) {
  await supabaseAdmin().from("bot_sessions").update({ ...p, updated_at: nowIso() }).eq("id", id);
}

async function say(s: SessionRow, text: string) {
  await sendText(s.phone, text);
  await logMsg(s.id, s.phone, "out", text);
}

// Arranca las preguntas de un área (manda la primera).
async function startQuestions(s: SessionRow, area: AreaRow) {
  await patch(s.id, { area: area.id, status: "in_progress", current_index: 0 });
  await say({ ...s }, area.questions[0].q);
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
  if (!s) return; // sin evaluación activa para este número
  await logMsg(
    s.id,
    phone,
    "in",
    msg.text || (msg.documentId ? `[documento ${msg.documentName || ""}]` : "[mensaje]"),
  );

  // 1) Selector de área (estado pending): esperamos un número 1-4.
  if (s.status === "pending") {
    const pick = (msg.text || "").match(/[1-4]/)?.[0];
    if (!pick) {
      const sel = await initialMessage();
      await say(s, sel || "Por favor, respondé con el número del área (1, 2, 3 o 4).");
      return;
    }
    const area = await areaByPosition(Number(pick));
    if (!area || !area.enabled) {
      await say(s, "Esa opción no está disponible. Respondé con el número del área (1, 2, 3 o 4).");
      return;
    }
    if (!Array.isArray(area.questions) || area.questions.length === 0) {
      await say(
        s,
        `Por ahora no tenemos preguntas cargadas para ${area.label}. En breve te contactamos. ¡Gracias!`,
      );
      await patch(s.id, { area: area.id, status: "completed", completed_at: nowIso() });
      return;
    }
    await startQuestions(s, area);
    return;
  }

  // 2) En curso: guardamos la respuesta y avanzamos.
  if (s.status === "in_progress" && msg.text) {
    const area = await areaById(s.area);
    const qs = area?.questions ?? [];
    const answers = Array.isArray(s.answers) ? s.answers : [];
    const idx = s.current_index;
    answers.push({ q: qs[idx]?.q || "", a: msg.text, at: nowIso() });
    const next = idx + 1;
    if (next < qs.length) {
      await patch(s.id, { answers, current_index: next });
      await say({ ...s }, qs[next].q);
    } else {
      const excel = process.env.RECRUIT_EXCEL_URL;
      if (excel) {
        await patch(s.id, { answers, status: "awaiting_excel" });
        const cap = area?.excel_message || "Resolvé esta prueba y reenviá el archivo por este chat.";
        await sendDocumentByLink(phone, excel, "Prueba Excel.xlsx", cap);
        await logMsg(s.id, phone, "out", "[documento Excel]");
      } else {
        await patch(s.id, { answers, status: "completed", completed_at: nowIso() });
        await say({ ...s }, area?.final_message || "¡Gracias por tus respuestas! Te contactamos pronto.");
      }
    }
    return;
  }

  // 3) Esperando el Excel resuelto.
  if (s.status === "awaiting_excel" && msg.documentId) {
    const area = await areaById(s.area);
    try {
      const media = await downloadMedia(msg.documentId);
      await patch(s.id, {
        excel_path: `${s.id}/${media.filename}`,
        excel_detail: {
          mediaId: msg.documentId,
          filename: media.filename,
          bytes: media.buffer.length,
        },
        status: "completed",
        completed_at: nowIso(),
      });
      await say({ ...s }, area?.final_message || "¡Recibido! Gracias, te contactamos pronto. 👍");
    } catch {
      await say(s, "No pude recibir el archivo, ¿lo reenviás como documento de Excel?");
    }
    return;
  }

  if (msg.text) {
    await say(s, "Gracias por tu mensaje. Seguí las indicaciones que te enviamos para continuar.");
  }
}

/** Crea una sesión y manda el primer mensaje (plantilla con el selector de área). */
export async function startSession(opts: {
  candidateId: string;
  searchId: string;
  phone: string;
  templateName?: string;
  params?: string[];
}): Promise<string> {
  // Área por defecto según la búsqueda (el candidato igual la confirma con el selector).
  let defaultArea: string | null = null;
  if (opts.searchId) {
    const { data } = await supabaseAdmin()
      .from("searches")
      .select("bot_area")
      .eq("id", opts.searchId)
      .maybeSingle();
    defaultArea = (data as { bot_area?: string } | null)?.bot_area || null;
  }
  const id = `${opts.candidateId}-${Date.now()}`;
  await supabaseAdmin().from("bot_sessions").insert({
    id,
    candidate_id: opts.candidateId,
    search_id: opts.searchId || null,
    phone: opts.phone,
    status: "pending",
    current_index: 0,
    area: defaultArea,
    answers: [],
  });
  const tpl = opts.templateName || process.env.RECRUIT_WA_TEMPLATE;
  if (tpl) {
    await sendTemplate(opts.phone, tpl, "es_AR", opts.params || []);
    await logMsg(id, opts.phone, "out", `[plantilla ${tpl}]`);
  }
  return id;
}
