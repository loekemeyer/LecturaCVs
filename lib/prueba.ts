// Puntuación de la prueba de resolución (server-only: usa IA para la comunicación).
import Anthropic from "@anthropic-ai/sdk";
import {
  PRUEBA_CAJA,
  PRUEBA_ERROR_TICKET,
  correctTotals,
  correctCommissions,
  type PruebaSubmission,
} from "./prueba-data";

export interface Dim {
  name: string;
  score: number;
  max: number;
  justification: string;
}
export interface PruebaResult {
  total: number;
  max: number;
  solved: boolean;
  dimensions: Dim[];
  summary: string;
}

const clamp = (n: number, lo = 0, hi = 10) => Math.max(lo, Math.min(hi, n));

export async function scoreProblemTest(sub: PruebaSubmission): Promise<PruebaResult> {
  const correct = correctTotals();
  const finalSum = Object.values(sub.rowTotals || {}).reduce((a, b) => a + (Number(b) || 0), 0);
  const solved = !!sub.closed && finalSum === PRUEBA_CAJA;
  const fixedRightRow = Number(sub.rowTotals?.[PRUEBA_ERROR_TICKET]) === correct[PRUEBA_ERROR_TICKET];
  let tampered = 0;
  for (const t in correct) {
    if (t === PRUEBA_ERROR_TICKET) continue;
    if (Number(sub.rowTotals?.[t]) !== correct[t]) tampered++;
  }
  const correctC = correctCommissions();
  let commOk = 0;
  const commTotal = Object.keys(correctC).length;
  for (const v in correctC) if (Math.abs((Number(sub.commissions?.[v]) || 0) - correctC[v]) < 1) commOk++;

  const mins = (sub.durationSec || 0) / 60;
  let reaccion = solved ? 10 : fixedRightRow ? 5 : 2;
  if (solved) {
    if (mins > 20) reaccion -= 3;
    else if (mins > 12) reaccion -= 1.5;
    if ((sub.attempts || 0) > 4) reaccion -= 2;
  }
  reaccion = clamp(reaccion);

  const resolucion = solved ? 10 : fixedRightRow ? 5 : 0;
  const comisiones = commTotal ? (commOk / commTotal) * 10 : 0;
  const metodo = fixedRightRow ? (tampered ? 6 : 10) : tampered ? 2 : 4;

  let comunica = 5;
  let iaSummary = "";
  try {
    const client = new Anthropic();
    const resp = await client.messages.create({
      model: process.env.ANSWERS_SCORE_MODEL || "claude-sonnet-4-6",
      max_tokens: 220,
      system:
        'Evaluás cómo un candidato EXPLICA la resolución de un ejercicio en el que un total no cuadraba por un dato mal cargado. Devolvés SOLO un JSON: {"score": number 0-10, "resumen": string breve}. El score valora si explica QUÉ error encontró, CÓMO lo resolvió y qué HERRAMIENTAS usó (Excel, IA, etc.), con claridad. Vago o muy corto = bajo; claro y con criterio = alto.',
      messages: [
        {
          role: "user",
          content: `Contexto: había una fila (Espumadera) con el total mal cargado ($65.000 en vez de $50.000), que inflaba el total en $15.000. ¿Resolvió correctamente?: ${
            solved ? "sí" : "no"
          }.\n\nExplicación del candidato:\n"""${(sub.explanation || "").slice(0, 2000)}"""`,
        },
      ],
    });
    const block = resp.content.find((b) => b.type === "text");
    const raw = block && block.type === "text" ? block.text : "";
    const j = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1));
    comunica = clamp(Number(j.score) || 0);
    iaSummary = String(j.resumen || "");
  } catch {
    comunica = (sub.explanation || "").trim().length > 40 ? 6 : 3;
  }

  const dims: Dim[] = [
    {
      name: "Resolución del problema",
      score: Math.round(resolucion * 10) / 10,
      max: 10,
      justification: solved
        ? "Encontró el descuadre y cerró la caja correctamente."
        : fixedRightRow
          ? "Corrigió la fila del error pero no llegó a cerrar bien la caja."
          : "No resolvió el descuadre / no cerró la caja.",
    },
    {
      name: "Comisiones",
      score: Math.round(comisiones * 10) / 10,
      max: 10,
      justification: `Cargó bien ${commOk} de ${commTotal} comisiones.`,
    },
    {
      name: "Reacción",
      score: Math.round(reaccion * 10) / 10,
      max: 10,
      justification: `Tardó ~${Math.round(mins)} min, ${sub.attempts || 0} intento(s) de cierre. ${
        solved ? "Reaccionó y resolvió." : "No logró resolverlo."
      }`,
    },
    {
      name: "Método / verificación",
      score: Math.round(metodo * 10) / 10,
      max: 10,
      justification: fixedRightRow
        ? tampered
          ? `Corrigió la fila correcta, pero también modificó ${tampered} fila(s) que estaban bien.`
          : "Corrigió exactamente la fila del error, sin tocar las demás."
        : tampered
          ? "Modificó filas que estaban bien (parece que forzó el resultado)."
          : "No identificó la fila del error.",
    },
    {
      name: "Comunicación y autonomía",
      score: Math.round(comunica * 10) / 10,
      max: 10,
      justification: iaSummary || "Evaluación de la explicación escrita.",
    },
  ];

  const pesos = [3, 1.5, 2, 1.5, 2];
  const vals = [resolucion, comisiones, reaccion, metodo, comunica];
  const total = vals.reduce((a, v, i) => a + v * pesos[i], 0) / pesos.reduce((a, b) => a + b, 0);

  return {
    total: Math.round(total * 10) / 10,
    max: 10,
    solved,
    dimensions: dims,
    summary: iaSummary || (solved ? "Resolvió el ejercicio." : "No resolvió el ejercicio completo."),
  };
}
