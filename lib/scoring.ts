// Núcleo de evaluación de CVs con Claude.
// Función pura `scoreCv`: recibe el PDF + los criterios y devuelve la evaluación.
// La usa /api/score, pero también podría reutilizarla cualquier otra fuente
// de ingreso de CVs en el futuro (ej. lectura automática desde email).

import Anthropic from "@anthropic-ai/sdk";
import type { Criterion, CriterionResult, Evaluation, Recommendation } from "./types";

const MODEL = process.env.ANTHROPIC_MODEL || "claude-opus-4-8";
const PLANT_ADDRESS = process.env.PLANT_ADDRESS || "Cervantes 2868, CABA, Argentina";

// El "pensamiento adaptativo" (thinking: adaptive) mejora la calidad del análisis,
// pero solo existe en modelos Claude 4.6 en adelante (Opus 4.6/4.7/4.8, Sonnet 4.6,
// Fable/Mythos 5). En modelos anteriores —por ejemplo claude-haiku-4-5, que el
// .env sugiere para abaratar costos— la API responde con un 400:
// "adaptive thinking is not supported on this model". Por eso solo lo activamos
// cuando el modelo lo soporta; con el resto la evaluación corre igual, sin thinking.
const SUPPORTS_ADAPTIVE_THINKING =
  /^claude-(opus-4-(6|7|8)|sonnet-4-6|fable-5|mythos-5)/.test(MODEL);

// Lo que le pedimos a la IA que devuelva (structured output).
const RESULT_SCHEMA = {
  type: "object",
  properties: {
    candidateName: {
      type: "string",
      description:
        "Nombre del postulante tal como aparece en el CV. Si no se encuentra, devolvé 'Desconocido'.",
    },
    criteria: {
      type: "array",
      description:
        "Un objeto por cada criterio recibido, en el mismo orden y con el mismo nombre exacto.",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          score: {
            type: "number",
            description:
              "Puntaje de 0 a 100. 100 = el CV demuestra el requisito con evidencia clara; 0 = sin evidencia alguna.",
          },
          justification: {
            type: "string",
            description: "Justificación breve (1-2 frases) basada en el CV.",
          },
        },
        required: ["name", "score", "justification"],
        additionalProperties: false,
      },
    },
    summary: { type: "string", description: "Resumen del perfil en 2-3 frases." },
    strengths: {
      type: "array",
      items: { type: "string" },
      description: "Fortalezas clave respecto del puesto.",
    },
    concerns: {
      type: "array",
      items: { type: "string" },
      description: "Dudas, riesgos o información faltante respecto del puesto.",
    },
    candidateAge: {
      type: "integer",
      description: "Edad en años calculada de la fecha de nacimiento del CV. 0 si no figura.",
    },
    candidateSex: {
      type: "string",
      enum: ["masculino", "femenino", "no especificado"],
      description:
        "Sexo inferido del nombre y datos del CV. 'no especificado' si no se puede determinar.",
    },
    candidateLocation: {
      type: "string",
      description: "Barrio o localidad del candidato tal como figura en el CV. Vacío si no figura.",
    },
    distanceKm: {
      type: "number",
      description:
        "Distancia aproximada en km (línea recta) desde la ubicación del candidato hasta la sede laboral. -1 si no se puede estimar.",
    },
    transitMinutes: {
      type: "number",
      description:
        "Tiempo de viaje en transporte público (minutos) hasta la sede, SOLO si el candidato NO tiene movilidad propia/auto. -1 si tiene auto o no se puede estimar.",
    },
    driveMinutes: {
      type: "number",
      description:
        "Tiempo de viaje en auto (minutos) hasta la sede, SOLO si el CV aclara que el candidato tiene movilidad propia/auto. -1 si no menciona auto o no se puede estimar.",
    },
  },
  required: [
    "candidateName",
    "criteria",
    "summary",
    "strengths",
    "concerns",
    "candidateAge",
    "candidateSex",
    "candidateLocation",
    "distanceKm",
    "transitMinutes",
    "driveMinutes",
  ],
  additionalProperties: false,
} as const;

