// Validación de archivos subidos (PDF o imagen), compartida por los endpoints.

export const MAX_UPLOAD_BYTES = 15 * 1024 * 1024; // 15 MB

const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];

/** Devuelve el tipo MIME soportado (PDF o imagen) o null si no se acepta. */
export function detectMediaType(file: File): string | null {
  const t = (file.type || "").toLowerCase();
  if (t === "application/pdf") return "application/pdf";
  if (IMAGE_TYPES.includes(t)) return t;
  const n = file.name.toLowerCase();
  if (n.endsWith(".pdf")) return "application/pdf";
  if (n.endsWith(".png")) return "image/png";
  if (n.endsWith(".jpg") || n.endsWith(".jpeg")) return "image/jpeg";
  if (n.endsWith(".webp")) return "image/webp";
  if (n.endsWith(".gif")) return "image/gif";
  return null;
}
