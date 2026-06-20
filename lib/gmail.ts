// Lee los mails de postulación de ZonaJobs desde Gmail por IMAP.
// Requiere GMAIL_USER + GMAIL_APP_PASSWORD (contraseña de aplicación de Google).

import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import type { Readable } from "node:stream";
import { parseJobTitle } from "./zonajobs";

export interface RawApplicationEmail {
  uid: number;
  subject: string;
  text: string;
  date: string;
}

// Nodo de la estructura MIME del mail (lo justo para encontrar la parte de texto).
type BodyNode = {
  type?: string;
  part?: string;
  parameters?: { charset?: string };
  childNodes?: BodyNode[];
};

// Busca la parte de texto del mail (preferimos HTML) sin tocar las imágenes.
// Devuelve el identificador de parte IMAP y su charset.
function pickTextPart(node?: BodyNode): { part: string; charset?: string } | null {
  let html: { part: string; charset?: string } | null = null;
  let plain: { part: string; charset?: string } | null = null;
  const walk = (n?: BodyNode) => {
    if (!n) return;
    const type = (n.type || "").toLowerCase();
    if (type === "text/html" && !html) html = { part: n.part || "1", charset: n.parameters?.charset };
    else if (type === "text/plain" && !plain)
      plain = { part: n.part || "1", charset: n.parameters?.charset };
    (n.childNodes || []).forEach(walk);
  };
  walk(node);
  return html || plain;
}

async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  }
  return Buffer.concat(chunks);
}

function decodeBuffer(buf: Buffer, charset?: string): string {
  const cs = (charset || "utf-8").toLowerCase();
  // Buffer soporta latin1; mapeamos los charsets viejos más comunes ahí.
  if (cs.includes("8859") || cs.includes("1252") || cs === "latin1") return buf.toString("latin1");
  return buf.toString("utf8");
}

// Los mails de ZonaJobs vienen en HTML; si no hay texto plano, lo derivamos del HTML
// preservando los saltos de línea para que el parser pueda leer el CV.
function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6]|td|table)\s*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;| /gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

const ZONAJOBS_SENDER = "no_reply@zonajobs.com.ar";

function imapClient(): ImapFlow {
  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;
  if (!user || !pass) {
    throw new Error("Faltan GMAIL_USER o GMAIL_APP_PASSWORD en el servidor.");
  }
  return new ImapFlow({ host: "imap.gmail.com", port: 993, secure: true, auth: { user, pass }, logger: false });
}

export interface AvisoSummary {
  /** Nombre del aviso/búsqueda (del asunto). */
  title: string;
  /** Cantidad de CVs (mails) de ese aviso en el rango. */
  count: number;
  /** UIDs de los mails de ese aviso (para importarlos después). */
  uids: number[];
  /** Fecha del primer CV (mail más viejo) de ese aviso, ISO. */
  firstDate: string;
}

/**
 * Escaneo LIVIANO: lista los avisos de ZonaJobs en los últimos `months` meses
 * (máx. 4) leyendo solo los ASUNTOS (sin bajar cuerpos ni fotos). Devuelve cada
 * aviso con su cantidad de CVs. Es rápido aunque haya miles de mails.
 */
export async function scanZonaJobsAvisos(months = 4): Promise<AvisoSummary[]> {
  const m = Math.min(4, Math.max(1, Math.round(months) || 4));
  const since = new Date(Date.now() - m * 31 * 24 * 60 * 60 * 1000);
  const client = imapClient();
  const groups = new Map<string, { uids: number[]; firstDate: number }>();
  await client.connect();
  const lock = await client.getMailboxLock("INBOX");
  try {
    const uids = await client.search({ from: ZONAJOBS_SENDER, since }, { uid: true });
    if (uids && uids.length) {
      for await (const msg of client.fetch(uids, { envelope: true }, { uid: true })) {
        const title = parseJobTitle(msg.envelope?.subject || "", "") || "(sin título en el asunto)";
        const t = (msg.envelope?.date || new Date()).getTime();
        const g = groups.get(title) || { uids: [], firstDate: t };
        g.uids.push(msg.uid);
        if (t < g.firstDate) g.firstDate = t;
        groups.set(title, g);
      }
    }
  } finally {
    lock.release();
    await client.logout().catch(() => {});
  }
  return [...groups.entries()]
    .map(([title, g]) => ({
      title,
      count: g.uids.length,
      uids: g.uids,
      firstDate: new Date(g.firstDate).toISOString(),
    }))
    .sort((a, b) => b.count - a.count);
}

