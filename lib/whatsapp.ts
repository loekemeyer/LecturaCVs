// Cliente de WhatsApp Cloud API para el bot de reclutamiento (número DEDICADO,
// aparte del bot de ventas). Usa las credenciales del número de RRHH.
//   - RECRUIT_WA_PHONE_ID      → Phone Number ID del número dedicado
//   - RECRUIT_WA_TOKEN         → access token (system user) de ese número
//   - RECRUIT_WA_VERIFY_TOKEN  → token para verificar el webhook (lo elegimos)
const GRAPH = "https://graph.facebook.com/v21.0";

export function recruitWaConfigured(): boolean {
  return !!(process.env.RECRUIT_WA_PHONE_ID && process.env.RECRUIT_WA_TOKEN);
}

function creds() {
  return {
    phoneId: process.env.RECRUIT_WA_PHONE_ID || "",
    token: process.env.RECRUIT_WA_TOKEN || "",
  };
}

async function waPost(body: Record<string, unknown>) {
  const { phoneId, token } = creds();
  const res = await fetch(`${GRAPH}/${phoneId}/messages`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", ...body }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data?.error?.message || `Error de WhatsApp ${res.status}`);
  }
  return data;
}

/** Texto libre (solo válido dentro de la ventana de 24 hs). */
export function sendText(to: string, text: string) {
  return waPost({ to, type: "text", text: { body: text.slice(0, 4000) } });
}

/** Plantilla aprobada (obligatoria para el primer contacto). */
export function sendTemplate(to: string, name: string, lang = "es_AR", params: string[] = []) {
  return waPost({
    to,
    type: "template",
    template: {
      name,
      language: { code: lang },
      components: params.length
        ? [{ type: "body", parameters: params.map((p) => ({ type: "text", text: String(p) })) }]
        : [],
    },
  });
}

/** Documento por link público (ej. el Excel de la prueba). */
export function sendDocumentByLink(to: string, link: string, filename: string, caption?: string) {
  return waPost({ to, type: "document", document: { link, filename, caption } });
}

/** Sube un archivo a WhatsApp y devuelve su media id (no necesita URL pública). */
export async function uploadMedia(
  buffer: Buffer,
  filename: string,
  mimeType: string,
): Promise<string> {
  const { phoneId, token } = creds();
  const form = new FormData();
  form.append("messaging_product", "whatsapp");
  form.append("type", mimeType);
  form.append("file", new Blob([new Uint8Array(buffer)], { type: mimeType }), filename);
  const res = await fetch(`${GRAPH}/${phoneId}/media`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: form,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.id) {
    throw new Error(data?.error?.message || `No se pudo subir el archivo (${res.status}).`);
  }
  return data.id as string;
}

/** Documento por media id (archivo previamente subido a WhatsApp). */
export function sendDocumentById(to: string, mediaId: string, filename: string, caption?: string) {
  return waPost({ to, type: "document", document: { id: mediaId, filename, caption } });
}

/** Descarga un archivo que mandó el candidato (por media id). */
export async function downloadMedia(
  mediaId: string,
): Promise<{ buffer: Buffer; mimeType: string; filename: string }> {
  const { token } = creds();
  const metaRes = await fetch(`${GRAPH}/${mediaId}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const meta = await metaRes.json().catch(() => ({}));
  if (!metaRes.ok || !meta.url) throw new Error("No se pudo obtener el archivo de WhatsApp.");
  const fileRes = await fetch(meta.url, { headers: { authorization: `Bearer ${token}` } });
  if (!fileRes.ok) throw new Error("No se pudo descargar el archivo de WhatsApp.");
  const buffer = Buffer.from(await fileRes.arrayBuffer());
  return {
    buffer,
    mimeType: meta.mime_type || "application/octet-stream",
    filename: meta.file_name || "archivo",
  };
}
