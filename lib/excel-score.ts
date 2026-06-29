// Corrector de la "Prueba Excel 3": lee las fórmulas que escribió el candidato en
// la hoja "A Resolver" y las puntúa con la rúbrica (BUSCARV / SI / SUMAR.SI.CONJUNTO
// + optimizar columnas). Los matices ("fijó celdas", "tomó columnas", "matriz mal")
// los resuelve la IA, que es buena leyendo fórmulas.
import * as XLSX from "xlsx";
import Anthropic from "@anthropic-ai/sdk";

const SHEET = "A Resolver";
const KEY_CELLS = ["B2", "B3", "B4", "E2", "E3", "E4", "F2", "F3", "F4", "E8", "E9"];

// Fórmulas ideales (de la versión resuelta) — referencia para la IA.
const IDEAL = `Hoja "A Resolver":
- B2,B3,B4 (Razón Social): =VLOOKUP(A2,'Base de Datos'!$A:$C,3,)   (columna 3)
- E2,E3,E4 (Límite de Crédito): =VLOOKUP(A2,'Base de Datos'!$A:$C,2,)   (columna 2)
- F2,F3,F4 (Estado): =IF(B2="Juancito SRL","Denegado x Conflictos Comerciales",IF(B2="Carrefour","Aceptado x Carrefour",IF(E2>D2,"Pedido Aceptado","Pedido Rechazado")))  — MISMA fórmula en las 3 filas
- E8,E9 (suma por fecha): =SUMIFS(D:D,C:C,D8)`;

const RUBRIC = `Rúbrica (puntaje por dimensión):
BUSCARV (columnas B y E, máx 3): 3 = correcto; 2,5 = correcto pero sin tomar columnas enteras, fijando celdas ($A$2:$C$4); 2 = agarró mal la matriz; 1 = eligió mal el valor buscado / dio mal; 0 = no realizado.
SI (columna F, máx 3): 3 = una misma fórmula en F2/F3/F4 que resuelve todo; 2 = logra el objetivo pero el SI es distinto en F2/F3/F4; 1 = lo hizo a mano, sin fórmula; 0 = no realizado.
SUMAR.SI.CONJUNTO (E8/E9, máx 3): 3 = correcto; 2,5 = correcto pero sin tomar columnas (fijando celdas); 1,5 = realizado sin fijar las celdas; 0 = no realizado.
Optimizar columnas/formato (máx 1): 1 = correcto (separador de miles, sin decimales, columnas ajustadas); 0 = no realizado. (Si no se puede determinar por las fórmulas, marcar 0 y dejar para revisión manual.)`;

interface Dim {
  name: string;
  score: number;
  max: number;
  justification: string;
}
export interface ExcelScore {
  total: number;
  max: number;
  dimensions: Dim[];
  summary: string;
  manualReview?: boolean;
}

const SCHEMA = {
  type: "object",
  properties: {
    dimensions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          score: { type: "number" },
          max: { type: "number" },
          justification: { type: "string" },
        },
        required: ["name", "score", "max", "justification"],
        additionalProperties: false,
      },
    },
    summary: { type: "string", description: "Resumen breve (1-2 frases)." },
    manualReview: { type: "boolean", description: "true si algo no se pudo evaluar y conviene revisar a mano." },
  },
  required: ["dimensions", "summary", "manualReview"],
  additionalProperties: false,
} as const;

export async function scoreExcel(buffer: Buffer): Promise<ExcelScore> {
  const wb = XLSX.read(buffer, { cellFormula: true });
  const ws = wb.Sheets[SHEET];
  const cells: Record<string, { formula: string | null; value: string | null; numFmt: string | null }> = {};
  if (ws) {
    for (const a of KEY_CELLS) {
      const c = ws[a] as { f?: string; v?: unknown; z?: string } | undefined;
      cells[a] = c
        ? { formula: c.f ? `=${c.f}` : null, value: c.v != null ? String(c.v) : null, numFmt: c.z || null }
        : { formula: null, value: null, numFmt: null };
    }
  }
  const sheetNames = wb.SheetNames.join(", ");

  const client = new Anthropic();
  const model = process.env.EXCEL_SCORE_MODEL || "claude-sonnet-4-6";
  const instruction = `Sos un evaluador de una prueba de Excel para selección de personal. Corregí SOLO con la evidencia de las fórmulas/valores que te paso.

${IDEAL}

${RUBRIC}

Hojas del archivo del candidato: ${sheetNames}
Celdas del candidato en la hoja "A Resolver" (fórmula / valor / formato de número):
${KEY_CELLS.map((a) => `${a}: ${JSON.stringify(cells[a])}`).join("\n")}

Devolvé un objeto con 4 dimensiones (BUSCARV, SI, SUMAR.SI.CONJUNTO, Optimizar columnas), cada una con su puntaje según la rúbrica y una justificación breve citando la fórmula. Las celdas vacías = no realizado (0).`;

  const resp = await client.messages.create({
    model,
    max_tokens: 1500,
    system:
      "Evaluás pruebas de Excel de forma objetiva, basándote solo en las fórmulas y valores provistos. Respondés en español.",
    messages: [{ role: "user", content: [{ type: "text", text: instruction }] }],
    output_config: { format: { type: "json_schema", schema: SCHEMA } },
  });
  const block = resp.content.find((b) => b.type === "text");
  const raw = block && block.type === "text" ? block.text : "{}";
  let parsed: { dimensions?: Dim[]; summary?: string; manualReview?: boolean };
  try {
    parsed = JSON.parse(raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, ""));
  } catch {
    return { total: 0, max: 10, dimensions: [], summary: "No se pudo evaluar el archivo.", manualReview: true };
  }
  const dimensions = Array.isArray(parsed.dimensions) ? parsed.dimensions : [];
  const total = Math.round(dimensions.reduce((s, d) => s + (Number(d.score) || 0), 0) * 10) / 10;
  const max = dimensions.reduce((s, d) => s + (Number(d.max) || 0), 0) || 10;
  return { total, max, dimensions, summary: parsed.summary || "", manualReview: !!parsed.manualReview };
}
