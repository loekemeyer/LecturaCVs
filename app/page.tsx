"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { Criterion, Evaluation } from "@/lib/types";

type CriterionDraft = { id: string; name: string; weight: number; description: string };
type Status = "nuevo" | "contactado" | "entrevistado" | "tomado" | "descartado";
type ScoreStatus = "pending" | "scoring" | "done" | "error";
// Calificación por color (triage rápido): primer nivel de clasificación.
type Calificacion = "sincalificar" | "preseleccionado" | "favorito" | "descartado";

type Candidate = {
  id: string;
  source: "gmail" | "upload";
  name: string;
  cvText?: string; // gmail: cuerpo del mail (re-evaluable)
  expectedSalary: string;
  date: string;
  emailUid?: number;
  status: Status;
  /** Calificación por color (triage). Si falta, se trata como "sincalificar". */
  calificacion?: Calificacion;
  scoreStatus: ScoreStatus;
  error?: string;
  evaluation?: Evaluation;
};

type JobFilters = {
  ageMin: string;
  ageMax: string;
  sex: "todos" | "masculino" | "femenino";
  maxDistance: string;
};

/** Sede laboral del perfil: una dirección reutilizable que se elige por búsqueda. */
type Sede = { id: string; label: string; address: string };

/** Aviso encontrado en Gmail durante el escaneo (antes de levantar los CVs). */
type Aviso = { title: string; count: number; uids: number[]; firstDate: string };

type Job = {
  id: string;
  title: string;
  firstDate: string;
  criteria: CriterionDraft[];
  offeredSalary: string;
  /** Tope superior del rango de sueldo ofrecido (si es rango). */
  offeredSalaryMax?: string;
  /** Si el sueldo ofrecido es un rango (desde/hasta) en vez de un valor fijo. */
  salaryRange?: boolean;
  jobContext: string;
  /** Texto del aviso de la búsqueda (pegado por el usuario). La IA lo usa para sugerir criterios. */
  posting?: string;
  /** Dirección libre (compat con versiones previas). Hoy se prefiere sedeId. */
  plantAddress?: string;
  /** Sede laboral elegida para esta búsqueda (id de una sede del perfil). */
  sedeId?: string;
  candidates: Candidate[];
  /** Preferencias de filtrado por búsqueda (edad/sexo/distancia varían según el caso). */
  filters?: JobFilters;
};

const STORAGE_KEY = "lecturacvs:ats:v1";
// Cuántos CVs se analizan en paralelo. Subirlo NO cuesta más (el costo es por
// tokens, no por tiempo): solo termina antes. Con reintento ante rate limit
// (ver scoreCvText) podemos correr varios a la vez sin que se marquen como error.
const CONCURRENCY = 6;
// Máximo de CVs que se analizan por tanda (para controlar tiempo y costo). Se
// importan todos, pero se evalúan de a 200 como mucho por vez.
const MAX_PER_RUN = 200;

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

// Calificaciones por color (triage). El orden es el del menú.
const CALIFICACIONES: { value: Calificacion; label: string; dot: string }[] = [
  { value: "sincalificar", label: "Sin calificar", dot: "🟠" },
  { value: "preseleccionado", label: "Preseleccionado", dot: "🟢" },
  { value: "favorito", label: "Favorito", dot: "🟢" },
  { value: "descartado", label: "Descartado", dot: "🔴" },
];
// Orden de los círculos para marcar rápido: naranja, rojo, verde claro, verde fuerte.
const CALIF_PICKER: Calificacion[] = ["sincalificar", "descartado", "preseleccionado", "favorito"];
const califOf = (c: Candidate): Calificacion => c.calificacion ?? "sincalificar";
const califLabel = (v: Calificacion) =>
  CALIFICACIONES.find((x) => x.value === v)?.label ?? "Sin calificar";

const DEFAULT_FILTERS: JobFilters = { ageMin: "", ageMax: "", sex: "todos", maxDistance: "" };

// ¿Hay algún filtro activo? (sirve para avisar cuántos candidatos quedan ocultos).
function filtersActive(f: JobFilters): boolean {
  return !!(f.ageMin || f.ageMax || f.maxDistance || f.sex !== "todos");
}

// Filtro tolerante: si al candidato le falta el dato (no figuraba en el CV), NO lo
// ocultamos; solo descartamos a quien claramente no cumple. Edad/sexo/distancia se usan
// para organizar la búsqueda, NO afectan el puntaje de mérito.
function passesFilters(c: Candidate, f: JobFilters): boolean {
  const ev = c.evaluation;
  if (f.sex !== "todos" && ev?.sex && ev.sex !== "no especificado" && ev.sex !== f.sex) return false;
  const age = ev?.age ?? null;
  if (age != null) {
    const min = f.ageMin ? Number(f.ageMin) : NaN;
    const max = f.ageMax ? Number(f.ageMax) : NaN;
    if (!Number.isNaN(min) && age < min) return false;
    if (!Number.isNaN(max) && age > max) return false;
  }
  const dist = ev?.distanceKm ?? null;
  if (dist != null && f.maxDistance) {
    const m = Number(f.maxDistance);
    if (!Number.isNaN(m) && dist > m) return false;
  }
  return true;
}

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
// Texto del sueldo ofrecido para mandar a la IA: valor fijo o rango "X a Y".
function offeredSalaryText(job: Job): string {
  const min = (job.offeredSalary || "").trim();
  const max = (job.offeredSalaryMax || "").trim();
  if (job.salaryRange && (min || max)) {
    if (min && max) return `${min} a ${max}`;
    if (min) return `desde ${min}`;
    return `hasta ${max}`;
  }
  return min;
}
function criteriaPayload(job: Job): Criterion[] {
  return job.criteria
    .filter((c) => c.name.trim() && c.weight > 0)
    .map(({ name, weight, description }) => ({ name, weight, description }));
}

