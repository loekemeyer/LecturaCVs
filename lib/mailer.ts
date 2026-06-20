// Envío de correo por SMTP de Gmail (usa las mismas credenciales que la lectura
// de mails: GMAIL_USER + GMAIL_APP_PASSWORD).

import nodemailer from "nodemailer";

export async function sendAccessCode(to: string, code: string): Promise<void> {
  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;
  if (!user || !pass) throw new Error("Correo no configurado en el servidor.");

  const transporter = nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
    auth: { user, pass },
  });

  await transporter.sendMail({
    from: `LecturaCVs <${user}>`,
    to,
    subject: `Código de acceso a LecturaCVs: ${code}`,
    text: `Tu código de acceso a LecturaCVs es: ${code}\n\nVence en 10 minutos. Si no lo pediste, ignorá este correo.`,
    html: `<div style="font-family:system-ui,Arial,sans-serif;max-width:420px">
      <p>Tu código de acceso a <strong>LecturaCVs</strong> es:</p>
      <p style="font-size:30px;font-weight:800;letter-spacing:6px;color:#1d4ed8;margin:12px 0">${code}</p>
      <p style="color:#555;font-size:13px">Vence en 10 minutos. Si no lo pediste, ignorá este correo.</p>
    </div>`,
  });
}