/**
 * Importa SOLO los mails indicados (los de un aviso elegido), bajando únicamente
 * la parte de texto de cada uno (sin fotos). Al estar acotado a un aviso, es
 * rápido y no se cae por timeout.
 */
export async function fetchZonaJobsEmailsByUids(uids: number[]): Promise<RawApplicationEmail[]> {
  if (!uids.length) return [];
  const client = imapClient();
  const out: RawApplicationEmail[] = [];
  await client.connect();
  const lock = await client.getMailboxLock("INBOX");
  try {
    // 1ª pasada (liviana): metadatos + estructura, SIN bajar cuerpos ni fotos.
    const metas: {
      uid: number;
      subject: string;
      date: string;
      textPart: { part: string; charset?: string } | null;
    }[] = [];
    for await (const msg of client.fetch(uids, { bodyStructure: true, envelope: true }, { uid: true })) {
      metas.push({
        uid: msg.uid,
        subject: msg.envelope?.subject || "",
        date: (msg.envelope?.date || new Date()).toISOString(),
        textPart: pickTextPart(msg.bodyStructure as BodyNode | undefined),
      });
    }

    // 2ª pasada: bajamos SOLO la parte de texto de cada mail (la foto queda en
    // el servidor; se baja recién al abrir "Ver CV completo").
    for (const meta of metas) {
      let bodyText = "";
      try {
        if (meta.textPart) {
          const dl = await client.download(String(meta.uid), meta.textPart.part, { uid: true });
          if (dl?.content) {
            const raw = decodeBuffer(await streamToBuffer(dl.content), meta.textPart.charset);
            bodyText = /<[a-z!/]/i.test(raw) ? htmlToText(raw) : raw.trim();
          }
        }
      } catch {
        bodyText = "";
      }
      // Respaldo: si no pudimos sacar el texto, bajamos el mail completo.
      if (!bodyText) {
        try {
          const dl = await client.download(String(meta.uid), undefined, { uid: true });
          if (dl?.content) {
            const parsed = await simpleParser(await streamToBuffer(dl.content));
            const plain = (parsed.text || "").trim();
            bodyText = plain.length > 20 ? plain : htmlToText(parsed.html || "");
          }
        } catch {
          /* saltar mail que no se pudo leer */
        }
      }
      out.push({ uid: meta.uid, subject: meta.subject, text: bodyText, date: meta.date });
    }
  } finally {
    lock.release();
    await client.logout().catch(() => {});
  }
  return out.reverse();
}

// Trae el HTML original de un mail puntual (por uid), con las imágenes embebidas
// (cid) convertidas a data URI para que la foto del candidato se vea.
export async function fetchEmailHtml(uid: number): Promise<string> {
  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;
  if (!user || !pass) throw new Error("Faltan GMAIL_USER o GMAIL_APP_PASSWORD en el servidor.");

  const client = new ImapFlow({
    host: "imap.gmail.com",
    port: 993,
    secure: true,
    auth: { user, pass },
    logger: false,
  });

  let html = "";
  await client.connect();
  const lock = await client.getMailboxLock("INBOX");
  try {
    for await (const msg of client.fetch([uid], { source: true }, { uid: true })) {
      if (!msg.source) continue;
      const parsed = await simpleParser(msg.source as Buffer);
      html = parsed.html || parsed.textAsHtml || "";
      for (const att of parsed.attachments || []) {
        if (att.cid && att.content) {
          const dataUri = `data:${att.contentType};base64,${(att.content as Buffer).toString("base64")}`;
          html = html.split(`cid:${att.cid}`).join(dataUri);
        }
      }
      break;
    }
  } finally {
    lock.release();
    await client.logout().catch(() => {});
  }
  return html;
}
