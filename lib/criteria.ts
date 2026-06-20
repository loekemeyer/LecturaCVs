// Sugerencia de criterios de evaluación a partir del texto de un aviso de
// búsqueda. La idea: el usuario pega (o se importa) el aviso de la empresa y la
// IA propone los criterios + pesos que considera importantes para ese puesto.
// Después el usuario los edita a mano en la página.

import Anthropic from "@anthropic-ai/sdk";
import type { Criterion } from "./types";

// Mismo criterio que en lib/scoring.ts: adaptive thinking solo en modelos 4.6+.
const MODEL = process.env.ANTHROPIC_MODEL || "claude-opus-4-8";
const SUPPORTS_ADAPTIVE_THINKING =
  /^claude-(opus-4-(6|7|8)|sonnet-4-6|fable-5|mythos-5)/.test(MODEL);

const SYSTEM_PROMPT = `Sos un especialista senior en selección de personal en Argentina.
A partir del texto de un aviso de búsqueda laboral, definís los criterios con los que conviene
evaluar y comparar a los candidatos para ESE puesto y ESA empresa.

Pautas:
- Devolvé entre 3 y 6 criterios, ordenados de más a menos importante.
- Cada criterio tiene: un nombre corto y claro; una descripción que explique qué hace que un
  candidato puntúe ALTO o BAJO en ese criterio (para guiar a quien después evalúa los CVs); y un
  peso entero (% de importancia). Los pesos deben sumar 100.
- Basate en lo que el aviso remarca: experiencia, conocimientos técnicos, estudios, disponibilidad
  (horaria, viajar, mudarse), zona/cercanía, idiomas, requisitos excluyentes, etc.
- Si el aviso menciona sueldo o pretensiones salariales, incluí un criterio de sueldo.
- NO uses factores discriminatorios ni irrelevantes (edad, género, foto, nacionalidad, religión,
  estado civil, apariencia).
- Respondé siempre en español.`;

const CRITERIA_SCHEMA = {
  type: "object",
  properties: {
    criteria: {
      type: "array",
      description: "Entre 3 y 6 criterios de evaluación, ordenados de más a menos importante.",
      items: {
        type: "object",
        properties: {
          name: { type: "string", description: "Nombre corto del criterio." },
          weight: {
            type: "number",
            description: "Peso/importancia como entero. Entre todos suman 100.",
          },
          description: {
            type: "string",
            description: "Qué hace que un candidato puntúe alto o bajo en este criterio.",
          },
        },
        required: ["name", "weight", "description"],
        additionalProperties: false,
      },
    },
  },
  required: ["criteria"],
  additionalProperties: false,
} as const;

// Normaliza los pesos a enteros que sumen exactamente 100 (reparte el redondeo).
function normalizeWeights(items: Criterion[]): Criterion[] {
  const positive = items.map((c) => ({ ...c, weight: c.weight > 0 ? c.weight : 0 }));
  const total = positive.reduce((s, c) => s + c.weight, 0);
  if (total <= 0) {
    const even = Math.floor(100 / positive.length);
    return positive.map((c, i) => ({
      ...c,
      weight: even + (i === 0 ? 100 - even * positive.length : 0),
    }));
  }
  const scaled = positive.map((c) => ({ ...c, exact: (c.weight / total) * 100 }));
  const rounded = scaled.map((c) => ({ ...c, weight: Math.max(1, Math.round(c.exact)) }));
  // Ajustamos la diferencia de redondeo sobre el criterio de mayor peso.
  let diff = 100 - rounded.reduce((s, c) => s + c.weight, 0);
  if (diff !== 0) {
    let idx = 0;
    for (let i = 1; i < rounded.length; i++) if (rounded[i].weight > rounded[idx].weight) idx = i;
    rounded[idx].weight = Math.max(1, rounded[idx].weight + diff);
  }
  return rounded.map(({ name, weight, description }) => ({ name, weight, description }));
}

/** Analiza el texto de un aviso y devuelve los criterios sugeridos por la IA. */
export async function suggestCriteria(posting: string, title?: string): Promise<Criterion[]> {
  const text = (posting || "").trim();
  if (!text) throw new Error("No hay texto del aviso para analizar.");

  const client = new Anthropic(); // toma ANTHROPIC_API_KEY del entorno

  const instruction = `${title?.trim() ? `Puesto / búsqueda: ${title.trim()}\n\n` : ""}Texto del aviso:
${text}

Definí los criterios de evaluación para esta búsqueda.`;

  const stream = client.messages.stream({
    model: MODEL,
    max_tokens: 8000,
    ...(SUPPORTS_ADAPTIVE_THINKING ? { thinking: { type: "adaptive" as const } } : {}),
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: [{ type: "text", text: instruction }] }],
    output_config: { format: { type: "json_schema", schema: CRITERIA_SCHEMA } },
  });

  const message = await stream.finalMessage();
  const block = message.content.find((b) => b.type === "text");
  if (!block || block.type !== "text") {
    if (message.stop_reason === "refusal") {
      throw new Error("La IA no pudo procesar este aviso (respuesta rechazada por seguridad).");
    }
    throw new Error("La IA no devolvió criterios para este aviso.");
  }

  let parsed: { criteria?: unknown };
  try {
    const clean = block.text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
    parsed = JSON.parse(clean);
  } catch {
    throw new Error("No se pudieron interpretar los criterios sugeridos por la IA.");
  }

  const list = Array.isArray(parsed.criteria) ? parsed.criteria : [];
  const cleaned: Criterion[] = list
    .map((c: { name?: unknown; weight?: unknown; description?: unknown }) => ({
      name: String(c?.name ?? "").trim(),
      weight: Number(c?.weight) || 0,
      description: String(c?.description ?? "").trim(),
    }))
    .filter((c) => c.name);

  if (!cleaned.length) throw new Error("La IA no devolvió criterios válidos.");
  return normalizeWeights(cleaned);
}
