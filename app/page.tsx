"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { Criterion, Evaluation } from "@/lib/types";

type CriterionDraft = { id: string; name: string; weight: number; description: string };
type Status = "nuevo" | "contactado" | "entrevistado" | "tomado" | "descartado";
type ScoreStatus = "pending" | "scoring" | "done" | "error";

type Candidate = {
  id: string;
  source: "gmail" | "upload";
  name: string;
  cvText?: string; // gmail: cuerpo del mail (re-evaluable)
  expectedSalary: string;
  date: string;
  emailUid?: number;
  status: Status;
  scoreStatus: ScoreStatus;
  error?: string;
  evaluation?: Evaluation;
};

type Job = {
  id: string;
  title: string;
  firstDate: string;
  criteria: CriterionDraft[];
  offeredSalary: string;
  jobContext: string;
  candidates: Candidate[];
};

const STORAGE_KEY = "lecturacvs:ats:v1";
const CONCURRENCY = 3;

const genId = () =>
  typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2);

const DEFAULT_CRITERIA: Omit<CriterionDraft, "id">[] = [
  {
    name: "Sueldo pretendido vs. ofrecido",
    weight: 30,
    description:
      "Si el candidato pretende un sueldo igual o menor al que ofrece la empresa, puntaje alto; cuanto más por encima, más bajo. Si falta algún dato de sueldo, puntaje neutral.",
  },
  {
    name: "Antigüedad en los últimos 3 trabajos",
    weight: 35,
    description:
      "Estabilidad laboral (relación de dependencia). Permanecer ~2 años o más en un puesto es buena señal, sobre todo en gente joven. Lo que baja el puntaje es tener varios empleos (2, 3 o más) de menos de 1 año cada uno (job hopping). No cuentes emprendimientos propios ni freelance.",
  },
  {
    name: "Sector privado (penaliza empleo estatal)",
    weight: 35,
    description:
      "Si su experiencia es principalmente en el Estado o sector público, el puntaje debe ser MUY bajo. Experiencia mayormente en empresas privadas = puntaje alto.",
  },
];

const STATUSES: { value: Status; label: string }[] = [
  { value: "nuevo", label: "Nuevo" },
  { value: "contactado", label: "Contactado" },
  { value: "entrevistado", label: "Entrevistado" },
  { value: "tomado", label: "Tomado" },
  { value: "descartado", label: "Descartado" },
];

const withIds = (list: Omit<CriterionDraft, "id">[]): CriterionDraft[] =>
  list.map((c) => ({ id: genId(), ...c }));
const norm = (s: string) => s.trim().toLowerCase();
const scoreClass = (s: number) => (s >= 75 ? "good" : s >= 50 ? "mid" : "low");
const toTen = (n: number) => {
  const v = Math.round(n) / 10;
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
};
const formatMiles = (value: string): string => {
  const d = (value || "").replace(/\D/g, "");
  return d ? d.replace(/\B(?=(\d{3})+(?!\d))/g, ".") : "";
};
function shortDate(iso: string): string {
  const d = new Date(iso);
  return isNaN(d.getTime()) ? "" : `${d.getDate()}/${d.getMonth() + 1}`;
}
function hace(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const days = Math.floor((Date.now() - d.getTime()) / 86400000);
  if (days <= 0) return "hoy";
  if (days === 1) return "ayer";
  if (days < 30) return `hace ${days} días`;
  const months = Math.floor(days / 30);
  if (months < 12) return months === 1 ? "hace 1 mes" : `hace ${months} meses`;
  const years = Math.floor(days / 365);
  return years === 1 ? "hace 1 año" : `hace ${years} años`;
}
function isSupportedFile(f: File): boolean {
  const t = (f.type || "").toLowerCase();
  if (t === "application/pdf" || t.startsWith("image/")) return true;
  const n = f.name.toLowerCase();
  return [".pdf", ".png", ".jpg", ".jpeg", ".webp", ".gif"].some((ext) => n.endsWith(ext));
}
function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("No se pudo leer la imagen."));
    };
    img.src = url;
  });
}
async function prepareUpload(file: File): Promise<{ blob: Blob; filename: string }> {
  const isPdf = file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
  if (isPdf) return { blob: file, filename: file.name };
  try {
    const img = await loadImage(file);
    const scale = Math.min(1, 1600 / Math.max(img.width, img.height));
    const w = Math.max(1, Math.round(img.width * scale));
    const h = Math.max(1, Math.round(img.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return { blob: file, filename: file.name };
    ctx.drawImage(img, 0, 0, w, h);
    const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, "image/jpeg", 0.85));
    if (!blob) return { blob: file, filename: file.name };
    return { blob, filename: file.name.replace(/\.[^.]+$/, "") + ".jpg" };
  } catch {
    return { blob: file, filename: file.name };
  }
}
function criteriaPayload(job: Job): Criterion[] {
  return job.criteria
    .filter((c) => c.name.trim() && c.weight > 0)
    .map(({ name, weight, description }) => ({ name, weight, description }));
}

