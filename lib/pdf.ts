// Extrae el texto real de un PDF (sin mandarlo como imagen a la IA).
// Para PDFs con texto seleccionable es más barato y preciso que enviar las
// páginas como imagen. Si el PDF es escaneado (sin texto), devuelve "" y el
// que llama vuelve a mandar el archivo como documento/imagen.

import { extractText, getDocumentProxy } from "unpdf";

export async function extractPdfText(buf: Buffer): Promise<string> {
  try {
    const pdf = await getDocumentProxy(new Uint8Array(buf));
    const { text } = await extractText(pdf, { mergePages: true });
    const joined = Array.isArray(text) ? text.join("\n") : String(text || "");
    return joined.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  } catch {
    return "";
  }
}
