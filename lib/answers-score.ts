// Puntúa las RESPUESTAS del candidato al cuestionario del bot, con los mismos
// criterios del puesto (los de la búsqueda). Devuelve un número 0-10.
// Solo puntaje: el detalle lo ve el reclutador leyendo las respuestas.
import Anthropic from "@anthropic-ai/sdk";

const MODEL = process.env.ANSWERS_SCORE_MODEL || "claude-sonnet-4-6";

interface QA {
  q: string;
  a: string;
}

// Detecta si en la parte "día habitual" el candidato copió/pegó las tareas del CV
// (o solo listó tareas) en vez de describir la rutina de un día. Devuelve true si
// hay que pedirle que la reescriba. Ante la duda, devuelve false (no molesta de más).
export async function isCopiedDailyDescription(answer: string, cvText: string): Promise<boolean> {
  if (!answer || answer.trim().length < 10) return false;
  const client = new Anthropic();
  const cv = (cvText || "").slice(0, 6000);
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 10,
    system:
      "A un candidato se le pidió describir cómo es un DÍA HABITUAL en su último empleo: una narración de su rutina/jornada (horarios, qué hacía a la mañana, a la tarde, etc.), NO un listado de tareas. Recibís su respuesta y (si hay) su CV. Respondé ÚNICAMENTE 'COPIA' si la parte del 'día habitual' es básicamente un COPIA-PEGA del CV o una simple LISTA de tareas sin describir la rutina de un día. Respondé 'OK' si describe una jornada/rutina real, aunque sea breve. Ante la duda, respondé 'OK'. Nada más que 'COPIA' u 'OK'.",
    messages: [
      {
        role: "user",
        content: `${cv ? `CV del candidato (para comparar):\n${cv}\n\n` : ""}Respuesta del candidato:\n${answer}\n\n¿COPIA u OK?`,
      },
    ],
  });
  const block = response.content.find((b) => b.type === "text");
  const raw = (block && block.type === "text" ? block.text : "").toUpperCase();
  return raw.includes("COPIA");
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
