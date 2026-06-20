// Acceso por código de 6 dígitos enviado por correo (OTP), sin estado en el
// servidor (sirve para Vercel, donde no hay memoria compartida entre llamadas).
//
// Flujo:
//  1) El front pide un código -> el server genera 6 dígitos, los manda por mail
//     y devuelve un "challenge" firmado (NO revela el código).
//  2) El usuario ingresa el código -> el server recomputa la firma; si coincide
//     y no venció, emite un token de sesión firmado.
//  3) Cada llamada a la API manda ese token en el header "x-app-token".
//
// El secreto de firma sale de AUTH_SECRET (o, si no está, de GMAIL_APP_PASSWORD).
// El candado se activa solo si hay credenciales de correo (para poder mandar el
// código). Sin ellas, las rutas quedan abiertas (compatibilidad).

import crypto from "node:crypto";

const CODE_TTL_MS = 10 * 60 * 1000; // el código vence en 10 minutos
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // la sesión dura 30 días

function secret(): string {
  return process.env.AUTH_SECRET || process.env.GMAIL_APP_PASSWORD || "";
}

/** El candado se activa cuando se puede mandar el código (hay correo configurado). */
export function authRequired(): boolean {
  return !!(process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD);
}

/** A dónde se manda el código de acceso (fijo; se puede sobreescribir con AUTH_EMAIL). */
export function authEmail(): string {
  return process.env.AUTH_EMAIL || "loekemeyer.n8n@gmail.com";
}

function hmac(data: string): string {
  return crypto.createHmac("sha256", secret()).update(data).digest("hex");
}

function timingEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

/** Genera un código de 6 dígitos + el challenge firmado (no revela el código). */
export function makeCodeChallenge(): { code: string; challenge: string } {
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
  const exp = Date.now() + CODE_TTL_MS;
  const sig = hmac(`code:${code}:${exp}`);
  return { code, challenge: `${exp}.${sig}` };
}

export function verifyCode(code: string, challenge: string): boolean {
  if (!secret()) return false;
  const [expStr, sig] = String(challenge || "").split(".");
  const exp = Number(expStr);
  if (!exp || Date.now() > exp) return false;
  const expected = hmac(`code:${String(code || "").trim()}:${exp}`);
  return timingEqual(sig || "", expected);
}

export function issueSessionToken(): string {
  const exp = Date.now() + SESSION_TTL_MS;
  return `${exp}.${hmac(`session:${exp}`)}`;
}

export function verifySessionToken(token: string): boolean {
  if (!secret()) return true;
  const [expStr, sig] = String(token || "").split(".");
  const exp = Number(expStr);
  if (!exp || Date.now() > exp) return false;
  return timingEqual(sig || "", hmac(`session:${exp}`));
}

/** ¿La petición está autorizada (o no hace falta candado)? */
export function isAuthorized(req: Request): boolean {
  if (!authRequired()) return true;
  return verifySessionToken(req.headers.get("x-app-token") || "");
}

export function unauthorized(): Response {
  return Response.json(
    { error: "No autorizado. Pedí un nuevo código de acceso." },
    { status: 401 },
  );
}

// --- Estimación de costo por CV (para el contador de gasto en vivo) ---
// Asume ~3500 tokens de entrada y ~900 de salida por CV (aproximado).
const PRICING: Record<string, { in: number; out: number }> = {
  "claude-haiku-4-5": { in: 1, out: 5 },
  "claude-sonnet-4-6": { in: 3, out: 15 },
  "claude-opus-4-8": { in: 5, out: 25 },
  "claude-opus-4-7": { in: 5, out: 25 },
  "claude-opus-4-6": { in: 5, out: 25 },
  "claude-fable-5": { in: 10, out: 50 },
};

export function estimatedCostPerCvUsd(): number {
  const model = process.env.ANTHROPIC_MODEL || "claude-opus-4-8";
  const key = Object.keys(PRICING).find((k) => model.startsWith(k));
  const price = (key && PRICING[key]) || { in: 5, out: 25 };
  return (3500 / 1e6) * price.in + (900 / 1e6) * price.out;
}
