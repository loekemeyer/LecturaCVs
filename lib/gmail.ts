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
          out.push({
            uid: msg.uid,
            subject: parsed.subject || msg.envelope?.subject || "",
            text: parsed.text || "",
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