const SYSTEM_PROMPT = `Eres un reclutador profesional y objetivo. Evalúas currículums (CVs) de postulantes de forma justa, basándote ÚNICAMENTE en la evidencia presente en el documento.

Reglas:
- Puntuás cada criterio de 0 a 100 según qué tan bien el CV demuestra ese requisito (100 = lo cumple sobradamente y con evidencia clara; 50 = parcial o ambiguo; 0 = sin evidencia alguna).
- Si el CV no menciona información sobre un criterio, asignás un puntaje bajo y lo aclarás. No inventás ni asumís datos que no estén escritos.
- Ignorás factores irrelevantes y potencialmente discriminatorios (género, edad, foto, nacionalidad, estado civil, religión, apariencia): no deben influir en el puntaje.
- Los emprendimientos propios, negocios propios o el trabajo freelance/independiente NO cuentan como experiencia laboral ni como antigüedad o estabilidad: ignoralos al puntuar (no suman). Considerá solo el empleo en relación de dependencia. Aclaralo en la justificación cuando corresponda.
- Al evaluar antigüedad o estabilidad laboral: permanecer alrededor de 2 años o más en un mismo puesto es una BUENA señal (especialmente en personas jóvenes); no lo penalices ni lo trates como mediocre. Lo que SÍ baja el puntaje es el "job hopping": dos o más empleos de menos de 1 año cada uno. Un único trabajo corto no debe penalizar demasiado.
- Las justificaciones son concretas y citan evidencia del CV cuando existe, pero BREVES: una sola oración corta por criterio (máx. ~20 palabras), sin repetir el nombre del criterio. El resumen, máximo 2 oraciones. Cada fortaleza y cada duda, en pocas palabras (no oraciones largas). La concisión importa para ahorrar.
- Respondés siempre en español.`;

interface RawResult {
  candidateName: string;
  criteria: { name: string; score: number; justification: string }[];
  summary: string;
  strengths: string[];
  concerns: string[];
  candidateAge: number;
  candidateSex: string;
  candidateLocation: string;
  distanceKm: number;
  transitMinutes: number;
  driveMinutes: number;
}

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));
const norm = (s: string) => s.trim().toLowerCase();

function recommendationFor(score: number): Recommendation {
  if (score >= 75) return "recomendado";
  if (score >= 50) return "posible";
  return "descartado";
}

// El CV puede venir como PDF (bloque "document") o como imagen/foto (bloque "image").
function buildCvBlock(fileBase64: string, mediaType: string): Anthropic.ContentBlockParam {
  return mediaType === "application/pdf"
    ? {
        type: "document",
        source: { type: "base64", media_type: "application/pdf", data: fileBase64 },
      }
    : {
        type: "image",
        source: {
          type: "base64",
          media_type: mediaType as "image/png" | "image/jpeg" | "image/webp" | "image/gif",
          data: fileBase64,
        },
      };
}

export interface ScoreCvInput {
  /** Archivo (PDF o imagen) codificado en base64, sin el prefijo "data:". */
  fileBase64?: string;
  /** Tipo MIME: "application/pdf" o "image/png" | "image/jpeg" | "image/webp" | "image/gif". */
  mediaType?: string;
  /** Alternativa al archivo: el CV como texto (ej. cuerpo de un mail de ZonaJobs). */
  cvText?: string;
  fileName: string;
  criteria: Criterion[];
  jobContext: string;
  /** Sueldo que ofrece la empresa (texto libre, ej. "$1.200.000"). Global. */
  offeredSalary?: string;
  /** Sueldo pretendido por este candidato (texto libre). Por candidato. */
  expectedSalary?: string;
  /** Dirección de la sede laboral para estimar distancia y tiempos de viaje. Por búsqueda. */
  plantAddress?: string;
}

// Parámetros de una request de evaluación. Sirve para la API normal (streaming)
// y para la de lotes/batch (modo económico, -50%).
type ScoreParams = Anthropic.MessageCreateParamsNonStreaming;

