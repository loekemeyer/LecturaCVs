// Motor del bot de reclutamiento por WhatsApp.
// Flujo: 1er mensaje (plantilla) = saludo con nombre + aviso + la 1ª pregunta (los
// minutos de viaje a la oficina). El candidato responde → seguimos con las preguntas
// del PUESTO (según la búsqueda, tabla bot_areas) → puntuamos las respuestas con los
// criterios del puesto → mandamos el Excel y, al recibirlo resuelto, el mensaje final.
// Las preguntas del puesto se editan en la app.
import { supabaseAdmin } from "./supabase";
import { sendText, sendTemplate, uploadMedia, sendDocumentById, downloadMedia } from "./whatsapp";
import { scoreExcel } from "./excel-score";
import { scoreAnswers } from "./answers-score";

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

// Dirección de la oficina (la 1ª pregunta de la plantilla pregunta el viaje hasta acá).
const OFFICE = process.env.PLANT_ADDRESS || "Cervantes 2868, CABA";
const TRAVEL_Q = `Minutos de viaje hasta ${OFFICE}`;

// Baja el Excel de la prueba desde Supabase Storage (bucket privado, no público).
async function fetchExcelBuffer(): Promise<{ buffer: Buffer; filename: string; mime: string } | null> {
  const bucket = process.env.RECRUIT_EXCEL_BUCKET || "bot-assets";
  const path = process.env.RECRUIT_EXCEL_PATH || "prueba-excel-3.xlsx";
  try {
    const { data, error } = await supabaseAdmin().storage.from(bucket).download(path);
    if (error || !data) return null;
    return { buffer: Buffer.from(await data.arrayBuffer()), filename: "Prueba Excel.xlsx", mime: XLSX_MIME };
  } catch {
    return null;
  }
}

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

interface Answer {
  q: string;
  a: string;
  at: string;
}

interface SessionRow {
  id: string;
  candidate_id: string;
  search_id: string | null;
  phone: string;
  status: string;
  current_index: number;
  area: string | null;
  answers: Answer[];
}

const nowIso = () => new Date().toISOString();

// Variantes del número argentino con y sin el "9" (54 9 11… ↔ 54 11…), porque
// WhatsApp a veces entrega el "from" sin el 9 aunque la sesión se haya creado con él.
function phoneVariants(phone: string): string[] {
  const set = new Set<string>([phone]);
  if (phone.startsWith("549")) set.add("54" + phone.slice(3));
  else if (phone.startsWith("54")) set.add("549" + phone.slice(2));
  return [...set];
}

