// Separa un PDF que contiene varios CVs (con un "Índice" en la página 1) en el
// TEXTO de cada CV. Devuelve [{name, text}] (o {single:true, text} si es un solo CV).
// Los candidatos quedan PENDIENTES; se evalúan después con "Evaluar candidatos".
// Usa `unpdf` (compatible con serverless). Import dinámico + try/catch: nunca 500.
import { isAuthorized, unauthorized } from "@/lib/auth";

export const runtime = "nodejs";
export const maxDuration = 60;

interface Entry {
  name: string;
  page: number;
}

function parseIndex(text: string): Entry[] {
  const i = text.indexOf("Índice");
  let body = i >= 0 ? text.slice(i + "Índice".length) : text;
  const cut = body.search(/Fecha:|CVs incluidos/i);
  if (cut >= 0) body = body.slice(0, cut);
  const re = /(.+?)\s+pág\.\s*(\d+)/g;
  const out: Entry[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    const name = m[1].replace(/\s+/g, " ").trim();
    const page = parseInt(m[2], 10);
    if (name && page > 0) out.push({ name, page });
  }
  return out;
}

export async function POST(req: Request) {
  if (!isAuthorized(req)) return unauthorized();
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return Response.json({ error: "Petición inválida." }, { status: 400 });
  }
  const file = form.get("file");
  if (!(file instanceof File)) return Response.json({ error: "Falta el archivo." }, { status: 400 });
  const ab = await file.arrayBuffer();

  try {
    const { getDocumentProxy, extractText } = await import("unpdf");
    const pdf = await getDocumentProxy(new Uint8Array(ab));
    const numPages = pdf.numPages as number;
    const extracted = await extractText(pdf, { mergePages: false });
    const pages = (
      Array.isArray(extracted.text) ? extracted.text : [String(extracted.text)]
    ) as string[];

    const indexText = (pages[0] || "").replace(/\s+/g, " ").trim();
    const entries = parseIndex(indexText);

    // No es un paquete con índice → un solo CV (devolvemos su texto completo).
    if (entries.length < 2) {
      const whole = pages.join("\n\n").trim();
      return Response.json({ single: true, text: whole });
    }

    const cvs: { name: string; text: string }[] = [];
    for (let k = 0; k < entries.length; k++) {
      const start = entries[k].page; // 1-indexed
      const end = k + 1 < entries.length ? entries[k + 1].page - 1 : numPages;
      if (start < 1 || end < start) continue;
      const text = pages.slice(start - 1, Math.min(end, numPages)).join("\n\n").trim();
      cvs.push({ name: entries[k].name, text });
    }
    return Response.json({ single: false, count: cvs.length, cvs });
  } catch (err) {
    console.error("Error al separar el PDF:", err);
    return Response.json({ single: true, text: "" });
  }
}
