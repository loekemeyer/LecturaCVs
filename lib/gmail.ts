// Lee los mails de postulación de ZonaJobs desde Gmail por IMAP.
// Requiere GMAIL_USER + GMAIL_APP_PASSWORD (contraseña de aplicación de Google).

import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import type { Readable } from "node:stream";

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

export async function fetchZonaJobsEmails(): Promise<RawApplicationEmail[]> {
  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;
  if (!user || !pass) {
    throw new Error("Faltan GMAIL_USER o GMAIL_APP_PASSWORD en el servidor.");
  }

  const client = new ImapFlow({
    host: "imap.gmail.com",
    port: 993,
    secure: true,
    auth: { user, pass },
    logger: false,
  });

  const out: RawApplicationEmail[] = [];
  await client.connect();
  const lock = await client.getMailboxLock("INBOX");
  try {
    // Sin ventana de tiempo ni tope: traemos TODOS los mails de ZonaJobs. El
    // límite de cuántos CVs analizar se aplica después, en la app.
    const uids = await client.search({ from: ZONAJOBS_SENDER }, { uid: true });
    if (uids && uids.length) {
      // 1ª pasada (liviana): solo metadatos + estructura, SIN bajar cuerpos ni fotos.
      const metas: {
        uid: number;
        subject: string;
        date: string;
        textPart: { part: string; charset?: string } | null;
      }[] = [];
      for await (const msg of client.fetch(
        uids,
        { bodyStructure: true, envelope: true },
        { uid: true },
      )) {
        metas.push({
          uid: msg.uid,
          subject: msg.envelope?.subject || "",
          date: (msg.envelope?.date || new Date()).toISOString(),
          textPart: pickTextPart(msg.bodyStructure as BodyNode | undefined),
        });
      }

      // 2ª pasada: bajamos SOLO la parte de texto de cada mail (la foto del
      // candidato queda en el servidor; se baja recién al abrir "Ver CV completo").
      for (const m of metas) {
        let bodyText = "";
        try {
          if (m.textPart) {
            const dl = await client.download(String(m.uid), m.textPart.part, { uid: true });
            if (dl?.content) {
              const raw = decodeBuffer(await streamToBuffer(dl.content), m.textPart.charset);
              bodyText = /<[a-z!/]/i.test(raw) ? htmlToText(raw) : raw.trim();
            }
          }
        } catch {
          bodyText = "";
        }
        // Respaldo: si no pudimos sacar el texto, bajamos el mail completo y lo
        // parseamos como antes (solo para ese mail puntual).
        if (!bodyText) {
          try {
            const dl = await client.download(String(m.uid), undefined, { uid: true });
            if (dl?.content) {
              const parsed = await simpleParser(await streamToBuffer(dl.content));
              const plain = (parsed.text || "").trim();
              bodyText = plain.length > 20 ? plain : htmlToText(parsed.html || "");
            }
          } catch {
            /* saltar mail que no se pudo leer */
          }
        }
        out.push({ uid: m.uid, subject: m.subject, text: bodyText, date: m.date });
      }
    }
  } finally {
    lock.release();
    await client.logout().catch(() => {});
  }

  return out.reverse(); // más nuevos primero
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
