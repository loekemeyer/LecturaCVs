import {
  authRequired,
  authEmail,
  estimatedCostPerCvUsd,
  makeCodeChallenge,
  verifyCode,
  issueSessionToken,
  verifySessionToken,
} from "@/lib/auth";
import { sendAccessCode } from "@/lib/mailer";

export const runtime = "nodejs";
export const maxDuration = 30;

function maskEmail(e: string): string {
  const [u, d] = e.split("@");
  if (!d) return e;
  return `${u.slice(0, 2)}${"•".repeat(Math.max(1, u.length - 2))}@${d}`;
}

// GET: estado del candado + costo estimado por CV + validez del token actual.
export function GET(req: Request) {
  const token = req.headers.get("x-app-token") || "";
  return Response.json({
    required: authRequired(),
    costPerCv: estimatedCostPerCvUsd(),
    valid: authRequired() ? verifySessionToken(token) : true,
    email: authRequired() ? maskEmail(authEmail()) : "",
  });
}

// POST: { action: "request" } envía el código; { action: "verify", code, challenge } valida.
export async function POST(req: Request) {
  if (!authRequired()) {
    return Response.json(
      { error: "El acceso por código no está configurado en el servidor (falta el correo)." },
      { status: 500 },
    );
  }

  let body: { action?: string; code?: string; challenge?: string } = {};
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Petición inválida." }, { status: 400 });
  }

  if (body.action === "request") {
    const { code, challenge } = makeCodeChallenge();
    try {
      await sendAccessCode(authEmail(), code);
    } catch (err) {
      console.error("No se pudo enviar el código:", err);
      return Response.json({ error: "No se pudo enviar el código por correo." }, { status: 502 });
    }
    return Response.json({ challenge, sentTo: maskEmail(authEmail()) });
  }

  if (body.action === "verify") {
    if (!verifyCode(String(body.code ?? ""), String(body.challenge ?? ""))) {
      return Response.json({ error: "Código inválido o vencido." }, { status: 401 });
    }
    return Response.json({ token: issueSessionToken() });
  }

  return Response.json({ error: "Acción inválida." }, { status: 400 });
}