// Arma el pedido a la IA para un CV (sin ejecutarlo). Se reutiliza en ambos modos.
export function buildScoreParams(input: ScoreCvInput): {
  params: ScoreParams;
  validCriteria: Criterion[];
  fileName: string;
} {
  const {
    fileBase64,
    mediaType,
    cvText,
    fileName,
    criteria,
    jobContext,
    offeredSalary,
    expectedSalary,
    plantAddress,
  } = input;

  if (!cvText && (!fileBase64 || !mediaType)) {
    throw new Error("No se recibió ni un archivo ni el texto del CV.");
  }

  // Solo criterios con nombre y peso positivo.
  const validCriteria = criteria.filter((c) => c.name.trim() && c.weight > 0);
  if (validCriteria.length === 0) {
    throw new Error("Definí al menos un criterio con nombre y peso mayor a cero.");
  }

  const sede = plantAddress?.trim() || PLANT_ADDRESS;

  const criteriaList = validCriteria
    .map(
      (c, i) => `${i + 1}. "${c.name}"${c.description?.trim() ? ` — ${c.description.trim()}` : ""}`,
    )
    .join("\n");

  const salaryBlock =
    offeredSalary?.trim() || expectedSalary?.trim()
      ? `\n\nDatos salariales (usalos si hay un criterio relacionado con el sueldo).
Los montos están en pesos argentinos mensuales completos (ej. "1.000.000" = un millón de pesos por mes); interpretalos tal cual, sin reescalar:
- Sueldo ofrecido por la empresa: ${offeredSalary?.trim() || "no especificado"}
- Sueldo pretendido por este candidato: ${expectedSalary?.trim() || "no especificado"}`
      : "";

  const instruction = `Contexto del puesto:
${jobContext.trim() || "(No especificado.)"}

Evaluá el CV adjunto según estos criterios. Devolvé un objeto por criterio, en el mismo orden y con el mismo nombre exacto que aparece acá:
${criteriaList}${salaryBlock}

Además, extraé el nombre del postulante, un resumen del perfil, sus fortalezas y las dudas o información faltante respecto del puesto.

Datos adicionales solo para filtrar (NO influyen en el puntaje de los criterios; los uso aparte para organizar la búsqueda). La sede laboral está en: ${sede}.
- candidateAge: edad en años. Calculala de la fecha de nacimiento si figura; si no figura, devolvé 0.
- candidateSex: "masculino" o "femenino" si se puede inferir del nombre o los datos; si no, "no especificado".
- candidateLocation: barrio, localidad o ciudad de residencia del candidato tal como figura en el CV. Vacío si no figura.
- distanceKm: distancia aproximada en km (en línea recta) desde la ubicación del candidato hasta la sede laboral. Estimala con tu conocimiento de geografía de la zona. -1 si no podés estimar la ubicación.
- transitMinutes: SOLO si el CV NO menciona que el candidato tenga movilidad propia o auto, estimá el tiempo de viaje en TRANSPORTE PÚBLICO (colectivo, tren o subte; la combinación más razonable) en minutos hasta la sede laboral en un día hábil, según la dirección/zona del candidato. Si el CV aclara que tiene movilidad propia/auto, devolvé -1 acá. -1 también si no podés estimarlo.
- driveMinutes: SOLO si el CV aclara que el candidato tiene movilidad propia o auto, estimá el tiempo de viaje en AUTO (en minutos) hasta la sede laboral. Si el CV no menciona auto/movilidad propia, devolvé -1 acá. -1 también si no podés estimarlo.`;

  const cvBlock: Anthropic.ContentBlockParam = cvText
    ? { type: "text", text: `CV del candidato (texto del correo):\n\n${cvText}` }
    : buildCvBlock(fileBase64 as string, mediaType as string);

  const params: ScoreParams = {
    model: MODEL,
    max_tokens: 16000,
    // Pensamiento adaptativo solo en modelos que lo soportan.
    ...(SUPPORTS_ADAPTIVE_THINKING ? { thinking: { type: "adaptive" as const } } : {}),
    // El prompt de sistema es idéntico en todos los CVs: lo marcamos para caché de
    // prompt (en modelos chicos como Haiku puede no alcanzar el mínimo; no molesta).
    system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: [cvBlock, { type: "text", text: instruction }] }],
    // Structured output: obliga a la respuesta a cumplir el esquema JSON.
    output_config: { format: { type: "json_schema", schema: RESULT_SCHEMA } },
  };

  return { params, validCriteria, fileName };
}