export default function Home() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [sedes, setSedes] = useState<Sede[]>([]);
  const [companyValues, setCompanyValues] = useState("");
  const [activeTab, setActiveTab] = useState<string>(""); // job.id | "dashboard" | "perfil" | ""
  const [loaded, setLoaded] = useState(false);
  // Importar de Gmail: escaneo de avisos -> elegir -> levantar CVs.
  const [scanOpen, setScanOpen] = useState(false);
  const [scanMonths, setScanMonths] = useState(6);
  const [scanning, setScanning] = useState(false);
  const [scanResults, setScanResults] = useState<Aviso[] | null>(null);
  const [scanError, setScanError] = useState("");
  const [importingTitle, setImportingTitle] = useState<string | null>(null);
  const [toast, setToast] = useState("");
  const [evalProgress, setEvalProgress] = useState<{
    jobId: string;
    done: number;
    total: number;
  } | null>(null);
  const [pausing, setPausing] = useState(false);
  const [reevalFor, setReevalFor] = useState<string | null>(null);
  const [genCriteriaFor, setGenCriteriaFor] = useState<string | null>(null);
  // Cuántos CVs analizar al tocar "Evaluar": por defecto "Todos"; si se destilda,
  // se usa el número escrito en evalCount.
  const [evalAll, setEvalAll] = useState(true);
  const [evalCount, setEvalCount] = useState("");
  const [viewCv, setViewCv] = useState<{
    name: string;
    html?: string;
    text?: string;
    loading?: boolean;
  } | null>(null);
  const [openCand, setOpenCand] = useState<Set<string>>(new Set());
  const [califFilter, setCalifFilter] = useState<Calificacion | "todos">("todos");

  const jobsRef = useRef(jobs);
  useEffect(() => {
    jobsRef.current = jobs;
  }, [jobs]);
  const sedesRef = useRef(sedes);
  useEffect(() => {
    sedesRef.current = sedes;
  }, [sedes]);
  const companyValuesRef = useRef(companyValues);
  useEffect(() => {
    companyValuesRef.current = companyValues;
  }, [companyValues]);
  const fileRef = useRef<HTMLInputElement>(null);
  // Señal para pausar la evaluación en curso: los workers la leen antes de tomar
  // cada candidato. Es un ref (no estado) para que vean el valor más reciente sin
  // depender de re-renders.
  const cancelEvalRef = useRef(false);
  // Para avisar una sola vez si falla el guardado local (memoria del navegador).
  const saveWarnedRef = useRef(false);
  // Última pestaña que no es el perfil, para volver al cerrar "Mi perfil".
  const lastTabRef = useRef("");

  // Cargar
  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed.jobs)) {
          // Limpiamos restos de "Nueva búsqueda" vacías (de cuando existía el
          // botón manual): solo las que no tienen ningún candidato.
          const cleaned = (parsed.jobs as Job[]).filter(
            (j) => !(j.title === "Nueva búsqueda" && (j.candidates?.length ?? 0) === 0),
          );
          setJobs(cleaned);
          // Al entrar, arrancamos sin ninguna búsqueda abierta (pantalla limpia).
          setActiveTab("");
        }
        if (Array.isArray(parsed.sedes)) setSedes(parsed.sedes);
        if (typeof parsed.companyValues === "string") setCompanyValues(parsed.companyValues);
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
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ jobs, activeTab, sedes, companyValues }),
      );
      saveWarnedRef.current = false;
    } catch {
      // Suele ser cuota llena (muchos CVs con texto + evaluaciones). Avisamos una
      // sola vez para que no se pierdan datos sin que el usuario se entere.
      if (!saveWarnedRef.current) {
        saveWarnedRef.current = true;
        showToast(
          "No se pudo guardar en el navegador (puede estar lleno de tantos CVs). Para no perder datos, conviene evaluar en tandas más chicas.",
        );
      }
    }
  }, [jobs, activeTab, sedes, companyValues, loaded]);

  function showToast(msg: string) {
    setToast(msg);
    window.setTimeout(() => setToast(""), 6000);
  }

  // Recordamos la última pestaña que no es el perfil (para el botón "Mi perfil").
  useEffect(() => {
    if (activeTab !== "perfil") lastTabRef.current = activeTab;
  }, [activeTab]);

  // Botón "Mi perfil": abre el perfil o vuelve exactamente a donde estabas
  // (incluida la pantalla inicial vacía).
  function toggleProfile() {
    setActiveTab((cur) => (cur === "perfil" ? lastTabRef.current : "perfil"));
  }

  // ---------- helpers de estado ----------
  function patchJob(jobId: string, patch: Partial<Job>) {
    setJobs((prev) => prev.map((j) => (j.id === jobId ? { ...j, ...patch } : j)));
  }

  // ---------- sedes (perfil) ----------
  function addSede() {
    setSedes((prev) => [...prev, { id: genId(), label: "", address: "" }]);
  }
  function updateSede(id: string, patch: Partial<Sede>) {
    setSedes((prev) => prev.map((s) => (s.id === id ? { ...s, ...patch } : s)));
  }
  function removeSede(id: string) {
    setSedes((prev) => prev.filter((s) => s.id !== id));
    // Desasignamos la sede de las búsquedas que la usaban.
    setJobs((prev) => prev.map((j) => (j.sedeId === id ? { ...j, sedeId: undefined } : j)));
  }

  // Dirección efectiva de una búsqueda: la sede elegida; si no eligió y hay una
  // sola sede, esa por defecto; si no, la dirección libre vieja (compat).
  function resolveAddress(job: Job, list: Sede[] = sedesRef.current): string {
    if (job.sedeId) {
      const s = list.find((x) => x.id === job.sedeId);
      if (s?.address.trim()) return s.address.trim();
    }
    if (list.length === 1 && list[0].address.trim()) return list[0].address.trim();
    return (job.plantAddress || "").trim();
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

  // Analiza el texto del aviso con la IA y reemplaza los criterios de la búsqueda
  // por los sugeridos. El usuario después los edita a mano (agregar/sacar/peso).
  async function generateCriteria(jobId: string) {
    const job = jobsRef.current.find((j) => j.id === jobId);
    if (!job) return;
    const posting = (job.posting || "").trim();
    if (!posting) {
      showToast("Pegá el texto del aviso para que la IA sugiera los criterios.");
      return;
    }
    setGenCriteriaFor(jobId);
    try {
      const res = await fetch("/api/criteria", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          posting,
          title: job.title,
          companyValues: companyValuesRef.current,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || `Error ${res.status}`);
      const suggested: Criterion[] = Array.isArray(data.criteria) ? data.criteria : [];
      if (!suggested.length) throw new Error("La IA no devolvió criterios.");
      patchJob(jobId, {
        criteria: suggested.map((c) => ({
          id: genId(),
          name: c.name,
          weight: c.weight,
          description: c.description || "",
        })),
      });
      // Si ya había candidatos evaluados, ofrecemos re-evaluarlos con los nuevos criterios.
      if (job.candidates.some((c) => c.evaluation)) setReevalFor(jobId);
      showToast(
        `Listo: ${suggested.length} criterios sugeridos por la IA. Revisalos y ajustá lo que quieras.`,
      );
    } catch (e) {
      showToast(
        "No se pudieron sugerir criterios: " + (e instanceof Error ? e.message : "error"),
      );
    } finally {
      setGenCriteriaFor(null);
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
      filters: { ...DEFAULT_FILTERS },
    };
  }

  function setFilter(jobId: string, patch: Partial<JobFilters>) {
    setJobs((prev) =>
      prev.map((j) =>
        j.id === jobId ? { ...j, filters: { ...(j.filters ?? DEFAULT_FILTERS), ...patch } } : j,
      ),
    );
  }

  function deleteJob(jobId: string) {
    if (!confirm("¿Eliminar esta búsqueda y todos sus candidatos?")) return;
    setJobs((prev) => prev.filter((j) => j.id !== jobId));
    setActiveTab((prev) => (prev === jobId ? "" : prev));
  }

  // ---------- importar de Gmail (escaneo -> elegir aviso -> levantar CVs) ----------
  function openScanModal() {
    setScanOpen(true);
    setScanResults(null);
    setScanError("");
    void scanAvisos(scanMonths);
  }

  // Paso 1 (liviano): busca qué avisos hay en Gmail en el período elegido.
  async function scanAvisos(months: number) {
    setScanning(true);
    setScanError("");
    try {
      const res = await fetch("/api/inbox", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "scan", months }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || `Error ${res.status}`);
      setScanResults(Array.isArray(data.avisos) ? data.avisos : []);
    } catch (e) {
      setScanError(e instanceof Error ? e.message : "No se pudo buscar.");
      setScanResults(null);
    } finally {
      setScanning(false);
    }
  }

  // Paso 2: levanta los CVs SOLO del aviso elegido (acotado, no se cae por timeout).
  async function importAviso(aviso: Aviso) {
    setImportingTitle(aviso.title);
    setToast("");
    try {
      const res = await fetch("/api/inbox", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "import", uids: aviso.uids }),
      });
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
      let targetJobId = "";
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
          }
          // El aviso elegido es donde caen los CVs: nos quedamos con su id para
          // mostrarlo al terminar (sea nuevo o ya existente).
          targetJobId = job.id;
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

      if (targetJobId) setActiveTab(targetJobId);
      showToast(
        added > 0
          ? `Importados ${added} CV${added > 1 ? "s" : ""}${
              healed ? ` (y ${healed} actualizados)` : ""
            }. Tocá «Evaluar candidatos».`
          : healed > 0
            ? `Actualizados ${healed} CV${healed > 1 ? "s" : ""}. Ya podés tocar «Evaluar candidatos».`
            : "No se encontraron CVs nuevos en ese aviso.",
      );
      setScanOpen(false);
    } catch (e) {
      showToast("Error al importar: " + (e instanceof Error ? e.message : "desconocido"));
    } finally {
      setImportingTitle(null);
    }
  }

  // ---------- evaluación ----------
  async function scoreCvText(job: Job, cand: Candidate): Promise<Evaluation> {
    const fd = new FormData();
    fd.append("cvText", cand.cvText || "");
    fd.append("fileName", cand.name);
    fd.append("criteria", JSON.stringify(criteriaPayload(job)));
    fd.append("jobContext", job.jobContext || job.title);
    fd.append("offeredSalary", offeredSalaryText(job));
    fd.append("expectedSalary", cand.expectedSalary);
    fd.append("plantAddress", resolveAddress(job));
    fd.append("companyValues", companyValuesRef.current || "");
    // Reintentos ante errores transitorios (rate limit 429, sobrecarga 5xx y
    // cortes de red) con espera creciente: corriendo varios CVs en paralelo, un
    // pico momentáneo no debería marcar el CV como error.
    const RETRYABLE = new Set([429, 502, 503, 529]);
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await fetch("/api/score", { method: "POST", body: fd });
      } catch (e) {
        if (attempt < 4) {
          await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
          continue;
        }
        throw e instanceof Error ? e : new Error("Error de red al evaluar el CV.");
      }
      if (RETRYABLE.has(res.status) && attempt < 4) {
        await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
        continue;
      }
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || `Error ${res.status}`);
      return data as Evaluation;
    }
  }

  // Pide pausar la evaluación en curso. No corta los CVs que ya están en vuelo
  // (esos terminan), solo evita que los workers tomen nuevos candidatos.
  function pauseEval() {
    cancelEvalRef.current = true;
    setPausing(true);
  }

  // Decide cuántos analizar según el control "Todos / cantidad" y arranca.
  function startEvaluation(jobId: string) {
    if (evalAll) {
      // "Todos" = todos los pendientes, pero máximo 200 por tanda.
      evaluateJob(jobId, { limit: MAX_PER_RUN });
      return;
    }
    const n = parseInt(evalCount, 10);
    if (!n || n < 1) {
      showToast("Escribí cuántos CVs querés analizar, o tildá «Todos».");
      return;
    }
    evaluateJob(jobId, { limit: Math.min(n, MAX_PER_RUN) });
  }

  // reevaluateAll=false (uso normal y "retomar"): evalúa solo los que faltan
  // (pendientes o con error), dejando intactos los ya evaluados.
  // reevaluateAll=true (al cambiar criterios): re-evalúa a todos.
  // limit: tope de CVs a procesar en esta corrida (los más arriba de la lista).
  async function evaluateJob(
    jobId: string,
    opts: { reevaluateAll?: boolean; limit?: number } = {},
  ) {
    const { reevaluateAll = false, limit } = opts;
    if (evalProgress) {
      showToast("Ya hay un análisis en curso. Esperá a que termine o pausalo.");
      return;
    }
    const job = jobsRef.current.find((j) => j.id === jobId);
    if (!job) return;
    setReevalFor(null);
    if (!criteriaPayload(job).length) {
      showToast("Definí al menos un criterio con peso para esta búsqueda.");
      return;
    }
    let targets = job.candidates.filter(
      (c) =>
        c.cvText &&
        c.status !== "descartado" &&
        c.scoreStatus !== "scoring" &&
        (reevaluateAll || c.scoreStatus !== "done"),
    );
    if (typeof limit === "number" && limit > 0) targets = targets.slice(0, limit);
    if (!targets.length) {
      showToast(
        reevaluateAll
          ? "No hay candidatos para evaluar en esta búsqueda."
          : "Todos los candidatos con CV ya están evaluados.",
      );
      return;
    }
    // Resguardo de costo: confirmamos antes de tandas grandes para no gastar de
    // golpe por un click accidental.
    if (
      targets.length > 30 &&
      !window.confirm(
        `Vas a analizar ${targets.length} CVs con la IA. Cada uno tiene un costo. ¿Continuar?`,
      )
    ) {
      return;
    }
    cancelEvalRef.current = false;
    setPausing(false);
    setEvalProgress({ jobId, done: 0, total: targets.length });
    let i = 0;
    const worker = async () => {
      while (i < targets.length) {
        if (cancelEvalRef.current) break; // pausa pedida: no tomamos más candidatos
        const c = targets[i++];
        patchCandidate(jobId, c.id, { scoreStatus: "scoring", error: undefined });
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
    const wasPaused = cancelEvalRef.current;
    cancelEvalRef.current = false;
    setPausing(false);
    setEvalProgress(null);
    if (wasPaused) {
      const left =
        jobsRef.current
          .find((j) => j.id === jobId)
          ?.candidates.filter((c) => c.cvText && c.scoreStatus === "pending").length ?? 0;
      showToast(
        left > 0
          ? `Análisis pausado. Quedan ${left} sin evaluar; tocá «Evaluar candidatos» para retomar.`
          : "Análisis pausado.",
      );
    } else {
      const n = targets.length;
      const left =
        jobsRef.current
          .find((j) => j.id === jobId)
          ?.candidates.filter((c) => c.cvText && c.scoreStatus === "pending").length ?? 0;
      showToast(
        left > 0
          ? `Procesados ${n}. Quedan ${left} sin evaluar; tocá «Evaluar» de nuevo para la próxima tanda (máx. ${MAX_PER_RUN}).`
          : `Análisis terminado: ${n} CV${n > 1 ? "s" : ""} procesado${n > 1 ? "s" : ""}.`,
      );
    }
  }

  // Re-evalúa un solo candidato (útil para refrescar uno sin re-hacer la tanda).
  async function reevaluateOne(jobId: string, candId: string) {
    if (evalProgress) {
      showToast("Hay un análisis en curso; esperá a que termine.");
      return;
    }
    const job = jobsRef.current.find((j) => j.id === jobId);
    const cand = job?.candidates.find((c) => c.id === candId);
    if (!job || !cand || !cand.cvText) return;
    if (!criteriaPayload(job).length) {
      showToast("Definí al menos un criterio con peso para esta búsqueda.");
      return;
    }
    patchCandidate(jobId, candId, { scoreStatus: "scoring", error: undefined });
    try {
      const ev = await scoreCvText(job, cand);
      patchCandidate(jobId, candId, {
        evaluation: ev,
        scoreStatus: "done",
        name: ev.candidateName || cand.name,
      });
    } catch (e) {
      patchCandidate(jobId, candId, {
        scoreStatus: "error",
        error: e instanceof Error ? e.message : "Error",
      });
    }
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
          fd.append("offeredSalary", offeredSalaryText(job));
          fd.append("plantAddress", resolveAddress(job));
          fd.append("companyValues", companyValuesRef.current || "");
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

  const activeFilters = activeJob?.filters ?? DEFAULT_FILTERS;
  const rankedActive = activeJob ? rankedCandidates(activeJob) : [];
  // Filtro por color (calificación). "todos" muestra todo menos los descartados.
  const byCalif = rankedActive.filter((c) =>
    califFilter === "todos" ? califOf(c) !== "descartado" : califOf(c) === califFilter,
  );
  const shownActive = byCalif.filter((c) => passesFilters(c, activeFilters));
  const hiddenActive = byCalif.length - shownActive.length;
  const califCount = (v: Calificacion) => rankedActive.filter((c) => califOf(c) === v).length;

  return (
    <main className="page">
      <header className="appbar">
        <div className="brand">
          <span className="logo">CV</span>
          <div className="brand-text">
            <span className="brand-name">LecturaCVs</span>
            <span className="brand-tag">Pre-selección de candidatos con IA</span>
          </div>
        </div>
        <button
          className={`profile-btn${activeTab === "perfil" ? " active" : ""}`}
          onClick={toggleProfile}
          title="Mi perfil"
        >
          <span className="profile-btn-icon">👤</span>
          <span className="profile-btn-text">Mi perfil</span>
        </button>
      </header>

      {toast && <div className="toast">{toast}</div>}

      {/* Entrada (nada elegido): botón grande. No se muestran los avisos todavía. */}
      {activeTab === "" && (
        <div className="entry-cta">
          <button className="btn btn-primary btn-xl" onClick={openScanModal}>
            ⟳ {jobs.length === 0 ? "Importar de Gmail" : "Nueva búsqueda"}
          </button>
          {jobs.length === 0 && (
            <p className="empty" style={{ marginTop: 4 }}>
              Elegí uno de tus avisos de ZonaJobs y traé los CVs.
            </p>
          )}
        </div>
      )}

      {/* Con una búsqueda o el panel abierto: nombre + acciones a la derecha. */}
      {activeTab !== "" && activeTab !== "perfil" && (
        <div className="aviso-nav">
          <span className="aviso-current-name">
            {activeJob
              ? `${activeJob.title} · ${shortDate(activeJob.firstDate)}`
              : activeTab === "dashboard"
                ? "📊 Panel general"
                : ""}
          </span>
          <div className="aviso-nav-actions">
            <button className="btn btn-ghost tab-new-btn" onClick={openScanModal}>
              + Nueva búsqueda
            </button>
          </div>
        </div>
      )}

      {/* panel general */}
      {activeTab === "dashboard" && <Dashboard jobs={jobs} onStatus={patchCandidate} />}

      {/* mi perfil: sedes laborales + asignación por aviso */}
      {activeTab === "perfil" && (
        <Profile
          jobs={jobs}
          sedes={sedes}
          companyValues={companyValues}
          onCompanyValues={setCompanyValues}
          onBack={toggleProfile}
          onAddSede={addSede}
          onUpdateSede={updateSede}
          onRemoveSede={removeSede}
          onSetJobSede={(jobId, sedeId) => patchJob(jobId, { sedeId })}
          onOpenJob={(jobId) => setActiveTab(jobId)}
        />
      )}

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
            <div className="salary-mode">
              <label className={`salary-opt${!activeJob.salaryRange ? " on" : ""}`}>
                <input
                  type="radio"
                  checked={!activeJob.salaryRange}
                  onChange={() => patchJob(activeJob.id, { salaryRange: false, offeredSalaryMax: "" })}
                />
                Fijo
              </label>
              <label className={`salary-opt${activeJob.salaryRange ? " on" : ""}`}>
                <input
                  type="radio"
                  checked={!!activeJob.salaryRange}
                  onChange={() => patchJob(activeJob.id, { salaryRange: true })}
                />
                Rango
              </label>
            </div>
            {activeJob.salaryRange ? (
              <div className="salary-range">
                <input
                  type="text"
                  inputMode="numeric"
                  placeholder="Desde"
                  value={activeJob.offeredSalary}
                  onChange={(e) =>
                    patchJob(activeJob.id, { offeredSalary: formatMiles(e.target.value) })
                  }
                />
                <span className="salary-dash">a</span>
                <input
                  type="text"
                  inputMode="numeric"
                  placeholder="Hasta"
                  value={activeJob.offeredSalaryMax ?? ""}
                  onChange={(e) =>
                    patchJob(activeJob.id, { offeredSalaryMax: formatMiles(e.target.value) })
                  }
                />
              </div>
            ) : (
              <input
                type="text"
                inputMode="numeric"
                placeholder="Ej: 1.200.000"
                value={activeJob.offeredSalary}
                onChange={(e) =>
                  patchJob(activeJob.id, { offeredSalary: formatMiles(e.target.value) })
                }
                style={{ maxWidth: 240 }}
              />
            )}

            <label className="field" style={{ marginTop: 12 }}>
              Sede laboral de esta búsqueda
            </label>
            {sedes.length === 0 ? (
              <p className="field-hint">
                Todavía no cargaste sedes.{" "}
                <button className="linklike" onClick={() => setActiveTab("perfil")}>
                  Cargá tus direcciones en «Mi perfil»
                </button>{" "}
                para poder elegir una acá.
              </p>
            ) : (
              <>
                <select
                  className="sede-select"
                  value={activeJob.sedeId ?? (sedes.length === 1 ? sedes[0].id : "")}
                  onChange={(e) =>
                    patchJob(activeJob.id, { sedeId: e.target.value || undefined })
                  }
                >
                  {sedes.length !== 1 && <option value="">(elegí una sede)</option>}
                  {sedes.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.label?.trim() || s.address || "(sede sin nombre)"}
                    </option>
                  ))}
                </select>
                <p className="field-hint">
                  {sedes.length === 1
                    ? "Hay una sola sede, queda elegida por defecto. "
                    : ""}
                  Si el CV indica la dirección del candidato, la IA estima la distancia y el tiempo
                  de viaje hasta la sede (en transporte público y en auto).{" "}
                  <button className="linklike" onClick={() => setActiveTab("perfil")}>
                    Administrar sedes
                  </button>
                </p>
              </>
            )}

            <details className="criteria-box">
              <summary>Criterios y pesos de esta búsqueda</summary>
              <div style={{ marginTop: 12 }}>
                <div className="ai-criteria">
                  <p className="ai-criteria-hint">
                    Pegá el texto del aviso de la búsqueda y la IA va a proponer los criterios y sus
                    pesos según lo que pide ese puesto. Después podés agregar, sacar o editar lo que
                    quieras.
                  </p>
                  <textarea
                    className="posting-input"
                    rows={5}
                    placeholder="Pegá acá el aviso: descripción del puesto, requisitos, condiciones, zona, etc."
                    value={activeJob.posting || ""}
                    onChange={(e) => patchJob(activeJob.id, { posting: e.target.value })}
                  />
                  <button
                    className="btn btn-primary"
                    onClick={() => generateCriteria(activeJob.id)}
                    disabled={
                      genCriteriaFor === activeJob.id || !(activeJob.posting || "").trim()
                    }
                  >
                    {genCriteriaFor === activeJob.id ? (
                      <>
                        <span className="spinner" /> Analizando aviso…
                      </>
                    ) : (
                      "✨ Sugerir criterios con IA"
                    )}
                  </button>
                </div>
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

            {evalProgress?.jobId !== activeJob.id &&
              (() => {
                const pendientes = activeJob.candidates.filter(
                  (c) =>
                    c.cvText &&
                    c.status !== "descartado" &&
                    c.scoreStatus !== "done" &&
                    c.scoreStatus !== "scoring",
                ).length;
                return (
                  <div className="eval-scope">
                    <span className="eval-scope-label">¿Cuántos CVs analizar?</span>
                    <label className={`eval-scope-opt${evalAll ? " on" : ""}`}>
                      <input
                        type="checkbox"
                        checked={evalAll}
                        onChange={(e) => setEvalAll(e.target.checked)}
                      />
                      Todos
                    </label>
                    <input
                      type="number"
                      min={1}
                      max={MAX_PER_RUN}
                      className="eval-scope-input"
                      placeholder="cantidad"
                      value={evalCount}
                      onFocus={() => setEvalAll(false)}
                      onChange={(e) => {
                        setEvalCount(e.target.value);
                        setEvalAll(false);
                      }}
                    />
                    <span className="eval-scope-hint">
                      {pendientes} sin evaluar · máx. {MAX_PER_RUN} por tanda
                    </span>
                  </div>
                );
              })()}

            <div className="btn-row">
              {evalProgress?.jobId === activeJob.id ? (
                <>
                  <button className="btn btn-primary" disabled>
                    <span className="spinner" /> Analizando… {evalProgress.done}/{evalProgress.total}
                  </button>
                  <button className="btn btn-pause" onClick={pauseEval} disabled={pausing}>
                    {pausing ? (
                      <>
                        <span className="spinner" /> Pausando…
                      </>
                    ) : (
                      "⏸ Pausar análisis"
                    )}
                  </button>
                </>
              ) : (
                <button className="btn btn-primary" onClick={() => startEvaluation(activeJob.id)}>
                  {evalAll ? "Evaluar candidatos" : `Evaluar ${evalCount || "…"} candidatos`}
                </button>
              )}
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
                  <span className="spinner" />{" "}
                  {pausing ? "Pausando (termino los CVs en curso)…" : "Analizando candidatos…"}{" "}
                  {evalProgress.done} de {evalProgress.total}
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
                    evaluateJob(activeJob.id, { reevaluateAll: true });
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

            <div className="calif-filters">
              <button
                className={`calif-chip${califFilter === "todos" ? " on" : ""}`}
                onClick={() => setCalifFilter("todos")}
              >
                Todos
              </button>
              {CALIFICACIONES.map((k) => (
                <button
                  key={k.value}
                  className={`calif-chip cal-${k.value}${califFilter === k.value ? " on" : ""}`}
                  onClick={() => setCalifFilter(k.value)}
                >
                  <span className={`cal-dot cal-${k.value}`} /> {k.label} ({califCount(k.value)})
                </button>
              ))}
            </div>

            <div className="cand-filters">
              <span className="cf-title">Filtrar:</span>
              <label className="cf-field">
                Edad
                <input
                  type="number"
                  min={0}
                  placeholder="mín"
                  value={activeFilters.ageMin}
                  onChange={(e) => setFilter(activeJob.id, { ageMin: e.target.value })}
                />
                <span className="cf-dash">–</span>
                <input
                  type="number"
                  min={0}
                  placeholder="máx"
                  value={activeFilters.ageMax}
                  onChange={(e) => setFilter(activeJob.id, { ageMax: e.target.value })}
                />
              </label>
              <label className="cf-field">
                Sexo
                <select
                  value={activeFilters.sex}
                  onChange={(e) =>
                    setFilter(activeJob.id, { sex: e.target.value as JobFilters["sex"] })
                  }
                >
                  <option value="todos">Todos</option>
                  <option value="masculino">Masculino</option>
                  <option value="femenino">Femenino</option>
                </select>
              </label>
              <label className="cf-field">
                Dist. máx
                <input
                  type="number"
                  min={0}
                  placeholder="km"
                  value={activeFilters.maxDistance}
                  onChange={(e) => setFilter(activeJob.id, { maxDistance: e.target.value })}
                />
                <span className="cf-unit">km</span>
              </label>
              {filtersActive(activeFilters) && (
                <button
                  className="cf-clear"
                  onClick={() => setFilter(activeJob.id, { ...DEFAULT_FILTERS })}
                >
                  Limpiar
                </button>
              )}
            </div>
            {filtersActive(activeFilters) && (
              <p className="cf-note">
                Mostrando {shownActive.length} de {rankedActive.length}
                {hiddenActive > 0 ? ` · ${hiddenActive} ocultos por el filtro` : ""}. Los candidatos
                sin ese dato en el CV no se ocultan.
              </p>
            )}

            {activeJob.candidates.length === 0 ? (
              <p className="empty">Sin candidatos todavía en esta búsqueda.</p>
            ) : shownActive.length === 0 ? (
              <p className="empty">Ningún candidato coincide con el filtro.</p>
            ) : (
              <div style={{ marginTop: 12 }}>
                {shownActive.map((c, i) => (
                  <CandidateRow
                    key={c.id}
                    cand={c}
                    rank={i + 1}
                    open={openCand.has(c.id)}
                    onToggle={() => toggleCand(c.id)}
                    onStatus={(s) =>
                      patchCandidate(
                        activeJob.id,
                        c.id,
                        s === "descartado" ? { status: s, calificacion: "descartado" } : { status: s },
                      )
                    }
                    onCalif={(k) => patchCandidate(activeJob.id, c.id, { calificacion: k })}
                    onViewCv={openCv}
                    onReevaluate={() => reevaluateOne(activeJob.id, c.id)}
                  />
                ))}
              </div>
            )}
          </section>
        </>
      )}

      {scanOpen && (
        <div className="modal-overlay" onClick={() => setScanOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <strong>Importar de Gmail</strong>
              <button className="icon-btn" aria-label="Cerrar" onClick={() => setScanOpen(false)}>
                ×
              </button>
            </div>
            <div className="modal-body scan-body">
              <div className="scan-controls">
                <span className="scan-label">Avisos de los últimos</span>
                <select
                  className="sede-select scan-months"
                  value={scanMonths}
                  onChange={(e) => setScanMonths(Number(e.target.value))}
                >
                  <option value={3}>3 meses</option>
                  <option value={6}>6 meses</option>
                  <option value={12}>12 meses</option>
                </select>
                <button
                  className="btn btn-primary"
                  onClick={() => scanAvisos(scanMonths)}
                  disabled={scanning}
                >
                  {scanning ? (
                    <>
                      <span className="spinner" /> Buscando…
                    </>
                  ) : (
                    "Buscar avisos"
                  )}
                </button>
              </div>

              {scanError && <div className="error-box">{scanError}</div>}

              {scanning && !scanResults && (
                <p className="why" style={{ marginTop: 12 }}>
                  <span className="spinner" /> Buscando avisos en Gmail…
                </p>
              )}

              {scanResults && scanResults.length === 0 && (
                <p className="empty">No se encontraron avisos de ZonaJobs en ese período.</p>
              )}

              {scanResults && scanResults.length > 0 && (
                <div className="aviso-list">
                  <p className="field-hint" style={{ marginTop: 0 }}>
                    Elegí de qué aviso querés levantar los CVs:
                  </p>
                  {scanResults.map((a) => {
                    const existing = jobs.find(
                      (j) => norm(j.title) === norm(a.title) && j.candidates.length > 0,
                    );
                    return (
                      <div className="aviso-row" key={a.title}>
                        <div className="aviso-info">
                          <span className="aviso-title">{a.title}</span>
                          <span className="aviso-count">
                            {a.count} CV{a.count !== 1 ? "s" : ""}
                            {a.firstDate ? ` · primer CV ${shortDate(a.firstDate)}` : ""}
                          </span>
                        </div>
                        {existing ? (
                          existing.id === activeTab ? (
                            <button className="btn btn-open" disabled>
                              Abierto
                            </button>
                          ) : (
                            <button
                              className="btn btn-ghost"
                              onClick={() => {
                                setActiveTab(existing.id);
                                setScanOpen(false);
                              }}
                            >
                              Abrir
                            </button>
                          )
                        ) : (
                          <button
                            className="btn btn-primary"
                            onClick={() => importAviso(a)}
                            disabled={importingTitle !== null}
                          >
                            {importingTitle === a.title ? (
                              <>
                                <span className="spinner" /> Importando…
                              </>
                            ) : (
                              "Importar"
                            )}
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </div>
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
  onCalif,
  onViewCv,
  onReevaluate,
}: {
  cand: Candidate;
  rank: number;
  open: boolean;
  onToggle: () => void;
  onStatus: (s: Status) => void;
  onCalif: (k: Calificacion) => void;
  onViewCv: (c: { name: string; emailUid?: number; cvText?: string }) => void;
  onReevaluate: () => void;
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
            {ev?.age != null ? ` · ${ev.age} años` : ""}
            {ev?.distanceKm != null ? ` · a ${ev.distanceKm} km` : ""}
            {cand.expectedSalary ? ` · pretende ${cand.expectedSalary}` : ""}
            {cand.scoreStatus === "error" ? " · error al evaluar" : ""}
          </div>
        </div>
        <div className="cal-dots" role="group" aria-label="Calificación">
          {CALIF_PICKER.map((v) => {
            const active = califOf(cand) === v;
            return (
              <button
                key={v}
                type="button"
                className={`cal-pick cal-${v}${active ? " active" : ""}`}
                onClick={() => onCalif(v)}
                title={califLabel(v)}
                aria-label={califLabel(v)}
                aria-pressed={active}
              />
            );
          })}
        </div>
        <span className="chevron" onClick={onToggle}>
          ▾
        </span>
      </div>

      {open && (
        <div className="result-body">
          <div className="result-actions">
            {(cand.cvText || cand.emailUid != null) && (
              <button
                className="btn btn-ghost"
                onClick={() =>
                  onViewCv({ name: cand.name, emailUid: cand.emailUid, cvText: cand.cvText })
                }
              >
                📄 Ver CV completo
              </button>
            )}
            {cand.cvText && (
              <button
                className="btn btn-ghost"
                onClick={onReevaluate}
                disabled={cand.scoreStatus === "scoring"}
              >
                {cand.scoreStatus === "scoring" ? (
                  <>
                    <span className="spinner" /> Re-evaluando…
                  </>
                ) : (
                  "🔄 Re-evaluar"
                )}
              </button>
            )}
            <label className="proc-status">
              Estado:
              <select
                className={`status-select ${statusClass(cand.status)}`}
                value={cand.status}
                onChange={(e) => onStatus(e.target.value as Status)}
              >
                <option value="nuevo">Sin contactar</option>
                <option value="contactado">Contactado</option>
                <option value="entrevistado">Entrevistado</option>
                <option value="tomado">Tomado</option>
                <option value="descartado">Descartado</option>
              </select>
            </label>
          </div>
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
              {(ev.age != null ||
                ev.distanceKm != null ||
                ev.transitMinutes != null ||
                ev.driveMinutes != null ||
                ev.location ||
                (ev.sex && ev.sex !== "no especificado")) && (
                <div className="cand-meta">
                  {ev.age != null && <span>🎂 {ev.age} años</span>}
                  {ev.sex && ev.sex !== "no especificado" && (
                    <span>{ev.sex === "masculino" ? "♂ Masculino" : "♀ Femenino"}</span>
                  )}
                  {ev.location && <span>📍 {ev.location}</span>}
                  {ev.distanceKm != null && <span>📏 {ev.distanceKm} km de la sede</span>}
                  {ev.transitMinutes != null && <span>🚆 {ev.transitMinutes}′ en transporte</span>}
                  {ev.driveMinutes != null && <span>🚗 {ev.driveMinutes}′ en auto</span>}
                </div>
              )}
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

// Sugerencias de dirección con OpenStreetMap (Nominatim): gratis y sin API key.
async function fetchAddressSuggestions(q: string): Promise<{ display_name: string }[]> {
  const res = await fetch(
    `https://nominatim.openstreetmap.org/search?format=jsonv2&addressdetails=0&countrycodes=ar&limit=5&q=${encodeURIComponent(
      q,
    )}`,
    { headers: { "Accept-Language": "es" } },
  );
  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

// Input de dirección con autocompletado/confirmación. Sugerencias mientras se
// escribe; al elegir una, queda la dirección estandarizada.
function AddressInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [suggestions, setSuggestions] = useState<{ display_name: string }[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  function handleChange(v: string) {
    onChange(v);
    window.clearTimeout(timer.current);
    if (v.trim().length < 4) {
      setSuggestions([]);
      setOpen(false);
      return;
    }
    timer.current = window.setTimeout(async () => {
      setLoading(true);
      try {
        const list = await fetchAddressSuggestions(v);
        setSuggestions(list);
        setOpen(true);
      } catch {
        setSuggestions([]);
      } finally {
        setLoading(false);
      }
    }, 450);
  }

  function pick(s: { display_name: string }) {
    onChange(s.display_name);
    setOpen(false);
    setSuggestions([]);
  }

  return (
    <div className="addr-input" ref={boxRef}>
      <input
        type="text"
        placeholder="Ej: Cervantes 2868, CABA"
        value={value}
        onChange={(e) => handleChange(e.target.value)}
        onFocus={() => {
          if (suggestions.length) setOpen(true);
        }}
      />
      {open && (suggestions.length > 0 || loading) && (
        <div className="addr-suggestions">
          {loading && (
            <div className="addr-loading">
              <span className="spinner" /> Buscando…
            </div>
          )}
          {suggestions.map((s, i) => (
            <button
              key={i}
              type="button"
              className="addr-suggestion"
              onClick={() => pick(s)}
            >
              {s.display_name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function Profile({
  jobs,
  sedes,
  companyValues,
  onCompanyValues,
  onBack,
  onAddSede,
  onUpdateSede,
  onRemoveSede,
  onSetJobSede,
  onOpenJob,
}: {
  jobs: Job[];
  sedes: Sede[];
  companyValues: string;
  onCompanyValues: (v: string) => void;
  onBack: () => void;
  onAddSede: () => void;
  onUpdateSede: (id: string, patch: Partial<Sede>) => void;
  onRemoveSede: (id: string) => void;
  onSetJobSede: (jobId: string, sedeId: string | undefined) => void;
  onOpenJob: (jobId: string) => void;
}) {
  return (
    <>
      <button className="back-btn" onClick={onBack}>
        ← Volver
      </button>
      <section className="card">
        <div className="results-toolbar">
          <h2 style={{ margin: 0 }}>👤 Mi perfil</h2>
        </div>
        <h3 className="profile-h3" style={{ marginTop: 8 }}>
          Valores y cultura de la empresa
        </h3>
        <p className="field-hint" style={{ marginTop: 0 }}>
          Factores generales que aplican a <strong>todas</strong> las búsquedas (ej. estabilidad a
          largo plazo, posibilidad de progreso, trabajo en equipo). La IA los tiene en cuenta al
          evaluar cada candidato y los incluye al sugerir criterios desde un aviso.
        </p>
        <textarea
          className="posting-input"
          rows={4}
          placeholder="Ej: Buscamos gente con proyección de largo plazo, ganas de crecer dentro de la empresa, compromiso y buen trato con el equipo…"
          value={companyValues}
          onChange={(e) => onCompanyValues(e.target.value)}
        />
      </section>

      <section className="card">
        <div className="results-toolbar">
          <h2 style={{ margin: 0 }}>🏢 Sedes laborales</h2>
        </div>
        <p className="field-hint" style={{ marginTop: 0 }}>
          Cargá acá las direcciones de tus sedes. Después, en cada búsqueda, elegís a cuál
          corresponde para que la IA calcule distancia y tiempo de viaje de los candidatos.
        </p>
        {sedes.length === 0 ? (
          <p className="empty">Todavía no cargaste ninguna sede.</p>
        ) : (
          <div className="sede-list">
            {sedes.map((s) => (
              <div className="sede-row" key={s.id}>
                <label className="sede-field">
                  <span className="sede-flabel">Sede</span>
                  <input
                    type="text"
                    className="sede-label"
                    placeholder="Ej: Planta CABA"
                    value={s.label}
                    onChange={(e) => onUpdateSede(s.id, { label: e.target.value })}
                  />
                </label>
                <label className="sede-field sede-field-addr">
                  <span className="sede-flabel">Dirección</span>
                  <AddressInput
                    value={s.address}
                    onChange={(v) => onUpdateSede(s.id, { address: v })}
                  />
                </label>
                <button
                  className="icon-btn sede-del"
                  title="Eliminar sede"
                  onClick={() => onRemoveSede(s.id)}
                >
                  🗑
                </button>
              </div>
            ))}
          </div>
        )}
        <button className="btn btn-ghost" style={{ marginTop: 10 }} onClick={onAddSede}>
          + Agregar sede
        </button>
      </section>

      <section className="card">
        <h3 className="profile-h3" style={{ marginTop: 0 }}>
          Avisos publicados
        </h3>
        {jobs.length === 0 ? (
          <p className="empty">Todavía no hay búsquedas.</p>
        ) : (
          <div className="profile-jobs">
            {jobs.map((j) => (
              <div className="profile-job" key={j.id}>
                <button className="profile-job-title linklike" onClick={() => onOpenJob(j.id)}>
                  {j.title}
                </button>
                <select
                  className="sede-select"
                  value={j.sedeId ?? (sedes.length === 1 ? sedes[0].id : "")}
                  onChange={(e) => onSetJobSede(j.id, e.target.value || undefined)}
                  disabled={sedes.length === 0}
                >
                  {sedes.length === 0 ? (
                    <option value="">(sin sedes cargadas)</option>
                  ) : (
                    <>
                      {sedes.length !== 1 && <option value="">(elegí una sede)</option>}
                      {sedes.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.label?.trim() || s.address || "(sede sin nombre)"}
                        </option>
                      ))}
                    </>
                  )}
                </select>
              </div>
            ))}
          </div>
        )}
      </section>
    </>
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
              <span className="dash-name">
                {cand.name}
                {(cand.evaluation?.age != null || cand.evaluation?.distanceKm != null) && (
                  <small className="dash-sub">
                    {cand.evaluation?.age != null ? `${cand.evaluation.age} años` : ""}
                    {cand.evaluation?.age != null && cand.evaluation?.distanceKm != null
                      ? " · "
                      : ""}
                    {cand.evaluation?.distanceKm != null ? `${cand.evaluation.distanceKm} km` : ""}
                  </small>
                )}
              </span>
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
