// Núcleo de evaluación de CVs con Claude.
// Función pura `scoreCv`: recibe el PDF + los criterios y devuelve la evaluación.
// La usa /api/score, pero también podría reutilizarla cualquier otra fuente
// de ingreso de CVs en el futuro (ej. lectura automática desde email).

import Anthropic from "@anthropic-ai/sdk";
import type { Criterion, CriterionResult, Evaluation, Recommendation } from "./types";

const MODEL = process.env.ANTHROPIC_MODEL || "claude-opus-4-8";

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
  },
  required: ["candidateName", "criteria", "summary", "strengths", "concerns"],
  additionalProperties: false,
} as const;

const SYSTEM_PROMPT = `Eres un reclutador profesional y objetivo. Evalúas currículums (CVs) de postulantes de forma justa, basándote ÚNICAMENTE en la evidencia presente en el documento.

Reglas:
- Puntuás cada criterio de 0 a 100 según qué tan bien el CV demuestra ese requisito (100 = lo cumple sobradamente y con evidencia clara; 50 = parcial o ambiguo; 0 = sin evidencia alguna).
- Si el CV no menciona información sobre un criterio, asignás un puntaje bajo y lo aclarás. No inventás ni asumís datos que no estén escritos.
- Ignorás factores irrelevantes y potencialmente discriminatorios (género, edad, foto, nacionalidad, estado civil, religión, apariencia): no deben influir en el puntaje.
- Los emprendimientos propios, negocios propios o el trabajo freelance/independiente NO cuentan como experiencia laboral ni como antigüedad o estabilidad: ignoralos al puntuar (no suman). Considerá solo el empleo en relación de dependencia. Aclaralo en la justificación cuando corresponda.
- Al evaluar antigüedad o estabilidad laboral: permanecer alrededor de 2 años o más en un mismo puesto es una BUENA señal (especialmente en personas jóvenes); no lo penalices ni lo trates como mediocre. Lo que SÍ baja el puntaje es el "job hopping": dos o más empleos de menos de 1 año cada uno. Un único trabajo corto no debe penalizar demasiado.
- Las justificaciones son concretas y citan evidencia del CV cuando existe.
- Respondés siempre en español.`;

interface RawResult {
  candidateName: string;
  criteria: { name: string; score: number; justification: string }[];
  summary: string;
  strengths: string[];
  concerns: string[];
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
}

export async function scoreCv(input: ScoreCvInput): Promise<Evaluation> {
  const { fileBase64, mediaType, cvText, fileName, criteria, jobContext, offeredSalary, expectedSalary } =
    input;

  if (!cvText && (!fileBase64 || !mediaType)) {
    throw new Error("No se recibió ni un archivo ni el texto del CV.");
  }

  // Solo criterios con nombre y peso positivo.
  const validCriteria = criteria.filter((c) => c.name.trim() && c.weight > 0);
  if (validCriteria.length === 0) {
    throw new Error("Definí al menos un criterio con nombre y peso mayor a cero.");
  }

  const client = new Anthropic(); // toma ANTHROPIC_API_KEY del entorno

  const criteriaList = validCriteria
    .map(
      (c, i) =>
        `${i + 1}. "${c.name}"${c.description?.trim() ? ` — ${c.description.trim()}` : ""}`,
    )
    .join("\n");

  const salaryBlock =
    offeredSalary?.trim() || expectedSalary?.trim()
      ? `\n\nDatos salariales (usalos si hay un criterio relacionado con el sueldo):
- Sueldo ofrecido por la empresa: ${offeredSalary?.trim() || "no especificado"}
- Sueldo pretendido por este candidato: ${expectedSalary?.trim() || "no especificado"}`
      : "";

  const instruction = `Contexto del puesto:
${jobContext.trim() || "(No especificado.)"}

Evaluá el CV adjunto según estos criterios. Devolvé un objeto por criterio, en el mismo orden y con el mismo nombre exacto que aparece acá:
${criteriaList}${salaryBlock}

Además, extraé el nombre del postulante, un resumen del perfil, sus fortalezas y las dudas o información faltante respecto del puesto.`;

  const cvBlock: Anthropic.ContentBlockParam = cvText
    ? { type: "text", text: `CV del candidato (texto del correo):\n\n${cvText}` }
    : buildCvBlock(fileBase64 as string, mediaType as string);

  const stream = client.messages.stream({
    model: MODEL,
    max_tokens: 16000,
    // Pensamiento adaptativo: mejora la calidad del análisis del CV.
    thinking: { type: "adaptive" },
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: [cvBlock, { type: "text", text: instruction }],
      },
    ],
    // Structured output: obliga a la respuesta a cumplir el esquema JSON.
    output_config: { format: { type: "json_schema", schema: RESULT_SCHEMA } },
  });

  const message = await stream.finalMessage();

  const textBlock = message.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    if (message.stop_reason === "refusal") {
      throw new Error("La IA no pudo procesar este CV (respuesta rechazada por seguridad).");
    }
    throw new Error("La IA no devolvió una respuesta válida para este CV.");
  }

  let raw: RawResult;
  try {
    // Por las dudas, sacamos posibles ``` ```json que algún modelo agregue.
    const clean = textBlock.text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
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

  return {
    fileName,
    candidateName: raw.candidateName?.trim() || "Desconocido",
    overallScore,
    recommendation: recommendationFor(overallScore),
    summary: raw.summary?.trim() || "",
    strengths: Array.isArray(raw.strengths) ? raw.strengths.filter(Boolean) : [],
    concerns: Array.isArray(raw.concerns) ? raw.concerns.filter(Boolean) : [],
    criteria: criteriaResults,
  };
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
