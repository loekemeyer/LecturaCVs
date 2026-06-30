// Puntúa las RESPUESTAS del candidato al cuestionario del bot, con los mismos
// criterios del puesto (los de la búsqueda). Devuelve un número 0-10.
// Solo puntaje: el detalle lo ve el reclutador leyendo las respuestas.
import Anthropic from "@anthropic-ai/sdk";

const MODEL = process.env.ANSWERS_SCORE_MODEL || "claude-sonnet-4-6";

interface QA {
  q: string;
  a: string;
}

// Acepta criterios en cualquier forma razonable (name/label, description/detail…).
function critToText(criteria: unknown): string {
  if (!Array.isArray(criteria) || criteria.length === 0) return "(sin criterios definidos)";
  return criteria
    .map((c) => {
      const o = (c ?? {}) as Record<string, unknown>;
      const name = String(o.name ?? o.label ?? o.title ?? "").trim();
      const desc = String(o.description ?? o.detail ?? o.guideline ?? o.guia ?? "").trim();
      if (!name && !desc) return "";
      return `- ${name}${desc ? ": " + desc : ""}`;
    })
    .filter(Boolean)
    .join("\n");
}

export async function scoreAnswers(
  answers: QA[],
  criteria: unknown,
  puesto: string,
): Promise<number | null> {
  if (!Array.isArray(answers) || answers.length === 0) return null;
  const client = new Anthropic();
  const qa = answers
    .map((x, i) => `${i + 1}. ${x.q}\n   Respuesta: ${x.a || "(sin respuesta)"}`)
    .join("\n");
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 100,
    system:
      "Sos un evaluador de RRHH. Calificás las RESPUESTAS de un candidato a un cuestionario de preselección según los criterios del puesto. Respondés ÚNICAMENTE con un número del 0 al 10 (podés usar un decimal), sin nada más. 10 = las respuestas cumplen muy bien los criterios; 0 = no los cumplen.",
    messages: [
      {
        role: "user",
        content: `Puesto: ${puesto || "(sin especificar)"}\n\nCriterios del puesto:\n${critToText(
          criteria,
        )}\n\nRespuestas del candidato:\n${qa}\n\nPuntaje (0 a 10):`,
      },
    ],
  });
  const block = response.content.find((b) => b.type === "text");
  const raw = block && block.type === "text" ? block.text : "";
  const m = raw.match(/\d+(\.\d+)?/);
  if (!m) return null;
  return Math.max(0, Math.min(10, parseFloat(m[0])));
}
