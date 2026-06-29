// Separa un PDF que contiene varios CVs (con un "Índice" en la página 1, como el
// exportado de candidatos) en un PDF por candidato. Devuelve [{name, base64}].
import { isAuthorized, unauthorized } from "@/lib/auth";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { PDFDocument } from "pdf-lib";

export const runtime = "nodejs";
export const maxDuration = 60;

interface Entry {
  name: string;
  page: number;
}

// Parsea el índice: "Apellido, Nombre pág. N" para cada candidato.
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
  // Copias independientes: pdfjs "consume" (detacha) su buffer, así que pdf-lib
  // necesita el suyo aparte.
  const ab = await file.arrayBuffer();

  try {
    // 1) Texto de la página 1 (índice).
    const doc = await getDocument({ data: new Uint8Array(ab.slice(0)), useSystemFonts: true }).promise;
    const numPages = doc.numPages;
    const page1 = await doc.getPage(1);
    const tc = await page1.getTextContent();
    const text = (tc.items as { str?: string }[])
      .map((it) => it.str || "")
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
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
    // Si algo falla, que el front lo trate como un solo CV.
    return Response.json({ single: true });
  }
}
