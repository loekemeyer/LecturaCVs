// Datos compartidos (multiusuario) en Supabase. Toda lectura/escritura pasa por
// acá usando la service key (en el servidor); el navegador nunca habla directo con
// la base, salvo para escuchar la "señal" de cambios (tiempo real, sin datos).
import { supabaseAdmin, supabaseConfigured } from "@/lib/supabase";
import { isAuthorized, unauthorized } from "@/lib/auth";

export const runtime = "nodejs";
export const maxDuration = 60;

type Row = Record<string, unknown>;

interface JobLike {
  id: string;
  title?: string;
  firstDate?: string;
  criteria?: unknown;
  offeredSalary?: string;
  offeredSalaryMax?: string;
  salaryRange?: boolean;
  jobContext?: string;
  posting?: string;
  plantAddress?: string;
  sedeId?: string;
  filters?: unknown;
  stages?: unknown;
  sortIndex?: number;
  botArea?: string;
  candidates?: CandLike[];
}

interface CandLike {
  id: string;
  source?: string;
  name?: string;
  cvText?: string;
  expectedSalary?: string;
  date?: string;
  emailUid?: number;
  status?: string;
  calificacion?: string;
  stageId?: string;
  notes?: string;
  scoreStatus?: string;
  error?: string;
  evaluation?: unknown;
  evaluatedAt?: string;
}

const nowIso = () => new Date().toISOString();

function jobToRow(j: JobLike): Row {
  return {
    id: j.id,
    title: j.title ?? "",
    first_date: j.firstDate ?? null,
    criteria: j.criteria ?? [],
    offered_salary: j.offeredSalary ?? "",
    offered_salary_max: j.offeredSalaryMax ?? null,
    salary_range: !!j.salaryRange,
    job_context: j.jobContext ?? "",
    posting: j.posting ?? null,
    plant_address: j.plantAddress ?? null,
    sede_id: j.sedeId ?? null,
    filters: j.filters ?? null,
    stages: j.stages ?? null,
    sort_index: j.sortIndex ?? 0,
    bot_area: j.botArea ?? null,
    updated_at: nowIso(),
  };
}

function rowToJob(r: Row, candidates: CandLike[]): JobLike {
  return {
    id: String(r.id),
    title: (r.title as string) ?? "",
    firstDate: (r.first_date as string) ?? undefined,
    criteria: r.criteria ?? [],
    offeredSalary: (r.offered_salary as string) ?? "",
    offeredSalaryMax: (r.offered_salary_max as string) ?? undefined,
    salaryRange: !!r.salary_range,
    jobContext: (r.job_context as string) ?? "",
    posting: (r.posting as string) ?? undefined,
    plantAddress: (r.plant_address as string) ?? undefined,
    sedeId: (r.sede_id as string) ?? undefined,
    filters: r.filters ?? undefined,
    stages: r.stages ?? undefined,
    sortIndex: (r.sort_index as number) ?? 0,
    botArea: (r.bot_area as string) ?? undefined,
    candidates,
  };
}

function candToRow(searchId: string, c: CandLike): Row {
  return {
    id: c.id,
    search_id: searchId,
    source: c.source ?? null,
    name: c.name ?? "",
    cv_text: c.cvText ?? null,
    expected_salary: c.expectedSalary ?? "",
    date: c.date ?? null,
    email_uid: c.emailUid ?? null,
    status: c.status ?? "nuevo",
    calificacion: c.calificacion ?? null,
    stage_id: c.stageId ?? null,
    notes: c.notes ?? null,
    score_status: c.scoreStatus ?? "pending",
    error: c.error ?? null,
    evaluation: c.evaluation ?? null,
    evaluated_at: c.evaluatedAt ?? null,
    updated_at: nowIso(),
  };
}

function rowToCand(r: Row): CandLike {
  return {
    id: String(r.id),
    source: (r.source as string) ?? undefined,
    name: (r.name as string) ?? "",
    cvText: (r.cv_text as string) ?? undefined,
    expectedSalary: (r.expected_salary as string) ?? "",
    date: (r.date as string) ?? "",
    emailUid: r.email_uid != null ? Number(r.email_uid) : undefined,
    status: (r.status as string) ?? "nuevo",
    calificacion: (r.calificacion as string) ?? undefined,
    stageId: (r.stage_id as string) ?? undefined,
    notes: (r.notes as string) ?? undefined,
    scoreStatus: (r.score_status as string) ?? "pending",
    error: (r.error as string) ?? undefined,
    evaluation: r.evaluation ?? undefined,
    evaluatedAt: (r.evaluated_at as string) ?? undefined,
  };
}

async function bump(scope: string, searchId: string | null, clientId: string | null) {
  await supabaseAdmin()
    .from("realtime_signal")
    .update({ scope, search_id: searchId, client_id: clientId ?? null, updated_at: nowIso() })
    .eq("id", "default");
}

