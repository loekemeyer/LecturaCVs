// Tipos compartidos entre el frontend (página) y el backend (/api/score).
// Este archivo NO importa el SDK de Anthropic, así puede usarse en el cliente.

/** Un criterio de evaluación definido por el usuario. */
export interface Criterion {
  /** Nombre del criterio, ej. "Experiencia en React". */
  name: string;
  /** Peso relativo. No hace falta que sumen 100: se normalizan. */
  weight: number;
  /** Descripción opcional para guiar a la IA. */
  description?: string;
}

/** Resultado de un criterio para un postulante. */
export interface CriterionResult {
  name: string;
  /** Puntaje 0-100 para este criterio. */
  score: number;
  /** Peso normalizado en porcentaje (para mostrar). */
  weight: number;
  justification: string;
}

export type Recommendation = "recomendado" | "posible" | "descartado";

/** Evaluación completa de un CV. */
export interface Evaluation {
  fileName: string;
  candidateName: string;
  /** Puntaje final 0-100, ponderado por los pesos de los criterios. */
  overallScore: number;
  recommendation: Recommendation;
  summary: string;
  strengths: string[];
  concerns: string[];
  criteria: CriterionResult[];
  /** Datos para filtrar (NO afectan el puntaje de mérito). */
  age?: number | null;
  sex?: "masculino" | "femenino" | "no especificado";
  location?: string;
  distanceKm?: number | null;
  /** Tiempo de viaje estimado en transporte público (colectivo/tren), en minutos. null si no se estimó o tiene auto. */
  transitMinutes?: number | null;
  /** Tiempo de viaje estimado en auto, en minutos. null si no se estimó. */
  driveMinutes?: number | null;
}
