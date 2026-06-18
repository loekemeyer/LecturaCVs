// Lee los mails de postulación de ZonaJobs desde Gmail por IMAP.
// Requiere GMAIL_USER + GMAIL_APP_PASSWORD (contraseña de aplicación de Google).

import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";

export interface RawApplicationEmail {
  uid: number;
  subject: string;
  text: string;
  date: string;
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

export async function fetchZonaJobsEmails(limit = 50): Promise<RawApplicationEmail[]> {
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
    const since = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000); // últimos 90 días
    const uids = await client.search({ from: ZONAJOBS_SENDER, since }, { uid: true });
    if (uids && uids.length) {
      const recent = uids.slice(-limit);
      for await (const msg of client.fetch(
        recent,
        { source: true, envelope: true },
        { uid: true },
      )) {
        if (!msg.source) continue;
        try {
          const parsed = await simpleParser(msg.source as Buffer);
          const plain = (parsed.text || "").trim();
          const bodyText = plain.length > 20 ? plain : htmlToText(parsed.html || "");
          out.push({
            uid: msg.uid,
            subject: parsed.subject || msg.envelope?.subject || "",
            text: bodyText,
            date: (parsed.date || msg.envelope?.date || new Date()).toISOString(),
          });
        } catch {
          /* saltar mail que no se pudo parsear */
        }
      }
    }
  } finally {
    lock.release();
    await client.logout().catch(() => {});
  }

  return out.reverse(); // más nuevos primero
}