function bad(error: string, status = 400) {
  return Response.json({ error }, { status });
}

export async function POST(req: Request) {
  if (!isAuthorized(req)) return unauthorized();
  if (!supabaseConfigured()) {
    return bad("La base de datos no está configurada en el servidor (faltan claves de Supabase).", 500);
  }

  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    /* vacío => load */
  }
  const action = String(body.action ?? "load");
  const clientId = (body.clientId as string) || null;
  const sb = supabaseAdmin();

  try {
    if (action === "load") {
      const [searchesRes, candsRes, settingsRes] = await Promise.all([
        sb.from("searches").select("*").order("sort_index", { ascending: true }),
        sb.from("candidates").select("*"),
        sb.from("app_settings").select("*").eq("id", "default").maybeSingle(),
      ]);
      if (searchesRes.error) throw searchesRes.error;
      if (candsRes.error) throw candsRes.error;
      const byJob = new Map<string, CandLike[]>();
      for (const r of (candsRes.data ?? []) as Row[]) {
        const sid = String(r.search_id);
        const list = byJob.get(sid) ?? [];
        list.push(rowToCand(r));
        byJob.set(sid, list);
      }
      const jobs = ((searchesRes.data ?? []) as Row[]).map((r) =>
        rowToJob(r, byJob.get(String(r.id)) ?? []),
      );
      const settings = (settingsRes.data ?? null) as Row | null;
      return Response.json({
        jobs,
        sedes: settings?.sedes ?? [],
        companyValues: (settings?.company_values as string) ?? "",
        bookingUrl: (settings?.booking_url as string) ?? "",
      });
    }

    if (action === "upsertSearch") {
      const job = body.search as JobLike;
      if (!job?.id) return bad("Falta la búsqueda.");
      const { error } = await sb.from("searches").upsert(jobToRow(job));
      if (error) throw error;
      await bump("search", job.id, clientId);
      return Response.json({ ok: true });
    }

    if (action === "deleteSearch") {
      const id = String(body.id ?? "");
      if (!id) return bad("Falta el id.");
      const { error } = await sb.from("searches").delete().eq("id", id);
      if (error) throw error;
      await bump("search", id, clientId);
      return Response.json({ ok: true });
    }

    if (action === "upsertCandidates") {
      const searchId = String(body.searchId ?? "");
      const cands = (body.candidates as CandLike[]) ?? [];
      if (!searchId || !cands.length) return Response.json({ ok: true });
      const { error } = await sb.from("candidates").upsert(cands.map((c) => candToRow(searchId, c)));
      if (error) throw error;
      await bump("candidates", searchId, clientId);
      return Response.json({ ok: true });
    }

    if (action === "deleteCandidate") {
      const id = String(body.id ?? "");
      if (!id) return bad("Falta el id.");
      const { error } = await sb.from("candidates").delete().eq("id", id);
      if (error) throw error;
      await bump("candidate", null, clientId);
      return Response.json({ ok: true });
    }

    if (action === "patchCandidate") {
      const searchId = String(body.searchId ?? "");
      const cand = body.candidate as CandLike;
      if (!searchId || !cand?.id) return bad("Falta el candidato.");
      const { error } = await sb.from("candidates").upsert(candToRow(searchId, cand));
      if (error) throw error;
      await bump("candidate", searchId, clientId);
      return Response.json({ ok: true });
    }

    if (action === "saveSettings") {
      const { error } = await sb.from("app_settings").upsert({
        id: "default",
        sedes: body.sedes ?? [],
        company_values: (body.companyValues as string) ?? "",
        booking_url: (body.bookingUrl as string) ?? "",
        updated_at: nowIso(),
      });
      if (error) throw error;
      await bump("settings", null, clientId);
      return Response.json({ ok: true });
    }

    if (action === "migrate") {
      const jobs = (body.jobs as JobLike[]) ?? [];
      if (jobs.length) {
        const { error: e1 } = await sb.from("searches").upsert(jobs.map(jobToRow));
        if (e1) throw e1;
        const candRows: Row[] = [];
        for (const j of jobs) for (const c of j.candidates ?? []) candRows.push(candToRow(j.id, c));
        if (candRows.length) {
          const { error: e2 } = await sb.from("candidates").upsert(candRows);
          if (e2) throw e2;
        }
      }
      const { error: e3 } = await sb.from("app_settings").upsert({
        id: "default",
        sedes: body.sedes ?? [],
        company_values: (body.companyValues as string) ?? "",
        updated_at: nowIso(),
      });
      if (e3) throw e3;
      await bump("migrate", null, clientId);
      return Response.json({ ok: true, searches: jobs.length });
    }

    return bad("Acción desconocida.");
  } catch (err) {
    console.error("Error en /api/data:", err);
    const msg = err instanceof Error ? err.message : "Error al acceder a la base de datos.";
    return bad(msg, 502);
  }
}
