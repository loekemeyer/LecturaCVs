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

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return bad("Petición inválida.");
  }

  const to = String(form.get("to") ?? "").trim();
  const subject = String(form.get("subject") ?? "").trim();
  const text = String(form.get("body") ?? "");
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) return bad("El mail del destinatario no es válido.");
  if (!text.trim()) return bad("El mensaje está vacío.");

  // Adjuntos (ej. el Excel de la prueba). Tope ~20 MB en total (límite de Gmail 25).
  const files = form.getAll("file").filter((f): f is File => f instanceof File && f.size > 0);
  const totalBytes = files.reduce((n, f) => n + f.size, 0);
  if (totalBytes > 20 * 1024 * 1024) {
    return bad("Los adjuntos superan los 20 MB. Mandá archivos más livianos.");
  }
  const attachments = await Promise.all(
    files.map(async (f) => ({ filename: f.name, content: Buffer.from(await f.arrayBuffer()) })),
  );

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
      attachments,
    });
    return Response.json({ ok: true });
  } catch (err) {
    console.error("Error al enviar mail:", err);
    const msg = err instanceof Error ? err.message : "No se pudo enviar el mail.";
    return bad(msg, 502);
  }
}
