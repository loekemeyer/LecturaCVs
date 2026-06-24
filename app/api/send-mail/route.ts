// Envía un mail desde la cuenta de reclutamiento (MAIL_USER) por SMTP de Gmail.
// Cuenta aparte de la que lee los CVs. Lo dispara el botón "Enviar mail" del tablero.
import nodemailer from "nodemailer";
import { isAuthorized, unauthorized } from "@/lib/auth";

export const runtime = "nodejs";
export const maxDuration = 30;

function bad(error: string, status = 400) {
  return Response.json({ error }, { status });
}

export async function POST(req: Request) {
  if (!isAuthorized(req)) return unauthorized();

  const user = process.env.MAIL_USER;
  const pass = (process.env.MAIL_APP_PASSWORD || "").replace(/\s+/g, "");
  if (!user || !pass) {
    return bad(
      "El servidor no tiene configurado el correo de envío (MAIL_USER / MAIL_APP_PASSWORD).",
      500,
    );
  }

  let body: { to?: unknown; subject?: unknown; body?: unknown };
  try {
    body = await req.json();
  } catch {
    return bad("Petición inválida.");
  }

  const to = String(body?.to ?? "").trim();
  const subject = String(body?.subject ?? "").trim();
  const text = String(body?.body ?? "");
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) return bad("El mail del destinatario no es válido.");
  if (!text.trim()) return bad("El mensaje está vacío.");

  try {
    const transport = nodemailer.createTransport({
      host: "smtp.gmail.com",
      port: 465,
      secure: true,
      auth: { user, pass },
    });
    await transport.sendMail({
      from: `Reclutamiento <${user}>`,
      to,
      subject: subject || "(sin asunto)",
      text,
    });
    return Response.json({ ok: true });
  } catch (err) {
    console.error("Error al enviar mail:", err);
    const msg = err instanceof Error ? err.message : "No se pudo enviar el mail.";
    return bad(msg, 502);
  }
}