export default function Home() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [activeTab, setActiveTab] = useState<string>(""); // job.id | "dashboard" | ""
  const [loaded, setLoaded] = useState(false);
  const [importing, setImporting] = useState(false);
  const [toast, setToast] = useState("");
  const [evalProgress, setEvalProgress] = useState<{
    jobId: string;
    done: number;
    total: number;
  } | null>(null);
  const [reevalFor, setReevalFor] = useState<string | null>(null);
  const [viewCv, setViewCv] = useState<{
    name: string;
    html?: string;
    text?: string;
    loading?: boolean;
  } | null>(null);
  const [openCand, setOpenCand] = useState<Set<string>>(new Set());

  const jobsRef = useRef(jobs);
  useEffect(() => {
    jobsRef.current = jobs;
  }, [jobs]);
  const fileRef = useRef<HTMLInputElement>(null);

  // Cargar
  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed.jobs)) {
          setJobs(parsed.jobs);
          setActiveTab(parsed.activeTab || parsed.jobs[0]?.id || "");
        }
      }
    } catch {
      /* ignorar */
    }
    setLoaded(true);
  }, []);

  // Guardar
  useEffect(() => {
    if (!loaded) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ jobs, activeTab }));
    } catch {
      /* ignorar */
    }
  }, [jobs, activeTab, loaded]);

  function showToast(msg: string) {
    setToast(msg);
    window.setTimeout(() => setToast(""), 6000);
  }

  // ---------- helpers de estado ----------
  function patchJob(jobId: string, patch: Partial<Job>) {
    setJobs((prev) => prev.map((j) => (j.id === jobId ? { ...j, ...patch } : j)));
  }
  function patchCandidate(jobId: string, candId: string, patch: Partial<Candidate>) {
    setJobs((prev) =>
      prev.map((j) =>
        j.id !== jobId
          ? j
          : { ...j, candidates: j.candidates.map((c) => (c.id === candId ? { ...c, ...patch } : c)) },
      ),
    );
  }
  function updateCriterion(jobId: string, critId: string, patch: Partial<CriterionDraft>) {
    setJobs((prev) =>
      prev.map((j) =>
        j.id !== jobId
          ? j
          : { ...j, criteria: j.criteria.map((c) => (c.id === critId ? { ...c, ...patch } : c)) },
      ),
    );
  }

  // Los criterios ya se guardan solos; este botón confirma y, si hay candidatos
  // puntuados, sugiere re-evaluarlos con los criterios nuevos.
  function saveCriteria(jobId: string) {
    const job = jobs.find((j) => j.id === jobId);
    if (job && job.candidates.some((c) => c.evaluation)) {
      setReevalFor(jobId);
    } else {
      showToast("Criterios guardados ✓");
    }
  }

  function newJob(title: string, firstDate: string): Job {
    return {
      id: genId(),
      title,
      firstDate,
      criteria: withIds(DEFAULT_CRITERIA),
      offeredSalary: "",
      jobContext: title,
      candidates: [],
    };
  }

  function addManualSearch() {
    const job = newJob("Nueva búsqueda", new Date().toISOString());
    setJobs((prev) => [...prev, job]);
    setActiveTab(job.id);
  }

  function deleteJob(jobId: string) {
    if (!confirm("¿Eliminar esta búsqueda y todos sus candidatos?")) return;
    setJobs((prev) => prev.filter((j) => j.id !== jobId));
    setActiveTab((prev) => (prev === jobId ? "" : prev));
  }

  // ---------- importar de Gmail ----------
  async function importFromGmail() {
    setImporting(true);
    setToast("");
    try {
      const res = await fetch("/api/inbox", { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || `Error ${res.status}`);
      const apps: {
        job: string;
        candidateName: string;
        expectedSalary: string;
        cvText: string;
        uid: number;
        date: string;
      }[] = data.applications || [];

      let added = 0;
      let healed = 0;
      let firstNewJobId = "";
      setJobs((prev) => {
        const next = prev.map((j) => ({ ...j, candidates: [...j.candidates] }));
        const byTitle = new Map(next.map((j) => [norm(j.title), j]));
        for (const app of apps) {
          const key = norm(app.job || "Sin búsqueda");
          let job = byTitle.get(key);
          if (!job) {
            job = newJob(app.job || "Sin búsqueda", app.date);
            next.push(job);
            byTitle.set(key, job);
            if (!firstNewJobId) firstNewJobId = job.id;
          }
          if (app.uid != null) {
            const idx = job.candidates.findIndex((c) => c.emailUid === app.uid);
            if (idx >= 0) {
              // Ya existe: refrescamos datos (ej. CV que antes vino vacío) sin perder
              // el estado ni la evaluación.
              const ex = job.candidates[idx];
              job.candidates[idx] = {
                ...ex,
                cvText: app.cvText || ex.cvText,
                name: ex.name && ex.name !== "Desconocido" ? ex.name : app.candidateName || ex.name,
                expectedSalary: ex.expectedSalary || app.expectedSalary || "",
              };
              healed++;
              continue;
            }
          }
          job.candidates.push({
            id: genId(),
            source: "gmail",
            name: app.candidateName || "Desconocido",
            cvText: app.cvText,
            expectedSalary: app.expectedSalary || "",
            date: app.date,
            emailUid: app.uid,
            status: "nuevo",
            scoreStatus: "pending",
          });
          if (app.date && app.date < job.firstDate) job.firstDate = app.date;
          added++;
        }
        return next;
      });

      if (firstNewJobId) setActiveTab((prev) => prev || firstNewJobId);
      showToast(
        added > 0
          ? `Importados ${added} CV${added > 1 ? "s" : ""}${
              healed ? ` (y ${healed} actualizados)` : ""
            }. Revisá las pestañas y tocá «Evaluar candidatos».`
          : healed > 0
            ? `Actualizados ${healed} CV${healed > 1 ? "s" : ""}. Ya podés tocar «Evaluar candidatos».`
            : "No se encontraron CVs nuevos en el correo.",
      );
    } catch (e) {
      showToast("Error al importar: " + (e instanceof Error ? e.message : "desconocido"));
    } finally {
      setImporting(false);
    }
  }

  // ---------- evaluación ----------
  async function scoreCvText(job: Job, cand: Candidate): Promise<Evaluation> {
    const fd = new FormData();
    fd.append("cvText", cand.cvText || "");
    fd.append("fileName", cand.name);
    fd.append("criteria", JSON.stringify(criteriaPayload(job)));
    fd.append("jobContext", job.jobContext || job.title);
    fd.append("offeredSalary", job.offeredSalary);
    fd.append("expectedSalary", cand.expectedSalary);
    const res = await fetch("/api/score", { method: "POST", body: fd });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error || `Error ${res.status}`);
    return data as Evaluation;
  }

  async function evaluateJob(jobId: string) {
    const job = jobsRef.current.find((j) => j.id === jobId);
    if (!job) return;
    setReevalFor(null);
    if (!criteriaPayload(job).length) {
      showToast("Definí al menos un criterio con peso para esta búsqueda.");
      return;
    }
    const targets = job.candidates.filter((c) => c.cvText && c.scoreStatus !== "scoring");
    if (!targets.length) {
      showToast("No hay candidatos para evaluar en esta búsqueda.");
      return;
    }
    targets.forEach((c) => patchCandidate(jobId, c.id, { scoreStatus: "scoring", error: undefined }));
    setEvalProgress({ jobId, done: 0, total: targets.length });
    let i = 0;
    const worker = async () => {
      while (i < targets.length) {
        const c = targets[i++];
        const current = jobsRef.current.find((j) => j.id === jobId) || job;
        try {
          const ev = await scoreCvText(current, c);
          patchCandidate(jobId, c.id, {
            evaluation: ev,
            scoreStatus: "done",
            name: ev.candidateName || c.name,
          });
        } catch (e) {
          patchCandidate(jobId, c.id, {
            scoreStatus: "error",
            error: e instanceof Error ? e.message : "Error",
          });
        }
        setEvalProgress((p) => (p && p.jobId === jobId ? { ...p, done: p.done + 1 } : p));
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, targets.length) }, () => worker()));
    setEvalProgress(null);
  }

  // ---------- subir archivo manual a una búsqueda ----------
  function addFilesToJob(jobId: string, list: FileList | File[]) {
    const supported = Array.from(list).filter(isSupportedFile);
    supported.forEach((file) => {
      const id = genId();
      const cand: Candidate = {
        id,
        source: "upload",
        name: file.name,
        expectedSalary: "",
        date: new Date().toISOString(),
        status: "nuevo",
        scoreStatus: "scoring",
      };
      setJobs((prev) =>
        prev.map((j) => (j.id === jobId ? { ...j, candidates: [...j.candidates, cand] } : j)),
      );
      (async () => {
        try {
          const job = jobsRef.current.find((j) => j.id === jobId);
          if (!job) return;
          const { blob, filename } = await prepareUpload(file);
          const fd = new FormData();
          fd.append("file", blob, filename);
          fd.append("criteria", JSON.stringify(criteriaPayload(job)));
          fd.append("jobContext", job.jobContext || job.title);
          fd.append("offeredSalary", job.offeredSalary);
          const res = await fetch("/api/score", { method: "POST", body: fd });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(data?.error || `Error ${res.status}`);
          patchCandidate(jobId, id, {
            evaluation: data,
            scoreStatus: "done",
            name: data.candidateName || file.name,
          });
        } catch (e) {
          patchCandidate(jobId, id, {
            scoreStatus: "error",
            error: e instanceof Error ? e.message : "Error",
          });
        }
      })();
    });
  }

  function toggleCand(id: string) {
    setOpenCand((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  // "Ver CV completo": para los de Gmail trae el correo original (con foto y formato);
  // si no, muestra el texto.
  async function openCv(c: { name: string; emailUid?: number; cvText?: string }) {
    if (c.emailUid == null) {
      setViewCv({ name: c.name, text: c.cvText || "Este candidato no tiene CV para mostrar." });
      return;
    }
    setViewCv({ name: c.name, loading: true });
    try {
      const res = await fetch("/api/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ uid: c.emailUid }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.html) setViewCv({ name: c.name, html: data.html });
      else
        setViewCv({ name: c.name, text: c.cvText || data.error || "No se pudo cargar el correo." });
    } catch {
      setViewCv({ name: c.name, text: c.cvText || "No se pudo cargar el correo." });
    }
  }

  // ---------- derivados ----------
  const activeJob = jobs.find((j) => j.id === activeTab) || null;
  const totalCandidates = useMemo(
    () => jobs.reduce((n, j) => n + j.candidates.length, 0),
    [jobs],
  );

  function rankedCandidates(job: Job): Candidate[] {
    return [...job.candidates].sort((a, b) => {
      const sa = a.evaluation?.overallScore ?? -1;
      const sb = b.evaluation?.overallScore ?? -1;
      return sb - sa;
    });
  }

  return (
    <main className="page">
      <header className="masthead">
        <div className="logo">CV</div>
        <div>
          <h1>LecturaCVs</h1>
          <p>Importá los CVs desde Gmail, organizalos por búsqueda y seguí a cada candidato.</p>
        </div>
      </header>

      <div className="toolbar">
        <button className="btn btn-primary" onClick={importFromGmail} disabled={importing}>
          {importing ? (
            <>
              <span className="spinner" /> Importando…
            </>
          ) : (
            "⟳ Importar de Gmail"
          )}
        </button>
        <button className="btn btn-ghost" onClick={addManualSearch}>
          + Nueva búsqueda
        </button>
      </div>
      {toast && <div className="toast">{toast}</div>}

      {/* pestañas */}
      <div className="tabs">
        {jobs.map((j) => (
          <button
            key={j.id}
            className={`tab${activeTab === j.id ? " active" : ""}`}
            onClick={() => setActiveTab(j.id)}
          >
            {j.title} · {shortDate(j.firstDate)}
            <span className="tab-count">{j.candidates.length}</span>
          </button>
        ))}
        {jobs.length > 0 && (
          <button
            className={`tab${activeTab === "dashboard" ? " active" : ""}`}
            onClick={() => setActiveTab("dashboard")}
          >
            📊 Panel general
          </button>
        )}
      </div>

      {/* vacío */}
      {jobs.length === 0 && (
        <div className="card">
          <p className="empty">
            Todavía no hay búsquedas. Tocá <strong>«Importar de Gmail»</strong> para traer los CVs
            de tus avisos de ZonaJobs, o creá una búsqueda manual.
          </p>
        </div>
      )}

      {/* panel general */}
      {activeTab === "dashboard" && <Dashboard jobs={jobs} onStatus={patchCandidate} />}

      {/* vista de una búsqueda */}
      {activeJob && (
        <>
          <section className="card">
            <div className="job-head">
              <input
                className="job-title"
                value={activeJob.title}
                onChange={(e) => patchJob(activeJob.id, { title: e.target.value })}
              />
              <span className="job-date">primer CV: {shortDate(activeJob.firstDate)}</span>
              <button
                className="icon-btn"
                title="Eliminar búsqueda"
                onClick={() => deleteJob(activeJob.id)}
              >
                🗑
              </button>
            </div>

            <label className="field" style={{ marginTop: 12 }}>
              Sueldo ofrecido por la empresa
            </label>
            <input
              type="text"
              inputMode="numeric"
              placeholder="Ej: 1.200.000"
              value={activeJob.offeredSalary}
              onChange={(e) => patchJob(activeJob.id, { offeredSalary: formatMiles(e.target.value) })}
              style={{ maxWidth: 240 }}
            />

            <details className="criteria-box">
              <summary>Criterios y pesos de esta búsqueda</summary>
              <div style={{ marginTop: 12 }}>
                {activeJob.criteria.map((c) => {
                  const total = activeJob.criteria.reduce(
                    (s, x) => s + (x.name.trim() && x.weight > 0 ? x.weight : 0),
                    0,
                  );
                  const pct = c.name.trim() && c.weight > 0 && total > 0 ? Math.round((c.weight / total) * 100) : 0;
                  return (
                    <div className="criterion" key={c.id}>
                      <input
                        type="text"
                        placeholder="Nombre del criterio"
                        value={c.name}
                        onChange={(e) => updateCriterion(activeJob.id, c.id, { name: e.target.value })}
                      />
                      <div className="weight-wrap">
                        <input
                          type="number"
                          min={0}
                          step={5}
                          value={c.weight}
                          onChange={(e) =>
                            updateCriterion(activeJob.id, c.id, {
                              weight: e.target.value === "" ? 0 : Math.max(0, Number(e.target.value)),
                            })
                          }
                        />
                        <div className="weight-pct">{pct}%</div>
                      </div>
                      <button
                        className="icon-btn"
                        title="Eliminar criterio"
                        onClick={() =>
                          patchJob(activeJob.id, {
                            criteria: activeJob.criteria.filter((x) => x.id !== c.id),
                          })
                        }
                      >
                        ×
                      </button>
                      <input
                        className="desc"
                        type="text"
                        placeholder="Descripción opcional"
                        value={c.description}
                        onChange={(e) =>
                          updateCriterion(activeJob.id, c.id, { description: e.target.value })
                        }
                      />
                    </div>
                  );
                })}
                <button
                  className="btn btn-ghost"
                  style={{ marginTop: 8 }}
                  onClick={() =>
                    patchJob(activeJob.id, {
                      criteria: [
                        ...activeJob.criteria,
                        { id: genId(), name: "", weight: 10, description: "" },
                      ],
                    })
                  }
                >
                  + Agregar criterio
                </button>
                <button
                  className="btn btn-primary"
                  style={{ marginTop: 8, marginLeft: 8 }}
                  onClick={() => saveCriteria(activeJob.id)}
                >
                  Guardar criterios
                </button>
              </div>
            </details>

            <div className="btn-row">
              <button
                className="btn btn-primary"
                onClick={() => evaluateJob(activeJob.id)}
                disabled={evalProgress?.jobId === activeJob.id}
              >
                {evalProgress?.jobId === activeJob.id ? (
                  <>
                    <span className="spinner" /> Analizando… {evalProgress.done}/{evalProgress.total}
                  </>
                ) : (
                  "Evaluar candidatos"
                )}
              </button>
              <button className="btn btn-ghost" onClick={() => fileRef.current?.click()}>
                + Agregar CV (archivo)
              </button>
              <input
                ref={fileRef}
                type="file"
                accept="application/pdf,.pdf,image/*,.png,.jpg,.jpeg,.webp"
                multiple
                style={{ display: "none" }}
                onChange={(e) => {
                  if (e.target.files && activeJob) addFilesToJob(activeJob.id, e.target.files);
                  e.target.value = "";
                }}
              />
            </div>

            {evalProgress && evalProgress.jobId === activeJob.id && (
              <div className="progress">
                <div className="progress-bar">
                  <span
                    style={{
                      width: `${Math.round(
                        (evalProgress.done / Math.max(1, evalProgress.total)) * 100,
                      )}%`,
                    }}
                  />
                </div>
                <div className="progress-label">
                  <span className="spinner" /> Analizando candidatos… {evalProgress.done} de{" "}
                  {evalProgress.total}
                </div>
              </div>
            )}
          </section>

          {reevalFor === activeJob.id && (
            <div className="reeval-banner">
              <span>
                Guardaste los criterios. ¿Re-evaluás los candidatos con los nuevos criterios?
              </span>
              <div className="reeval-actions">
                <button
                  className="btn btn-primary"
                  onClick={() => {
                    setReevalFor(null);
                    evaluateJob(activeJob.id);
                  }}
                >
                  Re-evaluar candidatos
                </button>
                <button className="btn btn-ghost" onClick={() => setReevalFor(null)}>
                  Ahora no
                </button>
              </div>
            </div>
          )}

          <section className="card">
            <div className="results-toolbar">
              <h2 style={{ margin: 0 }}>Candidatos</h2>
              <span className="count">{activeJob.candidates.length} en total</span>
            </div>
            {activeJob.candidates.length === 0 ? (
              <p className="empty">Sin candidatos todavía en esta búsqueda.</p>
            ) : (
              <div style={{ marginTop: 12 }}>
                {rankedCandidates(activeJob).map((c, i) => (
                  <CandidateRow
                    key={c.id}
                    cand={c}
                    rank={i + 1}
                    open={openCand.has(c.id)}
                    onToggle={() => toggleCand(c.id)}
                    onStatus={(s) => patchCandidate(activeJob.id, c.id, { status: s })}
                    onViewCv={openCv}
                  />
                ))}
              </div>
            )}
          </section>
        </>
      )}

      {viewCv && (
        <div className="modal-overlay" onClick={() => setViewCv(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <strong>{viewCv.name}</strong>
              <button className="icon-btn" aria-label="Cerrar" onClick={() => setViewCv(null)}>
                ×
              </button>
            </div>
            {viewCv.loading ? (
              <div className="modal-body">
                <span className="spinner" /> Cargando el correo…
              </div>
            ) : viewCv.html ? (
              <iframe className="modal-frame" sandbox="" srcDoc={viewCv.html} title="CV" />
            ) : (
              <pre className="modal-body">{viewCv.text}</pre>
            )}
          </div>
        </div>
      )}
    </main>
  );
}

function statusClass(s: Status) {
  return `st-${s}`;
}

function CandidateRow({
  cand,
  rank,
  open,
  onToggle,
  onStatus,
  onViewCv,
}: {
  cand: Candidate;
  rank: number;
  open: boolean;
  onToggle: () => void;
  onStatus: (s: Status) => void;
  onViewCv: (c: { name: string; emailUid?: number; cvText?: string }) => void;
}) {
  const ev = cand.evaluation;
  return (
    <div className={`result${open ? " open" : ""}`}>
      <div className="result-head">
        <span className="rank">#{rank}</span>
        {ev ? (
          <div className={`score-chip ${scoreClass(ev.overallScore)}`} onClick={onToggle}>
            {toTen(ev.overallScore)}
          </div>
        ) : (
          <div className="score-chip none" onClick={onToggle}>
            {cand.scoreStatus === "scoring" ? <span className="spinner" /> : "—"}
          </div>
        )}
        <div className="result-id" onClick={onToggle}>
          <div className="who">{cand.name}</div>
          <div className="file">
            {cand.source === "gmail" ? "ZonaJobs" : "Archivo"}
            {cand.date ? ` · se postuló ${hace(cand.date)}` : ""}
            {cand.expectedSalary ? ` · pretende ${cand.expectedSalary}` : ""}
            {cand.scoreStatus === "error" ? " · error al evaluar" : ""}
          </div>
        </div>
        <select
          className={`status-select ${statusClass(cand.status)}`}
          value={cand.status}
          onChange={(e) => onStatus(e.target.value as Status)}
        >
          {STATUSES.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
        {ev && (
          <span className={`badge ${ev.recommendation}`} onClick={onToggle}>
            {ev.recommendation}
          </span>
        )}
        <span className="chevron" onClick={onToggle}>
          ▾
        </span>
      </div>

      {open && (
        <div className="result-body">
          {(cand.cvText || cand.emailUid != null) && (
            <button
              className="btn btn-ghost"
              style={{ marginBottom: 8 }}
              onClick={() =>
                onViewCv({ name: cand.name, emailUid: cand.emailUid, cvText: cand.cvText })
              }
            >
              📄 Ver CV completo
            </button>
          )}
          {cand.scoreStatus === "error" && (
            <div className="error-box">{cand.error || "No se pudo evaluar."}</div>
          )}
          {!ev && cand.scoreStatus !== "error" && (
            <p className="why" style={{ marginTop: 8 }}>
              {cand.cvText
                ? "Todavía sin evaluar. Tocá «Evaluar candidatos» para puntuarlo."
                : "Este candidato no tiene CV en texto para mostrar."}
            </p>
          )}
          {ev && (
            <>
              {ev.summary && <p className="summary">{ev.summary}</p>}
              <h4>Puntaje por criterio</h4>
              {ev.criteria.map((cr) => (
                <div className="crit" key={cr.name}>
                  <div className="crit-top">
                    <span>
                      <span className="cname">{cr.name}</span>{" "}
                      <span className="cw">· peso {cr.weight}%</span>
                    </span>
                    <span className="cscore">{toTen(cr.score)}/10</span>
                  </div>
                  <div className="bar">
                    <span className={scoreClass(cr.score)} style={{ width: `${cr.score}%` }} />
                  </div>
                  <p className="why">{cr.justification}</p>
                </div>
              ))}
              {ev.strengths.length > 0 && (
                <>
                  <h4>Fortalezas</h4>
                  <div className="tags">
                    {ev.strengths.map((s, k) => (
                      <span className="tag pos" key={k}>
                        {s}
                      </span>
                    ))}
                  </div>
                </>
              )}
              {ev.concerns.length > 0 && (
                <>
                  <h4>Dudas / puntos faltantes</h4>
                  <div className="tags">
                    {ev.concerns.map((s, k) => (
                      <span className="tag neg" key={k}>
                        {s}
                      </span>
                    ))}
                  </div>
                </>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function Dashboard({
  jobs,
  onStatus,
}: {
  jobs: Job[];
  onStatus: (jobId: string, candId: string, patch: Partial<Candidate>) => void;
}) {
  const [filter, setFilter] = useState<Status | "todos">("todos");
  const rows = useMemo(() => {
    const all: { jobId: string; jobTitle: string; cand: Candidate }[] = [];
    for (const j of jobs) for (const c of j.candidates) all.push({ jobId: j.id, jobTitle: j.title, cand: c });
    all.sort((a, b) => (b.cand.evaluation?.overallScore ?? -1) - (a.cand.evaluation?.overallScore ?? -1));
    return all;
  }, [jobs]);
  const counts = useMemo(() => {
    const c: Record<string, number> = { todos: rows.length };
    for (const s of STATUSES) c[s.value] = 0;
    for (const r of rows) c[r.cand.status] = (c[r.cand.status] || 0) + 1;
    return c;
  }, [rows]);
  const shown = rows.filter((r) => filter === "todos" || r.cand.status === filter);

  return (
    <section className="card">
      <div className="results-toolbar">
        <h2 style={{ margin: 0 }}>📊 Panel general</h2>
        <span className="count">{rows.length} candidatos</span>
      </div>
      <div className="filters">
        <button className={`fchip${filter === "todos" ? " on" : ""}`} onClick={() => setFilter("todos")}>
          Todos ({counts.todos})
        </button>
        {STATUSES.map((s) => (
          <button
            key={s.value}
            className={`fchip ${statusClass(s.value)}${filter === s.value ? " on" : ""}`}
            onClick={() => setFilter(s.value)}
          >
            {s.label} ({counts[s.value] || 0})
          </button>
        ))}
      </div>
      {shown.length === 0 ? (
        <p className="empty">Sin candidatos en este filtro.</p>
      ) : (
        <div className="dash-table">
          <div className="dash-row dash-head">
            <span>Candidato</span>
            <span>Búsqueda</span>
            <span>Pretende</span>
            <span>Puntaje</span>
            <span>Estado</span>
          </div>
          {shown.map(({ jobId, jobTitle, cand }) => (
            <div className="dash-row" key={cand.id}>
              <span className="dash-name">{cand.name}</span>
              <span className="dash-job">{jobTitle}</span>
              <span>{cand.expectedSalary || "—"}</span>
              <span>
                {cand.evaluation ? (
                  <b className={`dash-score ${scoreClass(cand.evaluation.overallScore)}`}>
                    {toTen(cand.evaluation.overallScore)}
                  </b>
                ) : (
                  "—"
                )}
              </span>
              <select
                className={`status-select ${statusClass(cand.status)}`}
                value={cand.status}
                onChange={(e) => onStatus(jobId, cand.id, { status: e.target.value as Status })}
              >
                {STATUSES.map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </select>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
