// Separa un PDF que contiene varios CVs (con un "Índice" en la página 1, como el
// exportado de candidatos) en un PDF por candidato. Devuelve [{name, base64}].
// Usa `unpdf` (pensado para serverless) para el texto y `pdf-lib` para cortar.
// Imports dinámicos + try/catch: si algo falla, devuelve {single:true} (nunca 500).
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
    const { PDFDocument } = await import("pdf-lib");

    // 1) Texto de la página 1 (índice).
    const pdf = await getDocumentProxy(new Uint8Array(ab.slice(0)));
    const numPages = pdf.numPages as number;
    const extracted = await extractText(pdf, { mergePages: false });
    const pages = (Array.isArray(extracted.text) ? extracted.text : [String(extracted.text)]) as string[];
    const text = (pages[0] || "").replace(/\s+/g, " ").trim();
    const entries = parseIndex(text);
    if (entries.length < 2) return Response.json({ single: true });

    // 2) Un PDF por candidato (desde su página de inicio hasta antes del siguiente).
    const src = await PDFDocument.load(new Uint8Array(ab.slice(0)));
    const cvs: { name: string; base64: string }[] = [];
    for (let k = 0; k < entries.length; k++) {
      const start = entries[k].page; // 1-indexed
      const end = k + 1 < entries.length ? entries[k + 1].page - 1 : numPages;
      if (start < 1 || end < start || start > numPages) continue;
      const indices: number[] = [];
      for (let p = start; p <= Math.min(end, numPages); p++) indices.push(p - 1);
      const out = await PDFDocument.create();
      const copied = await out.copyPages(src, indices);
      copied.forEach((pg) => out.addPage(pg));
      const saved = await out.save();
      cvs.push({ name: entries[k].name, base64: Buffer.from(saved).toString("base64") });
    }
    return Response.json({ single: false, count: cvs.length, cvs });
  } catch (err) {
    console.error("Error al separar el PDF:", err);
    return Response.json({ single: true });
  }
}
