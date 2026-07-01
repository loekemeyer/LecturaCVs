// Prueba de resolución de problemas: guarda y puntúa el intento de un candidato,
// y lista los resultados para el reclutador.
import { isAuthorized, unauthorized } from "@/lib/auth";
import { supabaseAdmin, supabaseConfigured } from "@/lib/supabase";
import { scoreProblemTest } from "@/lib/prueba";
import type { PruebaSubmission } from "@/lib/prueba-data";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(req: Request) {
  if (!isAuthorized(req)) return unauthorized();
  if (!supabaseConfigured()) return Response.json({ tests: [] });
  const { data } = await supabaseAdmin()
    .from("problem_tests")
    .select("*")
    .order("submitted_at", { ascending: false })
    .limit(500);
  return Response.json({ tests: data ?? [] });
}

export async function POST(req: Request) {
  if (!isAuthorized(req)) return unauthorized();
  if (!supabaseConfigured()) return Response.json({ error: "Sin base de datos." }, { status: 500 });
  let body: {
    candidateId?: unknown;
    candidateName?: unknown;
    searchId?: unknown;
    submission?: PruebaSubmission;
  };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Petición inválida." }, { status: 400 });
  }
  const candidateId = String(body.candidateId ?? "");
  const searchId = String(body.searchId ?? "") || null;
  const candidateName = String(body.candidateName ?? "");
  const sub = body.submission;
  if (!candidateId || !sub) return Response.json({ error: "Faltan datos." }, { status: 400 });

  let result;
  try {
    result = await scoreProblemTest(sub);
  } catch (e) {
    console.error("No se pudo puntuar la prueba:", e);
    return Response.json({ error: "No se pudo puntuar la prueba." }, { status: 502 });
  }

  const id = `${candidateId}-${searchId || "x"}`;
  const { error } = await supabaseAdmin().from("problem_tests").upsert({
    id,
    candidate_id: candidateId,
    candidate_name: candidateName || null,
    search_id: searchId,
    solved: result.solved,
    score: result.total,
    detail: result,
    duration_sec: Math.round(sub.durationSec || 0),
    attempts: Math.round(sub.attempts || 0),
    explanation: sub.explanation || null,
    row_totals: sub.rowTotals || {},
    commissions: sub.commissions || {},
    submitted_at: new Date().toISOString(),
  });
  if (error) return Response.json({ error: error.message }, { status: 502 });
  return Response.json({ ok: true, result });
}