// Interpreta el texto JSON devuelto por la IA y arma la evaluación final.
export function parseEvaluation(
  text: string,
  validCriteria: Criterion[],
  fileName: string,
): Evaluation {
  let raw: RawResult;
  try {
    // Por las dudas, sacamos posibles ``` ```json que algún modelo agregue.
    const clean = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
    raw = JSON.parse(clean) as RawResult;
  } catch {
    throw new Error("No se pudo interpretar la evaluación devuelta por la IA.");
  }

  // Mapeo de los puntajes de la IA a los criterios del usuario (por nombre, con
  // respaldo por posición) y cálculo del puntaje final ponderado por los pesos.
  const byName = new Map(raw.criteria.map((c) => [norm(c.name), c]));
  const totalWeight = validCriteria.reduce((s, c) => s + c.weight, 0) || 1;

  const criteriaResults: CriterionResult[] = validCriteria.map((c, i) => {
    const match = byName.get(norm(c.name)) ?? raw.criteria[i];
    const score = clamp(Math.round(match?.score ?? 0), 0, 100);
    return {
      name: c.name,
      score,
      weight: Math.round((c.weight / totalWeight) * 100),
      justification: match?.justification?.trim() || "Sin información en el CV.",
    };
  });

  const overallScore = Math.round(
    validCriteria.reduce((sum, c, i) => {
      const match = byName.get(norm(c.name)) ?? raw.criteria[i];
      const score = clamp(match?.score ?? 0, 0, 100);
      return sum + score * (c.weight / totalWeight);
    }, 0),
  );

  // Datos para filtrar. Los sentinels del esquema (0 / -1 / "") se traducen a
  // null/undefined para que "sin dato" no se confunda con un valor real.
  const allowedSex: Evaluation["sex"][] = ["masculino", "femenino", "no especificado"];
  const age = typeof raw.candidateAge === "number" && raw.candidateAge > 0 ? raw.candidateAge : null;
  const sex = allowedSex.includes(raw.candidateSex as Evaluation["sex"])
    ? (raw.candidateSex as Evaluation["sex"])
    : "no especificado";
  const location = raw.candidateLocation?.trim() || undefined;
  const distanceKm =
    typeof raw.distanceKm === "number" && raw.distanceKm >= 0 ? Math.round(raw.distanceKm) : null;
  const transitMinutes =
    typeof raw.transitMinutes === "number" && raw.transitMinutes >= 0
      ? Math.round(raw.transitMinutes)
      : null;
  const driveMinutes =
    typeof raw.driveMinutes === "number" && raw.driveMinutes >= 0
      ? Math.round(raw.driveMinutes)
      : null;

  return {
    fileName,
    candidateName: raw.candidateName?.trim() || "Desconocido",
    overallScore,
    recommendation: recommendationFor(overallScore),
    summary: raw.summary?.trim() || "",
    strengths: Array.isArray(raw.strengths) ? raw.strengths.filter(Boolean) : [],
    concerns: Array.isArray(raw.concerns) ? raw.concerns.filter(Boolean) : [],
    criteria: criteriaResults,
    age,
    sex,
    location,
    distanceKm,
    transitMinutes,
    driveMinutes,
  };
}

export async function scoreCv(input: ScoreCvInput): Promise<Evaluation> {
  const client = new Anthropic(); // toma ANTHROPIC_API_KEY del entorno
  const { params, validCriteria, fileName } = buildScoreParams(input);

  const stream = client.messages.stream(params);
  const message = await stream.finalMessage();

  const textBlock = message.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    if (message.stop_reason === "refusal") {
      throw new Error("La IA no pudo procesar este CV (respuesta rechazada por seguridad).");
    }
    throw new Error("La IA no devolvió una respuesta válida para este CV.");
  }

  return parseEvaluation(textBlock.text, validCriteria, fileName);
}

/** Extrae solo el nombre del postulante (rápido y barato, con un modelo liviano). */
export async function extractCandidateName(input: {
  fileBase64: string;
  mediaType: string;
}): Promise<string> {
  const client = new Anthropic();
  const response = await client.messages.create({
    model: "claude-haiku-4-5",
    max_tokens: 60,
    system:
      "Extraés el nombre completo del postulante de un CV. Respondés ÚNICAMENTE con el nombre, sin texto adicional ni puntuación. Si no figura el nombre de una persona, respondés exactamente: Desconocido.",
    messages: [
      {
        role: "user",
        content: [
          buildCvBlock(input.fileBase64, input.mediaType),
          { type: "text", text: "¿Cuál es el nombre completo del postulante?" },
        ],
      },
    ],
  });
  const block = response.content.find((b) => b.type === "text");
  const raw = block && block.type === "text" ? block.text.trim() : "";
  const name = raw.split("\n")[0].replace(/^["']|["']$/g, "").trim().slice(0, 80);
  return name || "Desconocido";
}
