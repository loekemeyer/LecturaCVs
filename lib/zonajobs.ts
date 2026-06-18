// Parser de los mails de postulación de ZonaJobs (no_reply@zonajobs.com.ar).
// El CV viene en el cuerpo del correo; de ahí sacamos búsqueda, nombre, sueldo y CV.

export interface ZonaJobsApplication {
  /** Búsqueda / aviso (del asunto). */
  job: string;
  candidateName: string;
  /** Sueldo pretendido formateado con miles (ej. "600.000"); "" si no figura. */
  expectedSalary: string;
  /** CV (cuerpo del mail sin el pie legal). */
  cvText: string;
}

const formatMiles = (s: string): string => {
  const d = (s || "").replace(/\D/g, "");
  return d ? d.replace(/\B(?=(\d{3})+(?!\d))/g, ".") : "";
};

/** Saca el nombre de la búsqueda del asunto (o del cuerpo como respaldo). */
export function parseJobTitle(subject: string, body: string): string | null {
  const m = subject?.match(/aviso\s*["“«'']\s*(.+?)\s*["”»'']/i);
  if (m) return m[1].trim();
  const b = body?.match(/postulado a su b[uú]squeda de:\s*\n?\s*(.+?)\s*\(ID:/i);
  if (b) return b[1].trim();
  return null;
}

function parseName(body: string): string {
  const lines = body.split(/\r?\n/).map((l) => l.trim());
  const idIdx = lines.findIndex((l) => /\(ID:\s*\d+\)/i.test(l));
  if (idIdx >= 0) {
    for (let i = idIdx + 1; i < lines.length; i++) {
      if (!lines[i]) continue;
      if (/^datos de contacto/i.test(lines[i])) break;
      return lines[i];
    }
  }
  return "";
}

function parseSalary(body: string): string {
  const m = body.match(/Sueldo pretendido:\s*\$?\s*([\d.,]+)/i);
  if (!m) return "";
  // "600000.0" -> saca decimales finales -> "600000" -> "600.000"
  return formatMiles(m[1].replace(/[.,]\d{1,2}$/, ""));
}

function parseCvText(body: string): string {
  const cut = body.search(/PUBLICIDAD\.\s*ESTE ES UN MENSAJE|ZONAJOBS ES UN SITIO WEB/i);
  return (cut >= 0 ? body.slice(0, cut) : body).trim();
}

/** Parsea un mail; devuelve null si no parece una postulación con CV. */
export function parseZonaJobsApplication(
  subject: string,
  body: string,
): ZonaJobsApplication | null {
  const text = body || "";
  const looksLikeApplication =
    /postulado a su b[uú]squeda|datos de contacto/i.test(text) ||
    /Has recibido un CV/i.test(subject || "");
  if (!looksLikeApplication) return null;

  return {
    job: parseJobTitle(subject || "", text) || "Sin búsqueda",
    candidateName: parseName(text) || "Desconocido",
    expectedSalary: parseSalary(text),
    cvText: parseCvText(text),
  };
}