async function activeSession(phone: string): Promise<SessionRow | null> {
  const { data } = await supabaseAdmin()
    .from("bot_sessions")
    .select("*")
    .in("phone", phoneVariants(phone))
    .in("status", ["awaiting_travel", "in_progress", "awaiting_excel"])
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

// Primer nombre para el saludo: "Apellido, Nombre" o "Nombre Apellido" → "Nombre".
function firstName(full: string): string {
  const s = (full || "").trim();
  if (!s) return "";
  const base = s.includes(",") ? (s.split(",")[1] || "").trim() : s;
  return (base.split(/\s+/)[0] || s).trim();
}

export interface InboundMsg {
  from: string;
  text?: string;
  documentId?: string;
  documentName?: string;
}

// Autorespuesta para quien escribe al número sin una evaluación activa.
// Editable por variable de entorno; si no, usa este texto por defecto.
const AUTO_REPLY =
  process.env.RECRUIT_AUTO_REPLY ||
  `Hola!
Soy el Asistente Virtual de Loekemeyer Srl
Si deseas postularte, o saber el estado de tu postulación
Escribe al siguiente mail: rrhhloeke@gmail.com`;

// Cierra el tramo de preguntas: puntúa las respuestas con los criterios del puesto,
// y manda el Excel (o el mensaje final si no hay Excel disponible).
async function finishQuestions(s: SessionRow, answers: Answer[], area: AreaRow | null) {
  let ansScore: number | null = null;
  try {
    let criteria: unknown = [];
    let title = area?.label || "";
    if (s.search_id) {
      const { data } = await supabaseAdmin()
        .from("searches")
        .select("criteria, title")
        .eq("id", s.search_id)
        .maybeSingle();
      criteria = (data as { criteria?: unknown } | null)?.criteria ?? [];
      title = (data as { title?: string } | null)?.title || title;
    }
    ansScore = await scoreAnswers(answers, criteria, title);
  } catch (err) {
    console.error("No se pudo puntuar las respuestas:", err);
  }

  const ex = await fetchExcelBuffer();
  if (ex) {
    await patch(s.id, { answers, score: ansScore, status: "awaiting_excel" });
    const cap = area?.excel_message || "Para terminar, resolvé esta prueba de Excel y reenviá el archivo resuelto por este chat.";
    try {
      const mediaId = await uploadMedia(ex.buffer, ex.filename, ex.mime);
      await sendDocumentById(s.phone, mediaId, ex.filename, cap);
      await logMsg(s.id, s.phone, "out", "[documento Excel]");
    } catch (err) {
      console.error("No se pudo enviar el Excel:", err);
      await say({ ...s }, cap);
    }
  } else {
    await patch(s.id, { answers, score: ansScore, status: "completed", completed_at: nowIso() });
    await say({ ...s }, area?.final_message || "¡Gracias por tus respuestas! Te contactamos pronto.");
  }
}

export async function handleInbound(msg: InboundMsg): Promise<void> {
  const phone = msg.from;
  let s: SessionRow | null = null;
  try {
    s = await activeSession(phone);
  } catch {
    s = null;
  }
  if (!s) {
    // Sin evaluación activa: enviamos la autorespuesta (redirige al mail).
    try {
      await sendText(phone, AUTO_REPLY);
    } catch (err) {
      console.error("No se pudo enviar la autorespuesta:", err);
    }
    return;
  }
  await logMsg(
    s.id,
    phone,
    "in",
    msg.text || (msg.documentId ? `[documento ${msg.documentName || ""}]` : "[mensaje]"),
  );

  // 1) Respuesta a la 1ª pregunta (la de la plantilla: minutos de viaje).
  if (s.status === "awaiting_travel" && msg.text) {
    const answers = Array.isArray(s.answers) ? s.answers : [];
    answers.push({ q: TRAVEL_Q, a: msg.text, at: nowIso() });
    const area = await areaById(s.area);
    const qs = area?.questions ?? [];
    if (qs.length > 0) {
      await patch(s.id, { answers, status: "in_progress", current_index: 0 });
      await say({ ...s }, qs[0].q);
    } else {
      await finishQuestions(s, answers, area);
    }
    return;
  }

  // 2) Preguntas del puesto: guardamos la respuesta y avanzamos.
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
      await finishQuestions(s, answers, area);
    }
    return;
  }

  // 3) Esperando el Excel resuelto.
  if (s.status === "awaiting_excel" && msg.documentId) {
    const area = await areaById(s.area);
    try {
      const media = await downloadMedia(msg.documentId);
      let excelScore: number | null = null;
      let detail: Record<string, unknown> = {
        mediaId: msg.documentId,
        filename: media.filename,
        bytes: media.buffer.length,
      };
      // Corrección automática del Excel (no debe frenar el flujo si falla).
      try {
        const r = await scoreExcel(media.buffer);
        excelScore = r.total;
        detail = { ...detail, total: r.total, max: r.max, dimensions: r.dimensions, summary: r.summary, manualReview: r.manualReview };
      } catch (err) {
        console.error("Error al puntuar el Excel:", err);
        detail = { ...detail, error: "no se pudo puntuar automáticamente" };
      }
      await patch(s.id, {
        excel_path: `${s.id}/${media.filename}`,
        excel_score: excelScore,
        excel_detail: detail,
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

/**
 * Crea una sesión y manda el primer mensaje (plantilla: saludo con nombre + aviso +
 * la 1ª pregunta). El área (puesto) sale de la búsqueda; no hay menú.
 */
export async function startSession(opts: {
  candidateId: string;
  searchId: string;
  phone: string;
  templateName?: string;
  params?: string[];
}): Promise<string> {
  // Área (puesto) y nombre del aviso, según la búsqueda.
  let area: string | null = null;
  let aviso = "";
  if (opts.searchId) {
    const { data } = await supabaseAdmin()
      .from("searches")
      .select("bot_area, title")
      .eq("id", opts.searchId)
      .maybeSingle();
    area = (data as { bot_area?: string } | null)?.bot_area || null;
    aviso = (data as { title?: string } | null)?.title || "";
  }
  // Nombre del candidato (para el saludo).
  let candName = "";
  if (opts.candidateId) {
    const { data } = await supabaseAdmin()
      .from("candidates")
      .select("name")
      .eq("id", opts.candidateId)
      .maybeSingle();
    candName = (data as { name?: string } | null)?.name || "";
  }

  const id = `${opts.candidateId}-${Date.now()}`;
  await supabaseAdmin().from("bot_sessions").insert({
    id,
    candidate_id: opts.candidateId,
    search_id: opts.searchId || null,
    phone: opts.phone,
    status: "awaiting_travel",
    current_index: 0,
    area,
    answers: [],
  });

  const tpl = opts.templateName || process.env.RECRUIT_WA_TEMPLATE;
  if (tpl) {
    // {{1}} = nombre del candidato, {{2}} = nombre del aviso. Sin vacíos (WhatsApp los rechaza).
    const params =
      opts.params && opts.params.length
        ? opts.params
        : [firstName(candName) || "candidato/a", aviso || "nuestra búsqueda"];
    await sendTemplate(opts.phone, tpl, "es_AR", params);
    await logMsg(id, opts.phone, "out", `[plantilla ${tpl}]`);
  }
  return id;
}
