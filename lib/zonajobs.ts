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

// Piso de un sueldo mensual real en Argentina (2026). Sirve para detectar
// "atajos": si el número cargado queda muy por debajo, la persona escribió el
// monto en millones o en miles y hay que escalarlo.
const SUELDO_PLAUSIBLE_MIN = 100_000;

// Convierte el sueldo pretendido (texto libre, formato argentino) a pesos
// completos. La gente lo carga de formas muy distintas:
//   "1.200.000" / "$1.200.000"  -> 1.200.000  (los puntos son separador de miles)
//   "600000.0" / "600000"       -> 600.000    (full; el ".0" es basura de ZonaJobs)
//   "1.0" / "1" / "1,5" / "2.5" -> 1.000.000 / 1.000.000 / 1.500.000 / 2.500.000 (en millones)
//   "850" / "1200"              -> 850.000 / 1.200.000 (en miles)
// Devuelve los pesos como número, o null si no hay un valor válido.
export function normalizeSalaryToPesos(raw: string): number | null {
  const cleaned = (raw || "").replace(/[$\s]/g, "");
  if (!cleaned) return null;

  let value: number;
  if (cleaned.includes(",")) {
    // Coma = decimal; puntos = miles. "1.234,56" -> 1234.56 ; "1,5" -> 1.5
    value = parseFloat(cleaned.replace(/\./g, "").replace(",", "."));
  } else if (/^\d{1,3}(\.\d{3})+$/.test(cleaned)) {
    // Puntos como separador de miles: "1.200.000" -> 1200000
    value = parseInt(cleaned.replace(/\./g, ""), 10);
  } else {
    // Un solo punto decimal ("1.0", "1.5", "600000.0") o entero puro ("850").
    value = parseFloat(cleaned);
  }
  if (!Number.isFinite(value) || value <= 0) return null;

  // Escala el atajo a pesos completos: subimos de a x1000 hasta un monto
  // mensual plausible. Así "1.5" -> 1.500.000 y "850" -> 850.000, mientras que
  // un monto ya completo (>= 100.000) queda intacto.
  let guard = 0;
  while (value < SUELDO_PLAUSIBLE_MIN && guard++ < 4) value *= 1000;
  return Math.round(value);
}

function parseSalary(body: string): string {
  const m = body.match(/Sueldo pretendido:\s*\$?\s*([\d.,]+)/i);
  if (!m) return "";
  const pesos = normalizeSalaryToPesos(m[1]);
  return pesos ? formatMiles(String(pesos)) : "";
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
