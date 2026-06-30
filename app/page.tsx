"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createClient } from "@supabase/supabase-js";
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
  /** Etapa del tablero (columna kanban) en la que está. Vacío = todavía no está en el tablero. */
  stageId?: string;
  /** Notas libres del reclutador (entrevista, llamado, etc.). */
  notes?: string;
  /** Fecha/hora (ISO) en que se evaluó este CV con la IA. Sirve para el detalle de gasto por día. */
  evaluatedAt?: string;
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
type Sede = { id: string; label: string; address: string; confirmed?: boolean };

/** Aviso encontrado en Gmail durante el escaneo (antes de levantar los CVs). */
type Aviso = { title: string; count: number; uids: number[]; firstDate: string };

/** Etapa (columna) del tablero kanban de una búsqueda. */
type Stage = { id: string; label: string };

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
  /** Columnas (etapas) del tablero kanban de esta búsqueda. Si falta, se usan las de por defecto. */
  stages?: Stage[];
  /** Área del bot de WhatsApp a la que corresponde esta búsqueda (id de bot_areas). */
  botArea?: string;
};

const STORAGE_KEY = "lecturacvs:ats:v1";
const TOKEN_KEY = "lecturacvs:token";

// Cliente de Supabase SOLO para escuchar la "señal" de cambios en tiempo real.
// Usa la anon key (pública); por RLS no puede leer datos personales, solo la señal.
const RT_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const RT_ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const realtimeClient =
  RT_URL && RT_ANON ? createClient(RT_URL, RT_ANON, { auth: { persistSession: false } }) : null;
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
// Botones para marcar rápido la calificación: naranja, rojo, verde claro, verde
// fuerte. Llevan nombre para que se entienda y no se elija uno sin querer.
const CALIF_PICKER: { value: Calificacion; short: string }[] = [
  { value: "sincalificar", short: "Sin calif." },
  { value: "descartado", short: "Descartar" },
  { value: "preseleccionado", short: "Preselec." },
  { value: "favorito", short: "Favorito" },
];
const califOf = (c: Candidate): Calificacion => c.calificacion ?? "sincalificar";
const califLabel = (v: Calificacion) =>
  CALIFICACIONES.find((x) => x.value === v)?.label ?? "Sin calificar";

const DEFAULT_FILTERS: JobFilters = { ageMin: "", ageMax: "", sex: "todos", maxDistance: "" };

// Etapas (columnas) por defecto del tablero kanban, como en ZonaJobs.
const DEFAULT_STAGES: Stage[] = [
  { id: "preseleccionados", label: "Preseleccionados" },
  { id: "contactados", label: "Contactados" },
  { id: "entrevistados", label: "Entrevistados" },
  { id: "contratados", label: "Contratados" },
  { id: "descartados", label: "Descartados" },
];
const stagesOf = (job: Job): Stage[] => (job.stages?.length ? job.stages : DEFAULT_STAGES);

// Áreas fijas del bot de WhatsApp (coinciden con el selector 1-4).
const BOT_AREAS: { id: string; label: string }[] = [
  { id: "pasantia", label: "Pasantía Administrativa" },
  { id: "administracion", label: "Administración" },
  { id: "diseno", label: "Diseño Gráfico" },
  { id: "operario", label: "Operario" },
];

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
const MESES = [
  "enero", "febrero", "marzo", "abril", "mayo", "junio",
  "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre",
];
// "2026-06" -> "junio 2026"; "sin-fecha" -> "Sin fecha".
function fmtMonth(ym: string): string {
  if (ym === "sin-fecha") return "Sin fecha";
  const [y, m] = ym.split("-");
  return `${MESES[Number(m) - 1] ?? m} ${y}`;
}
// "2026-06-23" -> "23/06/2026"; "sin-fecha" -> "Sin fecha".
function fmtDay(d: string): string {
  if (d === "sin-fecha") return "Sin fecha";
  return `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}`;
}
// Pasa a minúsculas y quita acentos, para que la búsqueda sea tolerante (ej.
// "administracion" encuentra "Administración").
const stripAccents = (s: string) =>
  s.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();

// Clave de nombre tolerante al orden y la puntuación: "Alfonso, Noelia Pilar" y
// "Noelia Pilar Alfonso" dan la misma clave (para detectar duplicados).
const nameKey = (s: string) =>
  stripAccents(s || "")
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .sort()
    .join(" ");

// Estimaciones de costo del bot (US$ aprox.). IA = Anthropic; WhatsApp = Meta.
const BOT_COST = { answers: 0.005, excel: 0.01, waConversation: 0.034 };
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
  // Link de la página de reservas de Google (para que el candidato elija horario).
  const [bookingUrl, setBookingUrl] = useState("");
  const [activeTab, setActiveTab] = useState<string>(""); // job.id | "dashboard" | "perfil" | ""
  const [loaded, setLoaded] = useState(false);
  // Importar de Gmail: escaneo de avisos -> elegir -> levantar CVs.
  const [scanOpen, setScanOpen] = useState(false);
  const [scanMonths, setScanMonths] = useState(6);
  const [scanning, setScanning] = useState(false);
  const [scanResults, setScanResults] = useState<Aviso[] | null>(null);
  const [scanError, setScanError] = useState("");
  const [importingTitle, setImportingTitle] = useState<string | null>(null);
  const [importProg, setImportProg] = useState<{ done: number; total: number } | null>(null);
  const [toast, setToast] = useState("");
  // Candidatos a los que se les cambió la calificación recién: durante unos
  // segundos muestran "Deshacer" + cuenta regresiva en su fila (y quedan
  // visibles aunque el filtro los ocultaría). Guardamos su calificación previa
  // y el momento en que se cierra la ventana de deshacer.
  const [graceUndo, setGraceUndo] = useState<
    Record<string, { prev: Calificacion; until: number }>
  >({});
  const graceTimers = useRef<Record<string, number>>({});
  const GRACE_MS = 8000;
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
  const [candSearch, setCandSearch] = useState("");
  // Acceso por código (login). authReady = ya verificamos; authed = desbloqueado.
  const [authReady, setAuthReady] = useState(false);
  const [authed, setAuthed] = useState(false);
  const [codeChallenge, setCodeChallenge] = useState("");
  const [codeInput, setCodeInput] = useState("");
  const [authBusy, setAuthBusy] = useState(false);
  const [authErr, setAuthErr] = useState("");
  const [codeSentTo, setCodeSentTo] = useState("");
  const tokenRef = useRef("");
  // Gasto: costo estimado por CV (lo informa el server según el modelo) y cuántos
  // CVs se evaluaron en esta sesión (para el contador en vivo).
  const [costPerCv, setCostPerCv] = useState(0);
  const [evaluatedCount, setEvaluatedCount] = useState(0);
  // Comparador: ids de candidatos seleccionados + modal abierto.
  const [compareSel, setCompareSel] = useState<Set<string>>(new Set());
  const [compareOpen, setCompareOpen] = useState(false);
  // Vista de la búsqueda: lista (ranking) o tablero (kanban por etapas).
  const [boardView, setBoardView] = useState(false);
  // Pantalla con el detalle del gasto estimado (por día y por aviso).
  const [costDetailOpen, setCostDetailOpen] = useState(false);
  // Pestaña del detalle de gasto: CVs (LecturaCVs) o Bot.
  const [costTab, setCostTab] = useState<"cvs" | "bot">("cvs");
  // Sesiones del bot (para el gasto del bot). Se cargan al abrir el detalle.
  const [botSessions, setBotSessions] = useState<{ score: number | null; excel_score: number | null }[]>([]);
  // Compositor de mail abierto para un candidato (desde el tablero).
  const [mailCand, setMailCand] = useState<{ jobId: string; cand: Candidate } | null>(null);
  // Estado de conexión con Google Calendar.
  const [googleCal, setGoogleCal] = useState<{ connected: boolean; email: string }>({
    connected: false,
    email: "",
  });

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
  const bookingUrlRef = useRef(bookingUrl);
  useEffect(() => {
    bookingUrlRef.current = bookingUrl;
  }, [bookingUrl]);
  const fileRef = useRef<HTMLInputElement>(null);
  // Señal para pausar la evaluación en curso: los workers la leen antes de tomar
  // cada candidato. Es un ref (no estado) para que vean el valor más reciente sin
  // depender de re-renders.
  const cancelEvalRef = useRef(false);
  // Última pestaña que no es el perfil, para volver al cerrar "Mi perfil".
  const lastTabRef = useRef("");
  // Id único de esta pestaña: sirve para ignorar en tiempo real los cambios que
  // hago yo mismo (y no refrescar en eco).
  const clientIdRef = useRef<string>(genId());
  // Última "foto" sincronizada con la nube (para subir solo lo que cambió).
  const syncedRef = useRef<{
    searches: Map<string, string>;
    cands: Map<string, string>;
    settings: string;
  } | null>(null);
  const syncTimerRef = useRef<number | undefined>(undefined);
  // Datos viejos de este navegador detectados al entrar (para ofrecer subirlos).
  const [localMigration, setLocalMigration] = useState<{
    jobs: Job[];
    sedes: Sede[];
    companyValues: string;
    count: number;
  } | null>(null);

  // Cargar desde la nube (una sola vez, cuando ya hay sesión).
  useEffect(() => {
    if (!authed || loaded) return;
    (async () => {
      try {
        const res = await dataApi({ action: "load" });
        if (res.ok) {
          const data = await res.json();
          const jobsArr: Job[] = Array.isArray(data.jobs)
            ? (data.jobs as Job[]).filter(
                (j) => !(j.title === "Nueva búsqueda" && (j.candidates?.length ?? 0) === 0),
              )
            : [];
          const sedesArr: Sede[] = Array.isArray(data.sedes) ? data.sedes : [];
          const cv: string = typeof data.companyValues === "string" ? data.companyValues : "";
          const bk: string = typeof data.bookingUrl === "string" ? data.bookingUrl : "";
          setJobs(jobsArr);
          setActiveTab("");
          setSedes(sedesArr);
          setCompanyValues(cv);
          setBookingUrl(bk);
          syncedRef.current = buildSnapshot(jobsArr, sedesArr, cv, bk);
          // Nube vacía + datos viejos en este navegador => ofrecemos subirlos.
          if (jobsArr.length === 0) maybeOfferLocalMigration();
        }
      } catch {
        /* ignorar */
      } finally {
        setLoaded(true);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authed]);

  // Guardar: sube a la nube SOLO lo que cambió (con un retardo corto para agrupar
  // varias ediciones seguidas en menos llamadas).
  useEffect(() => {
    if (!loaded) return;
    window.clearTimeout(syncTimerRef.current);
    syncTimerRef.current = window.setTimeout(() => {
      void syncToCloud();
    }, 600);
    return () => window.clearTimeout(syncTimerRef.current);
  }, [jobs, sedes, companyValues, bookingUrl, loaded]);

  // Tiempo real: cuando otro usuario cambia algo, refrescamos desde la nube.
  useEffect(() => {
    if (!authed || !realtimeClient) return;
    const ch = realtimeClient
      .channel("lcv-signal")
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "realtime_signal" },
        (payload) => {
          const who = (payload.new as { client_id?: string })?.client_id;
          if (who && who === clientIdRef.current) return; // cambio mío: ya lo tengo
          void refetchFromCloud();
        },
      )
      .subscribe();
    return () => {
      realtimeClient.removeChannel(ch);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authed]);

  // Estado de Google Calendar al iniciar sesión.
  useEffect(() => {
    if (authed) void refreshGoogleStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authed]);

  // Vuelta de la conexión con Google (?google=connected|error).
  useEffect(() => {
    const g = new URLSearchParams(window.location.search).get("google");
    if (!g) return;
    showToast(
      g === "connected"
        ? "Google Calendar conectado ✓"
        : "No se pudo conectar Google Calendar. Probá de nuevo.",
    );
    window.history.replaceState({}, "", window.location.pathname);
    if (g === "connected") void refreshGoogleStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function showToast(msg: string) {
    setToast(msg);
    window.setTimeout(() => setToast(""), 6000);
  }

  // ---------- acceso por código (login) ----------
  function authHeaders(): Record<string, string> {
    return tokenRef.current ? { "x-app-token": tokenRef.current } : {};
  }
  // Si una llamada vuelve 401, la sesión venció: volvemos al login.
  function onAuthFail() {
    tokenRef.current = "";
    try {
      localStorage.removeItem(TOKEN_KEY);
    } catch {
      /* ignorar */
    }
    setAuthed(false);
    setCodeChallenge("");
    setCodeSentTo("");
  }
  // Cerrar sesión a propósito (desde "Mi perfil"): vuelve a pedir el código.
  function logout() {
    onAuthFail();
    setActiveTab("");
    setCodeInput("");
    setAuthErr("");
  }

  // ---------- sincronización con la nube (Supabase) ----------
  async function dataApi(payload: Record<string, unknown>): Promise<Response> {
    const res = await fetch("/api/data", {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders() },
      body: JSON.stringify({ ...payload, clientId: clientIdRef.current }),
    });
    if (res.status === 401) onAuthFail();
    return res;
  }

  // "Foto" del estado para comparar contra lo último subido (clave -> JSON).
  function buildSnapshot(jobsArr: Job[], sedesArr: Sede[], cv: string, bk: string) {
    const searches = new Map<string, string>();
    const cands = new Map<string, string>();
    for (const j of jobsArr) {
      const { candidates, ...meta } = j;
      searches.set(j.id, JSON.stringify(meta));
      for (const c of candidates) cands.set(c.id, JSON.stringify({ s: j.id, c }));
    }
    return { searches, cands, settings: JSON.stringify({ sedes: sedesArr, cv, bk }) };
  }

  // Sube a la nube SOLO lo que cambió desde la última sincronización.
  async function syncToCloud() {
    const jobsArr = jobsRef.current;
    const cur = buildSnapshot(
      jobsArr,
      sedesRef.current,
      companyValuesRef.current,
      bookingUrlRef.current,
    );
    const prev = syncedRef.current;
    syncedRef.current = cur; // marcamos ya, para no reenviar en paralelo
    try {
      const jobById = new Map(jobsArr.map((j) => [j.id, j]));
      // Búsquedas nuevas o cambiadas (sin candidatos).
      for (const [id, json] of cur.searches) {
        if (!prev || prev.searches.get(id) !== json) {
          const j = jobById.get(id);
          if (!j) continue;
          const { candidates: _drop, ...meta } = j;
          await dataApi({ action: "upsertSearch", search: meta });
        }
      }
      // Búsquedas borradas.
      if (prev) {
        for (const id of prev.searches.keys()) {
          if (!cur.searches.has(id)) await dataApi({ action: "deleteSearch", id });
        }
      }
      // Candidatos nuevos o cambiados, agrupados por búsqueda.
      const changedBySearch = new Map<string, Candidate[]>();
      for (const j of jobsArr) {
        for (const c of j.candidates) {
          const json = JSON.stringify({ s: j.id, c });
          if (!prev || prev.cands.get(c.id) !== json) {
            const list = changedBySearch.get(j.id) ?? [];
            list.push(c);
            changedBySearch.set(j.id, list);
          }
        }
      }
      for (const [searchId, list] of changedBySearch) {
        await dataApi({ action: "upsertCandidates", searchId, candidates: list });
      }
      // Candidatos borrados (estaban antes y ya no están).
      if (prev) {
        for (const id of prev.cands.keys()) {
          if (!cur.cands.has(id)) await dataApi({ action: "deleteCandidate", id });
        }
      }
      // Ajustes (sedes + valores de empresa).
      if (!prev || prev.settings !== cur.settings) {
        await dataApi({
          action: "saveSettings",
          sedes: sedesRef.current,
          companyValues: companyValuesRef.current,
          bookingUrl: bookingUrlRef.current,
        });
      }
    } catch {
      // Si algo falla, reintentamos en el próximo cambio (no perdemos el dato local).
      syncedRef.current = prev;
    }
  }

  // Trae todo desde la nube y refresca la "foto" (para no re-subir lo que llegó).
  async function refetchFromCloud() {
    try {
      const res = await dataApi({ action: "load" });
      if (!res.ok) return;
      const data = await res.json();
      const jobsArr: Job[] = Array.isArray(data.jobs) ? data.jobs : [];
      const sedesArr: Sede[] = Array.isArray(data.sedes) ? data.sedes : [];
      const cv: string = typeof data.companyValues === "string" ? data.companyValues : "";
      const bk: string = typeof data.bookingUrl === "string" ? data.bookingUrl : "";
      syncedRef.current = buildSnapshot(jobsArr, sedesArr, cv, bk);
      setJobs(jobsArr);
      setSedes(sedesArr);
      setCompanyValues(cv);
      setBookingUrl(bk);
    } catch {
      /* ignorar */
    }
  }

  // Detecta datos viejos guardados en ESTE navegador (de la versión sin nube).
  function maybeOfferLocalMigration() {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (!saved) return;
      const parsed = JSON.parse(saved);
      const jobsArr: Job[] = Array.isArray(parsed.jobs) ? parsed.jobs : [];
      if (jobsArr.length === 0) return;
      const count = jobsArr.reduce((n, j) => n + (j.candidates?.length ?? 0), 0);
      setLocalMigration({
        jobs: jobsArr,
        sedes: Array.isArray(parsed.sedes) ? parsed.sedes : [],
        companyValues: typeof parsed.companyValues === "string" ? parsed.companyValues : "",
        count,
      });
    } catch {
      /* ignorar */
    }
  }

  // Sube a la nube los datos de este navegador y recarga desde la nube.
  async function uploadLocalToCloud() {
    if (!localMigration) return;
    const res = await dataApi({
      action: "migrate",
      jobs: localMigration.jobs,
      sedes: localMigration.sedes,
      companyValues: localMigration.companyValues,
    });
    if (res.ok) {
      setLocalMigration(null);
      await refetchFromCloud();
      showToast("Listo: tus datos quedaron en la nube y ahora se ven en cualquier PC.");
    } else {
      showToast("No se pudieron subir los datos. Reintentá en un momento.");
    }
  }

  // Chequeo inicial: ¿hace falta código? ¿el token guardado sigue válido?
  useEffect(() => {
    let stored = "";
    try {
      stored = localStorage.getItem(TOKEN_KEY) || "";
    } catch {
      /* ignorar */
    }
    tokenRef.current = stored;
    fetch("/api/auth", { headers: stored ? { "x-app-token": stored } : {} })
      .then((r) => r.json())
      .then((d) => {
        setCostPerCv(Number(d?.costPerCv) || 0);
        setCodeSentTo(d?.email || "");
        if (!d?.required || d?.valid) {
          setAuthed(true);
        } else {
          onAuthFail();
        }
      })
      .catch(() => setAuthed(true)) // si el chequeo falla, no bloqueamos la app
      .finally(() => setAuthReady(true));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function requestCode() {
    setAuthBusy(true);
    setAuthErr("");
    try {
      const res = await fetch("/api/auth", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "request" }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || "No se pudo enviar el código.");
      setCodeChallenge(data.challenge || "");
      if (data.sentTo) setCodeSentTo(data.sentTo);
    } catch (e) {
      setAuthErr(e instanceof Error ? e.message : "No se pudo enviar el código.");
    } finally {
      setAuthBusy(false);
    }
  }

  async function submitCode() {
    setAuthBusy(true);
    setAuthErr("");
    try {
      const res = await fetch("/api/auth", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "verify", code: codeInput.trim(), challenge: codeChallenge }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data?.token) throw new Error(data?.error || "Código inválido o vencido.");
      tokenRef.current = data.token;
      try {
        localStorage.setItem(TOKEN_KEY, data.token);
      } catch {
        /* ignorar */
      }
      setAuthed(true);
      setCodeInput("");
      setCodeChallenge("");
    } catch (e) {
      setAuthErr(e instanceof Error ? e.message : "Código inválido o vencido.");
    } finally {
      setAuthBusy(false);
    }
  }

  // Cambia la calificación pero deja al candidato unos segundos con "Deshacer" +
  // cuenta regresiva en su fila (visible aunque el filtro lo ocultaría). Así
  // cualquier toque sin querer tiene vuelta atrás.
  function setCalifWithUndo(jobId: string, candId: string, prev: Calificacion, next: Calificacion) {
    const extra: Partial<Candidate> = { calificacion: next };
    // Sincronización lista ↔ tablero: el tablero muestra a los Preseleccionados y
    // Favoritos. Al marcar una de esas condiciones, el candidato entra (1ª etapa si
    // no tiene). Al quitarla (Sin calif / Descartado), sale del tablero.
    if (next === "preseleccionado" || next === "favorito") {
      const job = jobsRef.current.find((j) => j.id === jobId);
      const cand = job?.candidates.find((c) => c.id === candId);
      if (job && cand && !cand.stageId) {
        extra.stageId = stagesOf(job)[0].id;
        if (!job.stages?.length) patchJob(jobId, { stages: DEFAULT_STAGES });
      }
    } else {
      extra.stageId = undefined;
    }
    patchCandidate(jobId, candId, extra);
    setGraceUndo((g) => ({ ...g, [candId]: { prev, until: Date.now() + GRACE_MS } }));
    if (graceTimers.current[candId]) window.clearTimeout(graceTimers.current[candId]);
    graceTimers.current[candId] = window.setTimeout(() => {
      setGraceUndo((g) => {
        const { [candId]: _drop, ...rest } = g;
        return rest;
      });
      delete graceTimers.current[candId];
    }, GRACE_MS);
  }

  // Cierra la ventana de deshacer ya (sin esperar el countdown): confirma el
  // cambio y saca la fila del estado "pendiente".
  function clearGrace(candId: string) {
    if (graceTimers.current[candId]) window.clearTimeout(graceTimers.current[candId]);
    delete graceTimers.current[candId];
    setGraceUndo((g) => {
      const { [candId]: _drop, ...rest } = g;
      return rest;
    });
  }

  function undoCalif(jobId: string, candId: string) {
    const prev = graceUndo[candId]?.prev ?? "sincalificar";
    clearGrace(candId);
    patchCandidate(jobId, candId, { calificacion: prev });
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

  // ---------- tablero (kanban) ----------
  function moveCandidateToStage(jobId: string, candId: string, stageId: string) {
    patchCandidate(jobId, candId, { stageId });
  }
  function removeFromBoard(jobId: string, candId: string) {
    // Sacar del tablero = quitarle la condición (vuelve a "Sin calificar" en la Lista).
    patchCandidate(jobId, candId, { stageId: undefined, calificacion: "sincalificar" });
  }
  function addStage(jobId: string) {
    const name = window.prompt("Nombre de la nueva etapa:");
    if (!name?.trim()) return;
    const job = jobsRef.current.find((j) => j.id === jobId);
    if (!job) return;
    patchJob(jobId, { stages: [...stagesOf(job), { id: genId(), label: name.trim() }] });
  }
  function renameStage(jobId: string, stageId: string, current: string) {
    const name = window.prompt("Nuevo nombre de la etapa:", current);
    if (!name?.trim()) return;
    const job = jobsRef.current.find((j) => j.id === jobId);
    if (!job) return;
    patchJob(jobId, {
      stages: stagesOf(job).map((s) => (s.id === stageId ? { ...s, label: name.trim() } : s)),
    });
  }
  function deleteStage(jobId: string, stageId: string) {
    const job = jobsRef.current.find((j) => j.id === jobId);
    if (!job) return;
    const stages = stagesOf(job);
    if (stages.length <= 1) {
      showToast("Tiene que quedar al menos una etapa en el tablero.");
      return;
    }
    const inStage = job.candidates.filter((c) => c.stageId === stageId).length;
    if (
      !window.confirm(
        `¿Borrar esta etapa?${
          inStage > 0 ? ` Sus ${inStage} candidato(s) salen del tablero (no se borran).` : ""
        }`,
      )
    )
      return;
    setJobs((prev) =>
      prev.map((j) =>
        j.id !== jobId
          ? j
          : {
              ...j,
              stages: stagesOf(j).filter((s) => s.id !== stageId),
              candidates: j.candidates.map((c) =>
                c.stageId === stageId ? { ...c, stageId: undefined } : c,
              ),
            },
      ),
    );
  }
  function moveStage(jobId: string, stageId: string, dir: -1 | 1) {
    const job = jobsRef.current.find((j) => j.id === jobId);
    if (!job) return;
    const stages = [...stagesOf(job)];
    const i = stages.findIndex((s) => s.id === stageId);
    const k = i + dir;
    if (i < 0 || k < 0 || k >= stages.length) return;
    [stages[i], stages[k]] = [stages[k], stages[i]];
    patchJob(jobId, { stages });
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

  // ---------- copia de seguridad (export / import) ----------
  // Los datos viven solo en este navegador; la copia permite no perderlos y
  // moverlos a otra compu.
  function exportBackup() {
    const data = {
      app: "LecturaCVs",
      version: 1,
      exportedAt: new Date().toISOString(),
      jobs: jobsRef.current,
      sedes: sedesRef.current,
      companyValues: companyValuesRef.current,
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `lecturacvs-copia-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  async function importBackup(file: File) {
    try {
      const data = JSON.parse(await file.text());
      if (!data || !Array.isArray(data.jobs)) {
        showToast("El archivo no parece una copia válida de LecturaCVs.");
        return;
      }
      const cands = (data.jobs as Job[]).reduce((n, j) => n + (j.candidates?.length ?? 0), 0);
      const ok = window.confirm(
        `Esto va a REEMPLAZAR todos tus datos actuales por los de la copia ` +
          `(${data.jobs.length} búsquedas, ${cands} candidatos). ¿Continuar?`,
      );
      if (!ok) return;
      setJobs(data.jobs);
      if (Array.isArray(data.sedes)) setSedes(data.sedes);
      if (typeof data.companyValues === "string") setCompanyValues(data.companyValues);
      setActiveTab("");
      showToast("Copia restaurada con éxito.");
    } catch {
      showToast("No se pudo leer el archivo de copia.");
    }
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

  // Borra un candidato de la búsqueda (y de la nube, vía la sincronización).
  function deleteCandidate(jobId: string, candId: string) {
    if (!window.confirm("¿Borrar este candidato? No se puede deshacer.")) return;
    setJobs((prev) =>
      prev.map((j) =>
        j.id !== jobId ? j : { ...j, candidates: j.candidates.filter((c) => c.id !== candId) },
      ),
    );
    showToast("Candidato borrado.");
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
        headers: { "content-type": "application/json", ...authHeaders() },
        body: JSON.stringify({
          posting,
          title: job.title,
          companyValues: companyValuesRef.current,
        }),
      });
      if (res.status === 401) onAuthFail();
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

  // Crear una búsqueda a mano (para avisos de otras plataformas que no llegan al
  // mail). Después se le suben los CVs con «+ Agregar CV (archivo)».
  function createManualJob() {
    const title = window.prompt("Nombre de la nueva búsqueda (aviso):");
    if (!title?.trim()) return;
    const j = newJob(title.trim(), new Date().toISOString());
    setJobs((prev) => [...prev, j]);
    setActiveTab(j.id);
    showToast("Búsqueda creada. Cargá los CVs con «+ Agregar CV (archivo)».");
  }

  // Paso 1 (liviano): busca qué avisos hay en Gmail en el período elegido.
  async function scanAvisos(months: number) {
    setScanning(true);
    setScanError("");
    try {
      const res = await fetch("/api/inbox", {
        method: "POST",
        headers: { "content-type": "application/json", ...authHeaders() },
        body: JSON.stringify({ action: "scan", months }),
      });
      if (res.status === 401) onAuthFail();
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
    setImportProg({ done: 0, total: aviso.uids.length });
    setToast("");
    try {
      type App = {
        job: string;
        candidateName: string;
        expectedSalary: string;
        cvText: string;
        uid: number;
        date: string;
      };
      // Importamos de a tandas chicas: bajar cientos de CVs en una sola consulta
      // supera el límite de tiempo del servidor (60s) y se cuelga. En lotes, cada
      // pedido es rápido y vemos el progreso.
      const CHUNK = 40;
      const apps: App[] = [];
      let importErr = "";
      for (let i = 0; i < aviso.uids.length; i += CHUNK) {
        const chunk = aviso.uids.slice(i, i + CHUNK);
        let res: Response;
        try {
          res = await fetch("/api/inbox", {
            method: "POST",
            headers: { "content-type": "application/json", ...authHeaders() },
            body: JSON.stringify({ action: "import", uids: chunk }),
          });
        } catch {
          importErr = "Se cortó la conexión durante la importación.";
          break;
        }
        if (res.status === 401) {
          onAuthFail();
          return;
        }
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          importErr = data?.error || `Error ${res.status}`;
          break;
        }
        if (Array.isArray(data.applications)) apps.push(...(data.applications as App[]));
        setImportProg({ done: Math.min(i + CHUNK, aviso.uids.length), total: aviso.uids.length });
      }

      // Calculamos los cambios de forma SINCRÓNICA sobre el estado actual
      // (jobsRef) para saber YA cuál es la búsqueda destino y poder abrirla en el
      // mismo click. (Si lo hiciéramos dentro del updater de setJobs, el id no
      // estaría disponible a tiempo y no se abriría la búsqueda.)
      let added = 0;
      let healed = 0;
      let targetJobId = "";
      const next = jobsRef.current.map((j) => ({ ...j, candidates: [...j.candidates] }));
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
      setJobs(next);

      // "Importar" = importar + abrir: pasamos directo a la búsqueda. Si no hubo
      // CVs nuevos (ya estaban), abrimos igual la búsqueda que les corresponde.
      const openId =
        targetJobId ||
        next.find((j) => norm(j.title) === norm(aviso.title) && j.candidates.length > 0)?.id ||
        "";
      if (openId) {
        setActiveTab(openId);
        setScanOpen(false);
      }
      const partial = importErr
        ? ` Quedó a medias (${importErr}); tocá «Importar» de nuevo para traer el resto.`
        : "";
      showToast(
        added > 0
          ? `Importados ${added} CV${added > 1 ? "s" : ""}${
              healed ? ` (y ${healed} actualizados)` : ""
            }.${partial || " Tocá «Evaluar candidatos»."}`
          : healed > 0
            ? `Actualizados ${healed} CV${healed > 1 ? "s" : ""}.${partial || " Ya podés tocar «Evaluar candidatos»."}`
            : importErr
              ? `No se pudo importar: ${importErr}`
              : openId
                ? "Estos CVs ya estaban importados; abrí la búsqueda."
                : "No se encontraron CVs nuevos en ese aviso.",
      );
    } catch (e) {
      showToast("Error al importar: " + (e instanceof Error ? e.message : "desconocido"));
    } finally {
      setImportingTitle(null);
      setImportProg(null);
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
        res = await fetch("/api/score", { method: "POST", body: fd, headers: authHeaders() });
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
      if (res.status === 401) {
        onAuthFail();
        throw new Error("Sesión vencida. Volvé a entrar con un código.");
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
    if (targets.length > 30) {
      const estimate = costPerCv > 0 ? ` (~US$${(targets.length * costPerCv).toFixed(2)})` : "";
      if (
        !window.confirm(
          `Vas a analizar ${targets.length} CVs con la IA${estimate}. Cada uno tiene un costo. ¿Continuar?`,
        )
      ) {
        return;
      }
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
            evaluatedAt: new Date().toISOString(),
          });
          setEvaluatedCount((n) => n + 1);
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
        evaluatedAt: new Date().toISOString(),
      });
      setEvaluatedCount((n) => n + 1);
    } catch (e) {
      patchCandidate(jobId, candId, {
        scoreStatus: "error",
        error: e instanceof Error ? e.message : "Error",
      });
    }
  }

  // ---------- subir archivo manual a una búsqueda ----------
  // Evalúa UN archivo (PDF/imagen) como un candidato.
  function scoreUploadedFile(jobId: string, file: File | Blob, displayName: string) {
    const id = genId();
    const cand: Candidate = {
      id,
      source: "upload",
      name: displayName,
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
        const f =
          file instanceof File
            ? file
            : new File([file], `${displayName}.pdf`, { type: "application/pdf" });
        const { blob, filename } = await prepareUpload(f);
        const fd = new FormData();
        fd.append("file", blob, filename);
        fd.append("criteria", JSON.stringify(criteriaPayload(job)));
        fd.append("jobContext", job.jobContext || job.title);
        fd.append("offeredSalary", offeredSalaryText(job));
        fd.append("plantAddress", resolveAddress(job));
        fd.append("companyValues", companyValuesRef.current || "");
        const res = await fetch("/api/score", { method: "POST", body: fd, headers: authHeaders() });
        if (res.status === 401) onAuthFail();
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data?.error || `Error ${res.status}`);
        patchCandidate(jobId, id, {
          evaluation: data,
          scoreStatus: "done",
          name: data.candidateName || displayName,
          evaluatedAt: new Date().toISOString(),
        });
        setEvaluatedCount((n) => n + 1);
      } catch (e) {
        patchCandidate(jobId, id, {
          scoreStatus: "error",
          error: e instanceof Error ? e.message : "Error",
        });
      }
    })();
  }

  // Agrega candidatos PENDIENTES (sin evaluar). Saltea los que ya existen en la
  // búsqueda (por nombre). Devuelve cuántos agregó y cuántos omitió.
  function addPendingCandidates(
    jobId: string,
    items: { name: string; cvText: string }[],
  ): { added: number; skipped: number } {
    const job = jobsRef.current.find((j) => j.id === jobId);
    const seen = new Set((job?.candidates ?? []).map((c) => nameKey(c.name)).filter(Boolean));
    const fresh: { name: string; cvText: string }[] = [];
    let skipped = 0;
    for (const it of items) {
      const key = nameKey(it.name || "");
      if (key && seen.has(key)) {
        skipped++;
        continue;
      }
      if (key) seen.add(key);
      fresh.push(it);
    }
    const cands: Candidate[] = fresh.map((it) => ({
      id: genId(),
      source: "upload",
      name: it.name?.trim() || "Desconocido",
      cvText: it.cvText,
      expectedSalary: "",
      date: new Date().toISOString(),
      status: "nuevo",
      scoreStatus: "pending",
    }));
    if (cands.length) {
      setJobs((prev) =>
        prev.map((j) => (j.id === jobId ? { ...j, candidates: [...j.candidates, ...cands] } : j)),
      );
    }
    return { added: cands.length, skipped };
  }

  // Sube archivos. Los PDF se SEPARAN (si traen varios CVs) y quedan PENDIENTES:
  // NO se evalúan al cargar; los evaluás vos con «Evaluar candidatos».
  async function addFilesToJob(jobId: string, list: FileList | File[]) {
    const supported = Array.from(list).filter(isSupportedFile);
    for (const file of supported) {
      const isPdf = file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
      if (isPdf) {
        try {
          const fd = new FormData();
          fd.append("file", file);
          const res = await fetch("/api/split-pdf", { method: "POST", body: fd, headers: authHeaders() });
          if (res.status === 401) onAuthFail();
          const data = await res.json().catch(() => ({}));
          if (res.ok && data.single === false && Array.isArray(data.cvs) && data.cvs.length > 0) {
            const { added, skipped } = addPendingCandidates(
              jobId,
              (data.cvs as { name: string; text: string }[]).map((cv) => ({
                name: cv.name,
                cvText: cv.text,
              })),
            );
            showToast(
              `Separé ${data.cvs.length} CVs: ${added} nuevo${added !== 1 ? "s" : ""}` +
                (skipped ? `, ${skipped} ya estaban (omitidos)` : "") +
                ". Tocá «Evaluar candidatos».",
            );
            continue;
          }
          if (res.ok && data.single === true && typeof data.text === "string" && data.text.trim()) {
            const { added } = addPendingCandidates(jobId, [
              { name: file.name.replace(/\.pdf$/i, ""), cvText: data.text },
            ]);
            showToast(
              added ? "CV agregado. Tocá «Evaluar candidatos»." : "Ese CV ya estaba en la búsqueda.",
            );
            continue;
          }
        } catch {
          /* si falla, cae al modo archivo directo abajo */
        }
      }
      // Imágenes (o PDF escaneado sin texto): evaluación directa del archivo.
      scoreUploadedFile(jobId, file, file.name);
    }
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
        headers: { "content-type": "application/json", ...authHeaders() },
        body: JSON.stringify({ uid: c.emailUid }),
      });
      if (res.status === 401) onAuthFail();
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.html) setViewCv({ name: c.name, html: data.html });
      else
        setViewCv({ name: c.name, text: c.cvText || data.error || "No se pudo cargar el correo." });
    } catch {
      setViewCv({ name: c.name, text: c.cvText || "No se pudo cargar el correo." });
    }
  }

  // Imprime el CV que se está viendo: abre el contenido (correo con foto o texto)
  // en una ventana aparte y dispara la impresión del navegador. Desde ahí se puede
  // imprimir en papel o "Guardar como PDF".
  function printCv() {
    if (!viewCv || viewCv.loading) return;
    const esc = (s: string) =>
      s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const title = esc(viewCv.name || "CV");
    const body = viewCv.html
      ? viewCv.html
      : `<pre style="white-space:pre-wrap;font-family:system-ui,'Segoe UI',Arial,sans-serif;font-size:13px;line-height:1.5;padding:24px;margin:0;">${esc(
          viewCv.text || "",
        )}</pre>`;
    const w = window.open("", "_blank", "width=820,height=920");
    if (!w) {
      showToast("Permití las ventanas emergentes para poder imprimir.");
      return;
    }
    w.document.write(
      `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>${title}</title></head><body onload="setTimeout(function(){window.focus();window.print();},300)">${body}</body></html>`,
    );
    w.document.close();
  }

  // Envía un mail al candidato desde la cuenta de reclutamiento (servidor).
  async function sendCandidateMail(
    to: string,
    subject: string,
    body: string,
    files: File[] = [],
  ): Promise<{ ok: boolean; error?: string }> {
    try {
      const fd = new FormData();
      fd.append("to", to);
      fd.append("subject", subject);
      fd.append("body", body);
      for (const f of files) fd.append("file", f);
      const res = await fetch("/api/send-mail", {
        method: "POST",
        headers: { ...authHeaders() },
        body: fd,
      });
      if (res.status === 401) {
        onAuthFail();
        return { ok: false, error: "Tu sesión venció; volvé a entrar." };
      }
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return { ok: false, error: data?.error || `Error ${res.status}` };
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : "Error de red." };
    }
  }

  // ---------- Google Calendar ----------
  async function refreshGoogleStatus() {
    try {
      const res = await fetch("/api/google/status", { headers: authHeaders() });
      if (res.status === 401) return;
      const d = await res.json().catch(() => ({}));
      setGoogleCal({ connected: !!d.connected, email: d.email || "" });
    } catch {
      /* ignorar */
    }
  }
  function connectGoogle() {
    window.location.href = "/api/google/start";
  }
  async function disconnectGoogle() {
    if (!window.confirm("¿Desconectar Google Calendar?")) return;
    try {
      await fetch("/api/google/disconnect", { method: "POST", headers: authHeaders() });
    } catch {
      /* ignorar */
    }
    setGoogleCal({ connected: false, email: "" });
  }
  // Agenda la entrevista en Calendar (y genera Meet si es online).
  async function scheduleInterview(payload: {
    summary: string;
    description: string;
    startISO: string;
    durationMin: number;
    online: boolean;
    location?: string;
    force?: boolean;
  }): Promise<{
    ok: boolean;
    meetLink?: string;
    htmlLink?: string;
    error?: string;
    conflict?: boolean;
    conflicts?: { summary: string; start: string }[];
  }> {
    try {
      const res = await fetch("/api/google/schedule", {
        method: "POST",
        headers: { "content-type": "application/json", ...authHeaders() },
        body: JSON.stringify(payload),
      });
      if (res.status === 401) {
        onAuthFail();
        return { ok: false, error: "Tu sesión venció." };
      }
      const d = await res.json().catch(() => ({}));
      if (!res.ok) return { ok: false, error: d?.error || `Error ${res.status}` };
      if (d.conflict) return { ok: false, conflict: true, conflicts: d.conflicts || [] };
      return { ok: true, meetLink: d.meetLink, htmlLink: d.htmlLink };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : "Error de red." };
    }
  }

  // Inicia una evaluación por WhatsApp para un candidato (manda el 1er mensaje).
  async function startWaEval(jobId: string, cand: Candidate) {
    const guess = toWaNumber(extractPhone(cand.cvText));
    const phone = window.prompt(
      `Iniciar evaluación por WhatsApp de ${cand.name}.\nNúmero (con código de país):`,
      guess,
    );
    if (!phone) return;
    try {
      const res = await fetch("/api/whatsapp/start", {
        method: "POST",
        headers: { "content-type": "application/json", ...authHeaders() },
        body: JSON.stringify({ candidateId: cand.id, searchId: jobId, phone }),
      });
      if (res.status === 401) {
        onAuthFail();
        return;
      }
      const d = await res.json().catch(() => ({}));
      if (res.ok) showToast("Evaluación iniciada por WhatsApp ✓");
      else showToast("No se pudo iniciar: " + (d?.error || "error"));
    } catch (e) {
      showToast("No se pudo iniciar: " + (e instanceof Error ? e.message : "error de red"));
    }
  }

  // ---------- derivados ----------
  // Detalle del gasto estimado: CVs evaluados agrupados por aviso y por día.
  // (Es un estimado: cantidad de CVs evaluados × costo por CV del modelo.)
  const costStats = useMemo(() => {
    const dayMap = new Map<string, number>();
    const monthMap = new Map<string, number>();
    const jobArr: { title: string; count: number }[] = [];
    let total = 0;
    for (const j of jobs) {
      let jc = 0;
      for (const c of j.candidates) {
        if (!c.evaluation) continue;
        jc++;
        total++;
        const iso = c.evaluatedAt || c.date || "";
        const day = iso ? iso.slice(0, 10) : "sin-fecha";
        const month = iso ? iso.slice(0, 7) : "sin-fecha";
        dayMap.set(day, (dayMap.get(day) ?? 0) + 1);
        monthMap.set(month, (monthMap.get(month) ?? 0) + 1);
      }
      if (jc > 0) jobArr.push({ title: j.title || "(sin título)", count: jc });
    }
    const currentMonth = new Date().toISOString().slice(0, 7);
    const byJob = jobArr.sort((a, b) => b.count - a.count);
    // Detalle por día, SOLO del mes en curso (más reciente primero).
    const byDayCurrent = [...dayMap.entries()]
      .filter(([day]) => day.startsWith(currentMonth))
      .map(([day, count]) => ({ day, count }))
      .sort((a, b) => (a.day < b.day ? 1 : -1));
    // Gasto por mes (más reciente primero).
    const byMonth = [...monthMap.entries()]
      .map(([month, count]) => ({ month, count }))
      .sort((a, b) => (a.month < b.month ? 1 : -1));
    return { total, byJob, byDayCurrent, byMonth, currentMonth };
  }, [jobs]);

  // Al abrir el detalle de gasto, traemos las sesiones del bot (para su gasto).
  useEffect(() => {
    if (!costDetailOpen) return;
    (async () => {
      try {
        const r = await fetch("/api/whatsapp/sessions", { headers: authHeaders() });
        const d = await r.json().catch(() => ({}));
        setBotSessions(Array.isArray(d.sessions) ? d.sessions : []);
      } catch {
        /* sin datos del bot */
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [costDetailOpen]);

  // Gasto estimado del bot: IA (respuestas + Excel) y WhatsApp/Meta (por conversación).
  const botStats = useMemo(() => {
    const conversations = botSessions.length;
    const answersScored = botSessions.filter((s) => s.score != null).length;
    const excelScored = botSessions.filter((s) => s.excel_score != null).length;
    const iaCost = answersScored * BOT_COST.answers + excelScored * BOT_COST.excel;
    const waCost = conversations * BOT_COST.waConversation;
    return { conversations, answersScored, excelScored, iaCost, waCost, total: iaCost + waCost };
  }, [botSessions]);

  const activeJob = jobs.find((j) => j.id === activeTab) || null;
  const totalCandidates = useMemo(
    () => jobs.reduce((n, j) => n + j.candidates.length, 0),
    [jobs],
  );

  // Índice por nombre para detectar al mismo candidato en varias búsquedas.
  const candidateIndex = useMemo(() => {
    const map = new Map<string, { jobId: string; title: string }[]>();
    for (const j of jobs) {
      for (const c of j.candidates) {
        const key = norm(c.name);
        if (!key) continue;
        const arr = map.get(key) ?? [];
        if (!arr.some((x) => x.jobId === j.id)) arr.push({ jobId: j.id, title: j.title });
        map.set(key, arr);
      }
    }
    return map;
  }, [jobs]);

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
  // Los que se acaban de re-calificar (ventana de deshacer) siguen visibles.
  const byCalif = rankedActive.filter((c) =>
    graceUndo[c.id] !== undefined
      ? true
      : califFilter === "todos"
        ? califOf(c) !== "descartado"
        : califOf(c) === califFilter,
  );
  const byFilters = byCalif.filter((c) => passesFilters(c, activeFilters));
  // Búsqueda por nombre (sin acentos ni mayúsculas).
  const search = norm(candSearch.trim());
  const shownActive = search ? byFilters.filter((c) => norm(c.name).includes(search)) : byFilters;
  const hiddenActive = byCalif.length - shownActive.length;
  const califCount = (v: Calificacion) => rankedActive.filter((c) => califOf(c) === v).length;

  if (!authReady) {
    return (
      <main className="page">
        <div className="auth-screen">
          <span className="spinner" /> Cargando…
        </div>
      </main>
    );
  }

  if (!authed) {
    return (
      <main className="page">
        <div className="auth-screen">
          <div className="auth-card">
            <span className="logo auth-logo">CV</span>
            <h1 className="auth-title">LecturaCVs</h1>
            <p className="auth-sub">
              Acceso protegido. Te mandamos un código de 6 dígitos por correo para entrar.
            </p>
            {!codeChallenge ? (
              <>
                <button
                  className="btn btn-primary btn-block"
                  onClick={requestCode}
                  disabled={authBusy}
                >
                  {authBusy ? (
                    <>
                      <span className="spinner" /> Enviando…
                    </>
                  ) : (
                    "✉ Enviarme el código"
                  )}
                </button>
                {codeSentTo && <p className="auth-hint">El código llega a {codeSentTo}</p>}
              </>
            ) : (
              <>
                <p className="auth-hint">
                  Código enviado a {codeSentTo || "tu correo"}. Revisá tu casilla e ingresalo:
                </p>
                <input
                  className="auth-code"
                  inputMode="numeric"
                  maxLength={6}
                  placeholder="000000"
                  value={codeInput}
                  onChange={(e) => setCodeInput(e.target.value.replace(/\D/g, "").slice(0, 6))}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && codeInput.length === 6) submitCode();
                  }}
                  autoFocus
                />
                <button
                  className="btn btn-primary btn-block"
                  onClick={submitCode}
                  disabled={authBusy || codeInput.length !== 6}
                >
                  {authBusy ? (
                    <>
                      <span className="spinner" /> Verificando…
                    </>
                  ) : (
                    "Entrar"
                  )}
                </button>
                <button className="linklike auth-resend" onClick={requestCode} disabled={authBusy}>
                  Reenviar código
                </button>
              </>
            )}
            {authErr && <p className="auth-err">{authErr}</p>}
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className="page">
      <header className="appbar">
        <button
          type="button"
          className="brand"
          onClick={() => setActiveTab("")}
          title="Ir al inicio (lista de búsquedas)"
        >
          <span className="logo">CV</span>
          <div className="brand-text">
            <span className="brand-name">LecturaCVs</span>
            <span className="brand-tag">Pre-selección de candidatos con IA</span>
          </div>
        </button>
        <div className="appbar-right">
          <button
            type="button"
            className={`spend-badge${evaluatedCount > 0 ? "" : " icon-only"}`}
            onClick={() => setCostDetailOpen(true)}
            title="Ver el gasto estimado (por día y por aviso)"
          >
            💵
            {evaluatedCount > 0 && (
              <>
                {" "}
                {evaluatedCount} CV{evaluatedCount !== 1 ? "s" : ""}
                {costPerCv > 0 ? ` · ~US$${(evaluatedCount * costPerCv).toFixed(2)}` : ""}
              </>
            )}
          </button>
          <button
            className={`profile-btn${activeTab === "buscar" ? " active" : ""}`}
            onClick={() => setActiveTab((cur) => (cur === "buscar" ? "" : "buscar"))}
            title="Buscador global"
          >
            <span className="profile-btn-icon">🔎</span>
            <span className="profile-btn-text">Buscar</span>
          </button>
          <button
            className={`profile-btn${activeTab === "wabot" ? " active" : ""}`}
            onClick={() => setActiveTab((cur) => (cur === "wabot" ? "" : "wabot"))}
            title="Bot de WhatsApp (preguntas y evaluaciones)"
          >
            <span className="profile-btn-icon">🤖</span>
            <span className="profile-btn-text">Bot</span>
          </button>
          <button
            className={`profile-btn${activeTab === "perfil" ? " active" : ""}`}
            onClick={toggleProfile}
            title="Mi perfil"
          >
            <span className="profile-btn-icon">👤</span>
            <span className="profile-btn-text">Mi perfil</span>
          </button>
        </div>
      </header>

      {toast && <div className="toast">{toast}</div>}

      {localMigration && (
        <div className="reeval-banner">
          <span>
            Este navegador tiene datos guardados de antes ({localMigration.jobs.length} búsqueda
            {localMigration.jobs.length !== 1 ? "s" : ""}, {localMigration.count} candidato
            {localMigration.count !== 1 ? "s" : ""}) y la nube está vacía. ¿Los subís para verlos en
            cualquier PC?
          </span>
          <div className="reeval-actions">
            <button className="btn btn-primary" onClick={uploadLocalToCloud}>
              ⬆ Subir mis datos a la nube
            </button>
            <button className="btn btn-ghost" onClick={() => setLocalMigration(null)}>
              Ahora no
            </button>
          </div>
        </div>
      )}

      {/* Entrada: lista de búsquedas + acciones. */}
      {activeTab === "" && (
        <div className="home">
          <div className="home-actions">
            <button className="btn btn-primary" onClick={openScanModal}>
              ⟳ Buscar avisos nuevos
            </button>
            <button className="btn btn-ghost" onClick={createManualJob}>
              + Crear búsqueda manual
            </button>
          </div>
          {jobs.length === 0 ? (
            <p className="empty" style={{ marginTop: 12 }}>
              Todavía no hay búsquedas. Tocá «Buscar avisos nuevos» para traer CVs de Gmail, o «Crear
              búsqueda manual» para cargarlos a mano.
            </p>
          ) : (
            <div className="home-jobs">
              {[...jobs]
                .sort((a, b) => (a.firstDate < b.firstDate ? 1 : -1))
                .map((j) => (
                  <button key={j.id} className="home-job" onClick={() => setActiveTab(j.id)}>
                    <span className="home-job-title">{j.title}</span>
                    <span className="home-job-sub">
                      {j.candidates.length} candidato{j.candidates.length !== 1 ? "s" : ""}
                      {j.firstDate ? ` · primer CV ${shortDate(j.firstDate)}` : ""}
                    </span>
                  </button>
                ))}
            </div>
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
                : activeTab === "buscar"
                  ? "🔎 Buscador global"
                  : activeTab === "wabot"
                    ? "🤖 Bot de WhatsApp"
                    : ""}
          </span>
          <div className="aviso-nav-actions">
            <button className="btn btn-ghost tab-new-btn" onClick={createManualJob}>
              + Manual
            </button>
            <button className="btn btn-ghost tab-new-btn" onClick={openScanModal}>
              ⟳ Buscar avisos
            </button>
          </div>
        </div>
      )}

      {/* panel general */}
      {activeTab === "dashboard" && <Dashboard jobs={jobs} onStatus={patchCandidate} />}

      {/* buscador global (en toda la base) */}
      {activeTab === "buscar" && (
        <GlobalSearch jobs={jobs} onOpenJob={(id) => setActiveTab(id)} onViewCv={openCv} />
      )}

      {/* bot de WhatsApp: preguntas por área + evaluaciones */}
      {activeTab === "wabot" && <WaBot jobs={jobs} authHeaders={authHeaders} />}

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
          onExportBackup={exportBackup}
          onImportBackup={importBackup}
          onLogout={logout}
          googleConnected={googleCal.connected}
          googleEmail={googleCal.email}
          onConnectGoogle={connectGoogle}
          onDisconnectGoogle={disconnectGoogle}
          bookingUrl={bookingUrl}
          onBookingUrl={setBookingUrl}
        />
      )}

      {/* vista de una búsqueda */}
      {activeJob && (
        <div className="job-layout" style={boardView ? { display: "block" } : undefined}>
          <section
            className="card job-config"
            style={boardView ? { display: "none" } : undefined}
          >
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

            <div className="paso-row">
              <span className="paso">Paso 1</span>
              <span className="paso-desc">Sueldo ofrecido por la empresa</span>
              <div className="salary-mode">
                <label className={`salary-opt${!activeJob.salaryRange ? " on" : ""}`}>
                  <input
                    type="radio"
                    checked={!activeJob.salaryRange}
                    onChange={() =>
                      patchJob(activeJob.id, { salaryRange: false, offeredSalaryMax: "" })
                    }
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
                  style={{ maxWidth: 200 }}
                />
              )}
            </div>

            <div className="paso-row">
              <span className="paso">Paso 2</span>
              <span className="paso-desc">Sede laboral de esta búsqueda</span>
            </div>
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

            <div className="paso-row" style={{ marginTop: 12 }}>
              <span className="paso">Bot</span>
              <span className="paso-desc">Área del bot de WhatsApp (para las preguntas)</span>
            </div>
            <select
              className="sede-select"
              value={activeJob.botArea ?? ""}
              onChange={(e) => patchJob(activeJob.id, { botArea: e.target.value || undefined })}
            >
              <option value="">(sin área)</option>
              {BOT_AREAS.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.label}
                </option>
              ))}
            </select>
            <p className="field-hint">
              Define qué preguntas usa el bot por defecto para los candidatos de esta búsqueda (el
              candidato igual puede cambiarla con el selector).
            </p>

            <details className="criteria-box">
              <summary>
                <span className="paso">Paso 3</span>
                <span className="paso-desc">Criterios y pesos de esta búsqueda</span>
              </summary>
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

            <div className="paso-row">
              <span className="paso">Paso 4</span>
              <span className="paso-desc">Evaluar candidatos</span>
            </div>

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
                    <span className="eval-total">Total: {activeJob.candidates.length}</span>
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

          <div className="job-main">
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

          <section className="card job-list">
            <div className="results-toolbar">
              <h2 style={{ margin: 0 }}>Candidatos</h2>
              <span className="count">{activeJob.candidates.length} en total</span>
              {!boardView && activeJob.candidates.length > 0 && (
                <div className="cand-search">
                  <span className="cand-search-icon">🔎</span>
                  <input
                    type="search"
                    placeholder="Buscar por nombre…"
                    value={candSearch}
                    onChange={(e) => setCandSearch(e.target.value)}
                  />
                </div>
              )}
              <div className="view-toggle">
                <button
                  className={`vt-btn${!boardView ? " on" : ""}`}
                  onClick={() => setBoardView(false)}
                >
                  ☰ Lista
                </button>
                <button
                  className={`vt-btn${boardView ? " on" : ""}`}
                  onClick={() => setBoardView(true)}
                >
                  📋 Tablero
                </button>
              </div>
            </div>

            {boardView ? (
              <Board
                job={activeJob}
                stages={stagesOf(activeJob)}
                onMove={(candId, stageId) => moveCandidateToStage(activeJob.id, candId, stageId)}
                onRemove={(candId) => removeFromBoard(activeJob.id, candId)}
                onAddStage={() => addStage(activeJob.id)}
                onRenameStage={(sid, cur) => renameStage(activeJob.id, sid, cur)}
                onDeleteStage={(sid) => deleteStage(activeJob.id, sid)}
                onMoveStage={(sid, dir) => moveStage(activeJob.id, sid, dir)}
                onViewCv={openCv}
                onNotes={(candId, t) => patchCandidate(activeJob.id, candId, { notes: t })}
                onSendMail={(cand) => setMailCand({ jobId: activeJob.id, cand })}
                onStartWa={(cand) => startWaEval(activeJob.id, cand)}
              />
            ) : (
              <>
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
                <div className="list-actions">
                  <span className="list-actions-count">{shownActive.length} en la lista</span>
                  {compareSel.size >= 2 && (
                    <button
                      className="btn btn-primary btn-sm"
                      onClick={() => setCompareOpen(true)}
                      title="Ver los seleccionados lado a lado"
                    >
                      ⚖ Comparar ({compareSel.size})
                    </button>
                  )}
                  {compareSel.size > 0 && (
                    <button
                      className="btn btn-ghost btn-sm"
                      onClick={() => setCompareSel(new Set())}
                    >
                      Limpiar selección
                    </button>
                  )}
                  <button
                    className="btn btn-ghost btn-sm"
                    onClick={() => exportCandidatesCsv(activeJob.title, shownActive)}
                    title="Descargar esta lista para abrir en Excel"
                  >
                    ⬇ Excel
                  </button>
                  <button
                    className="btn btn-ghost btn-sm"
                    onClick={() => exportCandidatesPdf(activeJob.title, shownActive)}
                    title="Generar un PDF para imprimir o guardar"
                  >
                    ⬇ PDF
                  </button>
                </div>
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
                    pendingUndo={graceUndo[c.id] !== undefined}
                    undoUntil={graceUndo[c.id]?.until}
                    onUndo={() => undoCalif(activeJob.id, c.id)}
                    onConfirm={() => clearGrace(c.id)}
                    onCalif={(k) => {
                      const prev = c.calificacion ?? "sincalificar";
                      if (k === prev) return; // mismo valor: nada que hacer
                      // Cualquier cambio queda 8s con "Deshacer" en su fila.
                      setCalifWithUndo(activeJob.id, c.id, prev, k);
                    }}
                    onViewCv={openCv}
                    onReevaluate={() => reevaluateOne(activeJob.id, c.id)}
                    onDelete={() => deleteCandidate(activeJob.id, c.id)}
                    onNotes={(t) => patchCandidate(activeJob.id, c.id, { notes: t })}
                    jobTitle={activeJob.title}
                    otherJobs={(candidateIndex.get(norm(c.name)) ?? []).filter(
                      (x) => x.jobId !== activeJob.id,
                    )}
                    onOpenJob={(id) => setActiveTab(id)}
                    selected={compareSel.has(c.id)}
                    onSelect={() =>
                      setCompareSel((prev) => {
                        const next = new Set(prev);
                        if (next.has(c.id)) next.delete(c.id);
                        else next.add(c.id);
                        return next;
                      })
                    }
                  />
                ))}
              </div>
            )}
              </>
            )}
          </section>
          </div>
        </div>
      )}

      {mailCand &&
        (() => {
          const job = jobs.find((j) => j.id === mailCand.jobId);
          return (
            <MailComposer
              cand={mailCand.cand}
              jobTitle={job?.title || ""}
              sede={job ? resolveAddress(job) : ""}
              sendMail={sendCandidateMail}
              scheduleInterview={scheduleInterview}
              googleConnected={googleCal.connected}
              bookingUrl={bookingUrl}
              onClose={() => setMailCand(null)}
            />
          );
        })()}

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
                  disabled={scanning}
                  onChange={(e) => {
                    const m = Number(e.target.value);
                    setScanMonths(m);
                    // Al cambiar el período, re-buscamos solo si ya había una
                    // lista cargada (para que se actualice sin tocar el botón).
                    if (scanResults) void scanAvisos(m);
                  }}
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
                          <div className="aviso-actions">
                            <button
                              className="btn btn-primary"
                              onClick={() => importAviso(a)}
                              disabled={importingTitle !== null}
                              title="Vuelve a leer Gmail y trae solo los CVs nuevos de este aviso (los que ya tenés no se duplican)."
                            >
                              {importingTitle === a.title ? (
                                <>
                                  <span className="spinner" /> Buscando nuevos
                                  {importProg ? ` ${importProg.done}/${importProg.total}` : "…"}
                                </>
                              ) : (
                                "🔄 Traer nuevos"
                              )}
                            </button>
                            {existing.id === activeTab ? (
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
                                disabled={importingTitle !== null}
                              >
                                Abrir
                              </button>
                            )}
                          </div>
                        ) : (
                          <button
                            className="btn btn-primary"
                            onClick={() => importAviso(a)}
                            disabled={importingTitle !== null}
                          >
                            {importingTitle === a.title ? (
                              <>
                                <span className="spinner" /> Importando
                                {importProg ? ` ${importProg.done}/${importProg.total}` : "…"}
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
              <div className="modal-head-actions">
                {!viewCv.loading && (
                  <button className="btn btn-ghost btn-sm" onClick={printCv} title="Imprimir o guardar como PDF">
                    🖨 Imprimir
                  </button>
                )}
                <button className="icon-btn" aria-label="Cerrar" onClick={() => setViewCv(null)}>
                  ×
                </button>
              </div>
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

      {costDetailOpen && (
        <div className="modal-overlay" onClick={() => setCostDetailOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <strong>💵 Detalle de gasto estimado</strong>
              <button
                className="icon-btn"
                aria-label="Cerrar"
                onClick={() => setCostDetailOpen(false)}
              >
                ×
              </button>
            </div>
            <div className="modal-body cost-detail">
              <div className="results-toolbar" style={{ gap: 8, marginBottom: 10 }}>
                <button
                  className={`btn btn-sm ${costTab === "cvs" ? "btn-primary" : "btn-ghost"}`}
                  onClick={() => setCostTab("cvs")}
                >
                  LecturaCVs
                </button>
                <button
                  className={`btn btn-sm ${costTab === "bot" ? "btn-primary" : "btn-ghost"}`}
                  onClick={() => setCostTab("bot")}
                >
                  Bot
                </button>
              </div>

              {costTab === "bot" ? (
                <div>
                  <div className="cost-total">
                    Gasto del bot{" "}
                    <span className="cost-total-usd">· ~US${botStats.total.toFixed(2)}</span>
                  </div>
                  <p className="cost-note">
                    Estimado. La <b>IA</b> se paga a Anthropic; <b>WhatsApp</b> a Meta.
                  </p>
                  <h4>IA del bot</h4>
                  <div className="cost-table">
                    <div className="cost-row">
                      <span className="cost-row-label">Respuestas puntuadas</span>
                      <span className="cost-row-count">{botStats.answersScored}</span>
                      <span className="cost-row-usd">
                        ~US${(botStats.answersScored * BOT_COST.answers).toFixed(2)}
                      </span>
                    </div>
                    <div className="cost-row">
                      <span className="cost-row-label">Excel corregidos</span>
                      <span className="cost-row-count">{botStats.excelScored}</span>
                      <span className="cost-row-usd">
                        ~US${(botStats.excelScored * BOT_COST.excel).toFixed(2)}
                      </span>
                    </div>
                  </div>
                  <h4>WhatsApp / Meta</h4>
                  <div className="cost-table">
                    <div className="cost-row">
                      <span className="cost-row-label">Conversaciones iniciadas</span>
                      <span className="cost-row-count">{botStats.conversations}</span>
                      <span className="cost-row-usd">~US${botStats.waCost.toFixed(2)}</span>
                    </div>
                  </div>
                  <p className="cost-note">
                    El costo real de WhatsApp está en la facturación de <b>Meta</b> (Business Manager).
                    Acá es un estimado (~US${BOT_COST.waConversation.toFixed(3)}/conversación).
                  </p>
                </div>
              ) : (
                <>
              <div className="cost-total">
                <b>{costStats.total}</b> CV{costStats.total !== 1 ? "s" : ""} evaluado
                {costStats.total !== 1 ? "s" : ""}
                {costPerCv > 0 && (
                  <span className="cost-total-usd">
                    {" "}
                    · ~US${(costStats.total * costPerCv).toFixed(2)}
                  </span>
                )}
              </div>
              <p className="cost-note">
                Es un <b>estimado</b>: cantidad de CVs evaluados × costo por CV del modelo
                {costPerCv > 0 ? ` (~US$${costPerCv.toFixed(4)} c/u)` : ""}. No es la factura real de
                Anthropic.
              </p>

              {costStats.total === 0 ? (
                <p className="empty">Todavía no evaluaste ningún CV.</p>
              ) : (
                <>
                  <h4>Por día — {fmtMonth(costStats.currentMonth)}</h4>
                  {costStats.byDayCurrent.length === 0 ? (
                    <p className="cost-empty">Sin CVs evaluados este mes.</p>
                  ) : (
                    <div className="cost-table">
                      {costStats.byDayCurrent.map((r) => (
                        <div className="cost-row" key={r.day}>
                          <span className="cost-row-label">{fmtDay(r.day)}</span>
                          <span className="cost-row-count">
                            {r.count} CV{r.count !== 1 ? "s" : ""}
                          </span>
                          <span className="cost-row-usd">
                            {costPerCv > 0 ? `~US$${(r.count * costPerCv).toFixed(2)}` : "—"}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}

                  <h4>Por aviso</h4>
                  <div className="cost-table">
                    {costStats.byJob.map((r) => (
                      <div className="cost-row" key={r.title}>
                        <span className="cost-row-label">{r.title}</span>
                        <span className="cost-row-count">{r.count} CV{r.count !== 1 ? "s" : ""}</span>
                        <span className="cost-row-usd">
                          {costPerCv > 0 ? `~US$${(r.count * costPerCv).toFixed(2)}` : "—"}
                        </span>
                      </div>
                    ))}
                  </div>

                  <h4>Por mes</h4>
                  <div className="cost-table">
                    {costStats.byMonth.map((r) => (
                      <div className="cost-row" key={r.month}>
                        <span className="cost-row-label">{fmtMonth(r.month)}</span>
                        <span className="cost-row-count">{r.count} CV{r.count !== 1 ? "s" : ""}</span>
                        <span className="cost-row-usd">
                          {costPerCv > 0 ? `~US$${(r.count * costPerCv).toFixed(2)}` : "—"}
                        </span>
                      </div>
                    ))}
                  </div>
                </>
              )}
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {compareOpen &&
        (() => {
          const items = (activeJob?.candidates ?? []).filter((c) => compareSel.has(c.id));
          const stLabel = (s: Status) => STATUSES.find((x) => x.value === s)?.label ?? s;
          const cols = `150px repeat(${items.length}, minmax(150px, 1fr))`;
          const Row = ({ label, render }: { label: string; render: (c: Candidate) => ReactNode }) => (
            <>
              <div className="cmp-rowlabel">{label}</div>
              {items.map((c) => (
                <div className="cmp-cell" key={c.id}>
                  {render(c)}
                </div>
              ))}
            </>
          );
          return (
            <div className="modal-overlay" onClick={() => setCompareOpen(false)}>
              <div className="modal modal-wide" onClick={(e) => e.stopPropagation()}>
                <div className="modal-head">
                  <strong>Comparar candidatos ({items.length})</strong>
                  <button
                    className="icon-btn"
                    aria-label="Cerrar"
                    onClick={() => setCompareOpen(false)}
                  >
                    ×
                  </button>
                </div>
                <div className="modal-body cmp-body">
                  <div className="cmp-grid" style={{ gridTemplateColumns: cols }}>
                    <div className="cmp-rowlabel" />
                    {items.map((c) => (
                      <div className="cmp-name" key={c.id}>
                        {c.name}
                      </div>
                    ))}
                    <Row
                      label="Puntaje"
                      render={(c) => (
                        <span className="cmp-score">
                          {c.evaluation ? `${toTen(c.evaluation.overallScore)}/10` : "—"}
                        </span>
                      )}
                    />
                    <Row
                      label="Calificación"
                      render={(c) => (
                        <>
                          <span className={`cal-dot cal-${califOf(c)}`} /> {califLabel(califOf(c))}
                        </>
                      )}
                    />
                    <Row label="Estado" render={(c) => stLabel(c.status)} />
                    <Row label="Edad" render={(c) => (c.evaluation?.age != null ? `${c.evaluation.age} años` : "—")} />
                    <Row
                      label="Sexo"
                      render={(c) =>
                        c.evaluation?.sex && c.evaluation.sex !== "no especificado"
                          ? c.evaluation.sex
                          : "—"
                      }
                    />
                    <Row label="Ubicación" render={(c) => c.evaluation?.location || "—"} />
                    <Row
                      label="Distancia"
                      render={(c) =>
                        c.evaluation?.distanceKm != null ? `${c.evaluation.distanceKm} km` : "—"
                      }
                    />
                    <Row label="Sueldo pretendido" render={(c) => c.expectedSalary || "—"} />
                    <Row
                      label="Fortalezas"
                      render={(c) =>
                        c.evaluation?.strengths?.length ? (
                          <ul className="cmp-list">
                            {c.evaluation.strengths.map((s, k) => (
                              <li key={k}>{s}</li>
                            ))}
                          </ul>
                        ) : (
                          "—"
                        )
                      }
                    />
                    <Row
                      label="Dudas"
                      render={(c) =>
                        c.evaluation?.concerns?.length ? (
                          <ul className="cmp-list">
                            {c.evaluation.concerns.map((s, k) => (
                              <li key={k}>{s}</li>
                            ))}
                          </ul>
                        ) : (
                          "—"
                        )
                      }
                    />
                    <Row label="Resumen" render={(c) => c.evaluation?.summary || "—"} />
                    <Row label="Notas" render={(c) => c.notes || "—"} />
                  </div>
                </div>
              </div>
            </div>
          );
        })()}
    </main>
  );
}

function statusClass(s: Status) {
  return `st-${s}`;
}

// Cuadrito con la cuenta regresiva (segundos) hasta que el candidato descartado
// desaparece de la lista.
function Countdown({ until }: { until: number }) {
  const calc = () => Math.max(0, Math.ceil((until - Date.now()) / 1000));
  const [left, setLeft] = useState(calc);
  useEffect(() => {
    setLeft(calc());
    const id = window.setInterval(() => setLeft(calc()), 250);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [until]);
  return (
    <span className="cd-box" aria-label={`${left} segundos`}>
      {left}s
    </span>
  );
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
  onDelete,
  pendingUndo,
  undoUntil,
  onUndo,
  onConfirm,
  onNotes,
  jobTitle,
  otherJobs,
  onOpenJob,
  selected,
  onSelect,
}: {
  cand: Candidate;
  rank: number;
  open: boolean;
  onToggle: () => void;
  onStatus: (s: Status) => void;
  onCalif: (k: Calificacion) => void;
  onViewCv: (c: { name: string; emailUid?: number; cvText?: string }) => void;
  onReevaluate: () => void;
  onDelete: () => void;
  pendingUndo?: boolean;
  undoUntil?: number;
  onUndo?: () => void;
  onConfirm?: () => void;
  onNotes?: (t: string) => void;
  jobTitle?: string;
  otherJobs?: { jobId: string; title: string }[];
  onOpenJob?: (jobId: string) => void;
  selected?: boolean;
  onSelect?: () => void;
}) {
  const ev = cand.evaluation;
  const cur = califOf(cand);
  const [copied, setCopied] = useState(false);

  // Mensaje de contacto listo para pegar en WhatsApp/mail.
  function copyContactMessage() {
    const first = cand.name.split(/\s+/)[0] || cand.name;
    const puesto = jobTitle?.trim() ? ` al puesto de ${jobTitle.trim()}` : "";
    const msg =
      `Hola ${first}, ¿cómo estás? Te escribo por tu postulación${puesto}. ` +
      `Nos interesó tu perfil y nos gustaría coordinar una entrevista. ` +
      `¿Qué disponibilidad tenés en los próximos días? ¡Gracias!`;
    navigator.clipboard?.writeText(msg).then(
      () => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 2500);
      },
      () => {},
    );
  }
  return (
    <div className={`result${open ? " open" : ""}${pendingUndo ? " pending-undo" : ""}`}>
      <div className="result-head">
        <input
          type="checkbox"
          className="cmp-check"
          checked={!!selected}
          onChange={onSelect}
          onClick={(e) => e.stopPropagation()}
          title="Seleccionar para comparar"
          aria-label="Seleccionar para comparar"
        />
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
          <div className="who">
            {cand.name}
            {otherJobs && otherJobs.length > 0 && (
              <span
                className="dup-flag"
                title={`También se postuló a ${otherJobs.length} búsqueda(s) más`}
              >
                🔁 {otherJobs.length}
              </span>
            )}
          </div>
          <div className="file">
            {cand.source === "gmail" ? "ZonaJobs" : "Archivo"}
            {cand.date ? ` · se postuló ${hace(cand.date)}` : ""}
            {ev?.age != null ? ` · ${ev.age} años` : ""}
            {ev?.distanceKm != null ? ` · a ${ev.distanceKm} km` : ""}
            {cand.expectedSalary ? ` · pretende ${cand.expectedSalary}` : ""}
            {cand.scoreStatus === "error" ? " · error al evaluar" : ""}
          </div>
        </div>
        {pendingUndo ? (
          <div className="cal-undo">
            <span className="cal-undo-label">
              <span className={`cal-dot cal-${cur}`} /> {califLabel(cur)}
            </span>
            <button
              type="button"
              className="confirm-btn"
              onClick={onConfirm}
              title="Confirmar la calificación"
            >
              ✓
            </button>
            <button type="button" className="undo-btn" onClick={onUndo}>
              ↩ Deshacer
            </button>
            {undoUntil != null && <Countdown until={undoUntil} />}
          </div>
        ) : (
          <div className="cal-dots" role="group" aria-label="Calificación">
            {CALIF_PICKER.map(({ value: v, short }) => {
              const active = califOf(cand) === v;
              return (
                <button
                  key={v}
                  type="button"
                  className={`cal-pick cal-${v}${active ? " active" : ""}`}
                  onClick={() => onCalif(v)}
                  title={califLabel(v)}
                  aria-pressed={active}
                >
                  <span className="cal-pick-dot" />
                  <span className="cal-pick-txt">{short}</span>
                </button>
              );
            })}
          </div>
        )}
        <span className="chevron" onClick={onToggle}>
          ▾
        </span>
      </div>

      {open && (
        <div className="result-body">
          {otherJobs && otherJobs.length > 0 && (
            <div className="dup-note">
              🔁 Este candidato también se postuló a:{" "}
              {otherJobs.map((o, k) => (
                <span key={o.jobId}>
                  <button
                    type="button"
                    className="linklike"
                    onClick={() => onOpenJob?.(o.jobId)}
                  >
                    {o.title}
                  </button>
                  {k < otherJobs.length - 1 ? ", " : ""}
                </span>
              ))}
            </div>
          )}
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
            <button className="btn btn-ghost" onClick={copyContactMessage}>
              {copied ? "✓ Mensaje copiado" : "💬 Copiar mensaje"}
            </button>
            <button className="btn btn-ghost" onClick={onDelete} title="Borrar este candidato">
              🗑 Borrar
            </button>
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

          <div className="cand-notes">
            <label className="cand-notes-label" htmlFor={`notes-${cand.id}`}>
              📝 Notas
            </label>
            <textarea
              id={`notes-${cand.id}`}
              className="cand-notes-input"
              rows={2}
              placeholder="Anotá lo que quieras recordar: lo que pidió, cómo fue la entrevista, un llamado…"
              value={cand.notes ?? ""}
              onChange={(e) => onNotes?.(e.target.value)}
            />
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

// Exporta la lista de candidatos (la que se está viendo) a un CSV que abre
// directo en Excel (separador ";" y BOM para que los acentos se vean bien).
function exportCandidatesCsv(jobTitle: string, list: Candidate[]) {
  const statusLabel = (s: Status) => STATUSES.find((x) => x.value === s)?.label ?? s;
  const cell = (v: unknown) => {
    const s = String(v ?? "");
    return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const headers = [
    "#",
    "Nombre",
    "Puntaje",
    "Calificación",
    "Estado",
    "Edad",
    "Distancia (km)",
    "Sueldo pretendido",
    "Notas",
  ];
  const rows = list.map((c, i) => {
    const ev = c.evaluation;
    return [
      i + 1,
      c.name,
      ev ? toTen(ev.overallScore) : "",
      califLabel(califOf(c)),
      statusLabel(c.status),
      ev?.age ?? "",
      ev?.distanceKm ?? "",
      c.expectedSalary ?? "",
      c.notes ?? "",
    ]
      .map(cell)
      .join(";");
  });
  const csv = "﻿" + [headers.map(cell).join(";"), ...rows].join("\r\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const safe =
    jobTitle
      .replace(/[^\p{L}\p{N}]+/gu, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "candidatos";
  a.href = url;
  a.download = `${safe}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// Genera un PDF del ranking abriendo una vista limpia para imprimir/guardar.
// (Usa la impresión del navegador → "Guardar como PDF": sin librerías extra.)
function exportCandidatesPdf(jobTitle: string, list: Candidate[]) {
  const statusLabel = (s: Status) => STATUSES.find((x) => x.value === s)?.label ?? s;
  const esc = (v: unknown) =>
    String(v ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  const rows = list
    .map((c, i) => {
      const ev = c.evaluation;
      return `<tr>
        <td>${i + 1}</td>
        <td>${esc(c.name)}</td>
        <td class="num">${ev ? toTen(ev.overallScore) : "—"}</td>
        <td>${esc(califLabel(califOf(c)))}</td>
        <td>${esc(statusLabel(c.status))}</td>
        <td class="num">${ev?.age ?? ""}</td>
        <td class="num">${ev?.distanceKm != null ? ev.distanceKm + " km" : ""}</td>
        <td>${esc(c.expectedSalary ?? "")}</td>
        <td>${esc(c.notes ?? "")}</td>
      </tr>`;
    })
    .join("");
  const fecha = new Date().toLocaleDateString("es-AR");
  const html = `<!doctype html><html lang="es"><head><meta charset="utf-8">
    <title>${esc(jobTitle)} — candidatos</title>
    <style>
      body{font:13px/1.4 system-ui,Arial,sans-serif;color:#111;margin:24px}
      h1{font-size:18px;margin:0 0 2px}
      .sub{color:#666;font-size:12px;margin:0 0 16px}
      table{border-collapse:collapse;width:100%}
      th,td{border:1px solid #ddd;padding:6px 8px;text-align:left;vertical-align:top}
      th{background:#f3f4f6;font-size:11px;text-transform:uppercase;letter-spacing:.03em}
      td.num{text-align:center;white-space:nowrap}
      tr:nth-child(even) td{background:#fafafa}
      @media print{body{margin:0}}
    </style></head><body>
    <h1>${esc(jobTitle)}</h1>
    <p class="sub">${list.length} candidato${list.length !== 1 ? "s" : ""} · ${fecha} · LecturaCVs</p>
    <table>
      <thead><tr>
        <th>#</th><th>Nombre</th><th>Puntaje</th><th>Calificación</th><th>Estado</th>
        <th>Edad</th><th>Distancia</th><th>Sueldo pret.</th><th>Notas</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <script>window.onload=function(){window.print();}</script>
  </body></html>`;
  const w = window.open("", "_blank");
  if (!w) {
    alert("Permití las ventanas emergentes para generar el PDF.");
    return;
  }
  w.document.open();
  w.document.write(html);
  w.document.close();
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
  onExportBackup,
  onImportBackup,
  onLogout,
  googleConnected,
  googleEmail,
  onConnectGoogle,
  onDisconnectGoogle,
  bookingUrl,
  onBookingUrl,
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
  onExportBackup: () => void;
  onImportBackup: (file: File) => void;
  onLogout: () => void;
  googleConnected: boolean;
  googleEmail: string;
  onConnectGoogle: () => void;
  onDisconnectGoogle: () => void;
  bookingUrl: string;
  onBookingUrl: (v: string) => void;
}) {
  const backupFileRef = useRef<HTMLInputElement>(null);
  return (
    <>
      <div className="profile-top">
        <button className="back-btn" onClick={onBack}>
          ← Volver
        </button>
        <button className="btn btn-ghost btn-sm" onClick={onLogout}>
          🔒 Cerrar sesión
        </button>
      </div>

      <section className="card">
        <h3 className="profile-h3" style={{ marginTop: 0 }}>
          📅 Google Calendar
        </h3>
        <p className="field-hint" style={{ marginTop: 0 }}>
          Conectá una cuenta de Google para <strong>agendar entrevistas</strong> y generar el link de
          <strong> Meet</strong> automáticamente desde el botón «Enviar mail» del tablero.
        </p>
        {googleConnected ? (
          <div className="gcal-row">
            <span className="gcal-ok">
              ✓ Conectado{googleEmail ? ` como ${googleEmail}` : ""}
            </span>
            <button className="btn btn-ghost btn-sm" onClick={onDisconnectGoogle}>
              Desconectar
            </button>
          </div>
        ) : (
          <button className="btn btn-primary" onClick={onConnectGoogle}>
            Conectar Google Calendar
          </button>
        )}

        <h4 style={{ marginTop: 18, marginBottom: 4 }}>
          Página de reservas (que el candidato elija el horario)
        </h4>
        <p className="field-hint" style={{ marginTop: 0 }}>
          Pegá el link de tu <strong>página de reservas</strong> de Google Calendar. Después, en el
          mail vas a tener un botón para insertarlo, así el candidato elige el horario que le queda.
        </p>
        <input
          type="url"
          className="booking-input"
          placeholder="https://calendar.app.google/..."
          value={bookingUrl}
          onChange={(e) => onBookingUrl(e.target.value)}
        />
      </section>
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
        {/* Sedes en edición (sin confirmar): se cargan acá arriba. */}
        {sedes
          .filter((s) => !s.confirmed)
          .map((s) => {
            const ready = s.label.trim() !== "" && s.address.trim() !== "";
            return (
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
                  className="icon-btn sede-confirm"
                  title={ready ? "Confirmar sede" : "Completá nombre y dirección"}
                  disabled={!ready}
                  onClick={() => onUpdateSede(s.id, { confirmed: true })}
                >
                  ✓
                </button>
                <button
                  className="icon-btn sede-del"
                  title="Eliminar sede"
                  onClick={() => onRemoveSede(s.id)}
                >
                  🗑
                </button>
              </div>
            );
          })}
        <button className="btn btn-ghost" style={{ marginTop: 10 }} onClick={onAddSede}>
          + Agregar sede
        </button>

        {/* Sedes confirmadas: quedan listadas abajo. */}
        {sedes.some((s) => s.confirmed) && (
          <div className="sede-confirmed-list">
            <h3 className="profile-h3">Sedes</h3>
            {sedes
              .filter((s) => s.confirmed)
              .map((s) => (
                <div className="sede-done" key={s.id}>
                  <span className="sede-done-pin">📍</span>
                  <div className="sede-done-info">
                    <span className="sede-done-label">{s.label.trim() || "(sin nombre)"}</span>
                    <span className="sede-done-addr">{s.address}</span>
                  </div>
                  <button
                    className="icon-btn sede-edit"
                    title="Editar sede"
                    onClick={() => onUpdateSede(s.id, { confirmed: false })}
                  >
                    ✎
                  </button>
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

      <section className="card">
        <h3 className="profile-h3" style={{ marginTop: 0 }}>
          💾 Copia de seguridad
        </h3>
        <p className="field-hint" style={{ marginTop: 0 }}>
          Tus datos (búsquedas, candidatos, notas y calificaciones) se guardan{" "}
          <strong>solo en este navegador</strong>. Descargá una copia cada tanto para no perderlos
          y poder pasarlos a otra computadora.
        </p>
        <div className="backup-actions">
          <button className="btn btn-primary" onClick={onExportBackup}>
            ⬇ Descargar copia
          </button>
          <button className="btn btn-ghost" onClick={() => backupFileRef.current?.click()}>
            ⬆ Restaurar copia
          </button>
          <input
            ref={backupFileRef}
            type="file"
            accept="application/json,.json"
            style={{ display: "none" }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) onImportBackup(f);
              e.target.value = "";
            }}
          />
        </div>
        <p className="field-hint" style={{ marginTop: 8 }}>
          Restaurar una copia <strong>reemplaza</strong> todo lo que tengas cargado ahora.
        </p>
      </section>
    </>
  );
}

// Tablero kanban de una búsqueda: columnas por etapa, tarjetas que se arrastran
// entre etapas (o se mueven con el menú), y etapas personalizables.
function Board({
  job,
  stages,
  onMove,
  onRemove,
  onAddStage,
  onRenameStage,
  onDeleteStage,
  onMoveStage,
  onViewCv,
  onNotes,
  onSendMail,
  onStartWa,
}: {
  job: Job;
  stages: Stage[];
  onMove: (candId: string, stageId: string) => void;
  onRemove: (candId: string) => void;
  onAddStage: () => void;
  onRenameStage: (stageId: string, current: string) => void;
  onDeleteStage: (stageId: string) => void;
  onMoveStage: (stageId: string, dir: -1 | 1) => void;
  onViewCv: (c: { name: string; emailUid?: number; cvText?: string }) => void;
  onNotes: (candId: string, t: string) => void;
  onSendMail: (cand: Candidate) => void;
  onStartWa: (cand: Candidate) => void;
}) {
  const [openCards, setOpenCards] = useState<Set<string>>(new Set());
  const toggleCard = (id: string) =>
    setOpenCards((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  // El tablero muestra a quienes están en una etapa. La sincronización con la Lista
  // se mantiene por las acciones (preseleccionar agrega; quitar la condición o la ✕
  // sacan, limpiando la etapa). Así no se esconde a nadie que ya estuviera en curso.
  const onBoard = job.candidates.filter((c) => c.stageId);
  const firstStage = stages[0]?.id;
  const validIds = new Set(stages.map((s) => s.id));
  const effStage = (c: Candidate) =>
    c.stageId && validIds.has(c.stageId) ? c.stageId : firstStage;
  const byStage = (sid: string) =>
    onBoard
      .filter((c) => effStage(c) === sid)
      .sort((a, b) => (b.evaluation?.overallScore ?? -1) - (a.evaluation?.overallScore ?? -1));
  return (
    <div className="board">
      {onBoard.length === 0 && (
        <p className="board-hint">
          Todavía no hay candidatos en el tablero. En la vista <b>Lista</b>, marcá a alguien como{" "}
          <b>Preseleccionado</b> para que entre acá; después arrastrá su tarjeta entre las etapas (o
          usá el menú «mover»).
        </p>
      )}
      <div className="board-cols">
        {stages.map((st, idx) => {
          const list = byStage(st.id);
          return (
            <div
              key={st.id}
              className="board-col"
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                const id = e.dataTransfer.getData("text/cand");
                if (id) onMove(id, st.id);
              }}
            >
              <div className="board-col-head">
                <span className="board-col-title">{st.label}</span>
                <span className="board-col-count">{list.length}</span>
                <div className="board-col-actions">
                  <button
                    className="icon-btn"
                    title="Mover etapa a la izquierda"
                    onClick={() => onMoveStage(st.id, -1)}
                    disabled={idx === 0}
                  >
                    ‹
                  </button>
                  <button
                    className="icon-btn"
                    title="Mover etapa a la derecha"
                    onClick={() => onMoveStage(st.id, 1)}
                    disabled={idx === stages.length - 1}
                  >
                    ›
                  </button>
                  <button
                    className="icon-btn"
                    title="Renombrar etapa"
                    onClick={() => onRenameStage(st.id, st.label)}
                  >
                    ✎
                  </button>
                  <button
                    className="icon-btn"
                    title="Borrar etapa"
                    onClick={() => onDeleteStage(st.id)}
                  >
                    🗑
                  </button>
                </div>
              </div>
              <div className="board-col-body">
                {list.map((c) => {
                  const open = openCards.has(c.id);
                  return (
                    <div key={c.id} className="board-card">
                      <div
                        className="board-card-top"
                        draggable
                        onDragStart={(e) => e.dataTransfer.setData("text/cand", c.id)}
                        onClick={() => toggleCard(c.id)}
                        title="Arrastrá para mover de etapa · tocá para ver acciones"
                        style={{ cursor: "pointer" }}
                      >
                        <span className="board-grip" aria-hidden="true">
                          ⠿
                        </span>
                        {c.evaluation && (
                          <span className={`score-chip ${scoreClass(c.evaluation.overallScore)}`}>
                            {toTen(c.evaluation.overallScore)}
                          </span>
                        )}
                        <span className="board-card-name">{c.name}</span>
                        {c.notes ? <span title="Tiene nota">📝</span> : null}
                      </div>
                      <div className="board-card-meta">
                        {c.evaluation?.age != null ? `${c.evaluation.age} años · ` : ""}
                        {c.evaluation?.distanceKm != null ? `${c.evaluation.distanceKm} km · ` : ""}
                        {c.expectedSalary ? `pretende ${c.expectedSalary}` : ""}
                      </div>
                      {open && (
                        <>
                          <div className="board-card-actions">
                            <button
                              className="icon-btn"
                              title="Ver CV completo (con opción de imprimir)"
                              onClick={() =>
                                onViewCv({ name: c.name, emailUid: c.emailUid, cvText: c.cvText })
                              }
                            >
                              📄
                            </button>
                            <button
                              className="icon-btn"
                              title="Enviar un mail al candidato"
                              onClick={() => onSendMail(c)}
                            >
                              ✉️
                            </button>
                            <button
                              className="icon-btn"
                              title="Iniciar evaluación por WhatsApp"
                              onClick={() => onStartWa(c)}
                            >
                              🤖
                            </button>
                            <button
                              className="icon-btn"
                              title="Quitar del tablero (vuelve a Sin calificar)"
                              onClick={() => onRemove(c.id)}
                            >
                              ✕
                            </button>
                          </div>
                          <label className="board-move-row">
                            Mover a:
                            <select
                              value={effStage(c)}
                              onChange={(e) => onMove(c.id, e.target.value)}
                              title="Mover a otra etapa"
                            >
                              {stages.map((s) => (
                                <option key={s.id} value={s.id}>
                                  {s.label}
                                </option>
                              ))}
                            </select>
                          </label>
                          <textarea
                            className="board-note"
                            rows={2}
                            placeholder="📝 Nota… (se ve también en la Lista)"
                            value={c.notes ?? ""}
                            onChange={(e) => onNotes(c.id, e.target.value)}
                          />
                        </>
                      )}
                    </div>
                  );
                })}
                {list.length === 0 && <div className="board-empty">Soltá acá una tarjeta</div>}
              </div>
            </div>
          );
        })}
        <button className="board-add" onClick={onAddStage} title="Agregar una etapa nueva">
          ➕ Agregar etapa
        </button>
      </div>
    </div>
  );
}

// Saca el primer mail del candidato del texto del CV (ignora los de ZonaJobs).
function extractEmail(text?: string): string {
  if (!text) return "";
  const matches = text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) || [];
  return matches.find((m) => !/zonajobs|no_reply|noreply|bumeran/i.test(m)) || "";
}

// Saca un teléfono del CV (prioriza el que está al lado de "Tel/Cel/WhatsApp").
function extractPhone(text?: string): string {
  if (!text) return "";
  const labeled = text.match(
    /(?:tel[eé]fono|tel\.?|cel(?:ular)?|whats?app|wpp|m[oó]vil|contacto)[:\s]*(\+?[\d\s().-]{7,18})/i,
  );
  if (labeled?.[1]) return labeled[1];
  const any = (text.match(/\+?\d[\d\s().-]{7,16}\d/g) || [])
    .filter((s) => s.replace(/\D/g, "").length >= 8 && s.replace(/\D/g, "").length <= 15);
  return any[0] || "";
}

// Pasa un teléfono a formato para wa.me (Argentina por defecto: 549 + número).
// Es un mejor-esfuerzo: el usuario lo verifica/edita en el campo.
function toWaNumber(raw: string): string {
  let d = (raw || "").replace(/\D/g, "");
  if (!d) return "";
  if (d.startsWith("54")) return d;
  d = d.replace(/^0/, "");
  return "549" + d;
}

type MailType = "contacto" | "entrevista" | "rechazo";

// Compositor de mail (manual): elegís el tipo, se arma un borrador editable y lo
// copiás o lo abrís en Gmail para enviarlo. El envío automático desde la app se
// activará cuando se conecte el mail nuevo.
function MailComposer({
  cand,
  jobTitle,
  sede,
  sendMail,
  scheduleInterview,
  googleConnected,
  bookingUrl,
  onClose,
}: {
  cand: Candidate;
  jobTitle: string;
  sede: string;
  sendMail: (
    to: string,
    subject: string,
    body: string,
    files: File[],
  ) => Promise<{ ok: boolean; error?: string }>;
  scheduleInterview: (payload: {
    summary: string;
    description: string;
    startISO: string;
    durationMin: number;
    online: boolean;
    location?: string;
    force?: boolean;
  }) => Promise<{
    ok: boolean;
    meetLink?: string;
    htmlLink?: string;
    error?: string;
    conflict?: boolean;
    conflicts?: { summary: string; start: string }[];
  }>;
  googleConnected: boolean;
  bookingUrl: string;
  onClose: () => void;
}) {
  const first = cand.name.split(/\s+/)[0] || cand.name;
  const [to, setTo] = useState(extractEmail(cand.cvText));
  const [phone, setPhone] = useState(toWaNumber(extractPhone(cand.cvText)));
  const [type, setType] = useState<MailType>("contacto");
  const [modo, setModo] = useState<"presencial" | "online">("presencial");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [copied, setCopied] = useState(false);
  const [sending, setSending] = useState(false);
  const [sentMsg, setSentMsg] = useState("");
  const [errMsg, setErrMsg] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);
  // Agendado (solo para tipo "entrevista").
  const [schedDate, setSchedDate] = useState("");
  const [schedTime, setSchedTime] = useState("");
  const [schedDur, setSchedDur] = useState(30);
  const [scheduling, setScheduling] = useState(false);

  async function doSend() {
    setSending(true);
    setErrMsg("");
    setSentMsg("");
    const r = await sendMail(to, subject, body, files);
    setSending(false);
    if (r.ok) {
      setSentMsg("✓ Mail enviado");
      window.setTimeout(onClose, 1200);
    } else {
      setErrMsg(r.error || "No se pudo enviar.");
    }
  }

  async function doSchedule() {
    setErrMsg("");
    setSentMsg("");
    if (!schedDate || !schedTime) {
      setErrMsg("Elegí fecha y hora para agendar la entrevista.");
      return;
    }
    const start = new Date(`${schedDate}T${schedTime}`);
    if (isNaN(start.getTime())) {
      setErrMsg("Fecha/hora inválida.");
      return;
    }
    setScheduling(true);
    const online = modo === "online";
    const base = {
      summary: `Entrevista – ${jobTitle || "candidato"} – ${cand.name}`,
      description: body,
      startISO: start.toISOString(),
      durationMin: schedDur,
      online,
      location: online ? "" : sede,
    };
    let r = await scheduleInterview(base);
    // Aviso (no bloqueante) si ya hay otra entrevista a esa hora.
    if (r.conflict) {
      const lista = (r.conflicts || [])
        .map((c) => {
          const t = c.start ? new Date(c.start) : null;
          const hora = t && !isNaN(t.getTime())
            ? t.toLocaleString("es-AR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })
            : "";
          return `• ${c.summary}${hora ? ` (${hora})` : ""}`;
        })
        .join("\n");
      const seguir = window.confirm(
        `⚠️ Ya hay ${r.conflicts?.length || "otra"} entrevista(s) en ese horario:\n${lista}\n\n¿Querés agendar igual de todos modos?`,
      );
      if (!seguir) {
        setScheduling(false);
        return;
      }
      r = await scheduleInterview({ ...base, force: true });
    }
    setScheduling(false);
    if (!r.ok) {
      setErrMsg(r.error || "No se pudo agendar.");
      return;
    }
    // Insertamos fecha/hora (y el link de Meet si es online) al final del mensaje.
    const fecha = `${schedDate.slice(8, 10)}/${schedDate.slice(5, 7)}/${schedDate.slice(0, 4)}`;
    let extra = `\n\n📅 Entrevista: ${fecha} a las ${schedTime} hs.`;
    if (online && r.meetLink) extra += `\n🔗 Link de videollamada (Meet): ${r.meetLink}`;
    else if (!online && sede) extra += `\n📍 Lugar: ${sede}`;
    setBody((b) => b + extra);
    setSentMsg(online ? "✓ Entrevista agendada y Meet generado" : "✓ Entrevista agendada");
  }

  // Plantillas iniciales (provisorias; se afinan después). Se regeneran al cambiar
  // el tipo o el modo, pero respetan lo que edites mientras no cambies de tipo.
  useEffect(() => {
    const puesto = jobTitle.trim() ? ` para la búsqueda de ${jobTitle.trim()}` : "";
    const tit = jobTitle.trim() ? ` – ${jobTitle.trim()}` : "";
    const esAdmin = /admin|contab|administrativ/i.test(jobTitle);
    const esDiseno = /dise|gr[aá]fic|ux|ui/i.test(jobTitle);
    if (type === "contacto") {
      if (esAdmin) {
        setSubject(`Postulación – ${jobTitle.trim() || "Administrativo"} (Loekemeyer SRL)`);
        setBody(
          `Estimado postulante,\n\n` +
            `Recibimos tu CV y fue seleccionado por nuestra empresa Loekemeyer SRL. ` +
            `Nuestra empresa está en la búsqueda de personal administrativo para su sede en Devoto.\n\n` +
            `Te adjunto un archivo Excel con las herramientas que necesitamos que sepas o aprendas. ` +
            `En una hoja tenés un ejercicio y en la otra la explicación de cómo resolverlo. ` +
            `Una vez resuelto, nos lo compartís por este medio.\n\n` +
            `La idea es que puedas hacer los ejercicios para que los evaluemos. En caso de que avances ` +
            `en el proceso de selección, el siguiente paso será coordinar la instancia de entrevista presencial.\n\n` +
            `Indícanos por favor tu disponibilidad horaria para una posible entrevista presencial o virtual. ` +
            `Agradeceríamos nos indiques en caso de no tener interés.\n\n` +
            `¡Saludos!`,
        );
      } else if (esDiseno) {
        setSubject(`Tu postulación${tit}`);
        setBody(
          `Hola ${first}, ¿cómo estás?\n\nRecibimos tu CV${puesto} y nos interesó tu perfil. ` +
            `Como primer paso te pedimos que nos compartas tu portfolio para evaluarlo; según esa ` +
            `evaluación coordinamos una entrevista.\n\n¿Tenés disponibilidad estos días?\n\n¡Gracias!\nSaludos,`,
        );
      } else {
        setSubject(`Tu postulación${tit}`);
        setBody(
          `Hola ${first}, ¿cómo estás?\n\nRecibimos tu CV${puesto} y nos interesó tu perfil. ` +
            `Nos gustaría avanzar con tu proceso y contarte los próximos pasos.\n\n¿Tenés disponibilidad ` +
            `estos días?\n\n¡Gracias!\nSaludos,`,
        );
      }
    } else if (type === "entrevista") {
      setSubject(`Entrevista${tit}`);
      const lugar =
        modo === "presencial"
          ? `Sería una entrevista presencial${sede ? ` en ${sede}` : ""}.`
          : "Sería una entrevista online por videollamada (te enviamos el link al confirmar).";
      setBody(
        `Hola ${first}, ¿cómo estás?\n\nNos gustaría coordinar una entrevista${puesto}. ${lugar}\n\n¿Qué día y horario te quedan cómodos?\n\n¡Gracias!\nSaludos,`,
      );
    } else {
      setSubject(`Tu postulación${tit}`);
      setBody(
        `Hola ${first}, ¿cómo estás?\n\nGracias por tu interés y por el tiempo dedicado a tu postulación${puesto}. En esta oportunidad avanzamos con otros perfiles, pero guardamos tu CV para futuras búsquedas.\n\nTe deseamos muchos éxitos.\nSaludos,`,
      );
    }
  }, [type, modo, first, jobTitle, sede]);

  function copyBody() {
    navigator.clipboard?.writeText(body).then(
      () => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 2000);
      },
      () => {},
    );
  }
  function openGmail() {
    const url = `https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(
      to,
    )}&su=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
    window.open(url, "_blank");
  }
  function openWhatsApp() {
    const num = phone.replace(/\D/g, "");
    if (!num) return;
    window.open(`https://wa.me/${num}?text=${encodeURIComponent(body)}`, "_blank");
  }

  const TYPES: [MailType, string][] = [
    ["contacto", "Contacto"],
    ["entrevista", "Entrevista"],
    ["rechazo", "Rechazo"],
  ];

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <strong>✉️ Enviar mail – {cand.name}</strong>
          <button className="icon-btn" aria-label="Cerrar" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="modal-body mail-composer">
          <div className="mail-types">
            {TYPES.map(([v, l]) => (
              <button
                key={v}
                className={`mail-type-btn${type === v ? " on" : ""}`}
                onClick={() => setType(v)}
              >
                {l}
              </button>
            ))}
          </div>
          {type === "entrevista" && (
            <div className="mail-modo">
              <label className={`mail-modo-opt${modo === "presencial" ? " on" : ""}`}>
                <input
                  type="radio"
                  checked={modo === "presencial"}
                  onChange={() => setModo("presencial")}
                />
                Presencial
              </label>
              <label className={`mail-modo-opt${modo === "online" ? " on" : ""}`}>
                <input type="radio" checked={modo === "online"} onChange={() => setModo("online")} />
                Online
              </label>
            </div>
          )}
          {type === "entrevista" && (
            <div className="mail-sched">
              <div className="mail-sched-row">
                <label className="mail-field">
                  Fecha
                  <input
                    type="date"
                    value={schedDate}
                    onChange={(e) => setSchedDate(e.target.value)}
                  />
                </label>
                <label className="mail-field">
                  Hora
                  <input
                    type="time"
                    value={schedTime}
                    onChange={(e) => setSchedTime(e.target.value)}
                  />
                </label>
                <label className="mail-field">
                  Duración
                  <select value={schedDur} onChange={(e) => setSchedDur(Number(e.target.value))}>
                    <option value={15}>15 min</option>
                    <option value={30}>30 min</option>
                    <option value={45}>45 min</option>
                    <option value={60}>60 min</option>
                  </select>
                </label>
              </div>
              {googleConnected ? (
                <button className="btn btn-ghost btn-sm" onClick={doSchedule} disabled={scheduling}>
                  {scheduling ? (
                    <>
                      <span className="spinner" /> Agendando…
                    </>
                  ) : modo === "online" ? (
                    "📅 Agendar + generar Meet"
                  ) : (
                    "📅 Agendar en Calendar"
                  )}
                </button>
              ) : (
                <p className="mail-warn">
                  Conectá Google Calendar en «Mi perfil» para agendar y generar el Meet.
                </p>
              )}
            </div>
          )}
          <label className="mail-field">
            Para
            <input
              type="email"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              placeholder="mail@candidato.com"
            />
          </label>
          {!to && (
            <p className="mail-warn">No encontré el mail en el CV — cargalo a mano para enviarlo.</p>
          )}
          <label className="mail-field">
            WhatsApp (con código de país)
            <input
              type="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="5491112345678"
            />
          </label>
          <label className="mail-field">
            Asunto
            <input type="text" value={subject} onChange={(e) => setSubject(e.target.value)} />
          </label>
          <label className="mail-field">
            Mensaje
            <textarea rows={10} value={body} onChange={(e) => setBody(e.target.value)} />
          </label>
          {bookingUrl && (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              style={{ alignSelf: "flex-start" }}
              onClick={() =>
                setBody((b) => `${b}\n\nElegí el horario que te quede cómodo acá: ${bookingUrl}`)
              }
            >
              🔗 Insertar link de reservas
            </button>
          )}
          <div className="mail-attach">
            <input
              ref={fileRef}
              type="file"
              multiple
              style={{ display: "none" }}
              onChange={(e) => {
                const list = e.target.files ? Array.from(e.target.files) : [];
                if (list.length) setFiles((prev) => [...prev, ...list]);
                e.target.value = "";
              }}
            />
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              style={{ alignSelf: "flex-start" }}
              onClick={() => fileRef.current?.click()}
            >
              📎 Adjuntar archivo
            </button>
            {files.length > 0 && (
              <ul className="mail-files">
                {files.map((f, i) => (
                  <li key={i}>
                    📄 {f.name}{" "}
                    <span className="mail-file-size">({Math.round(f.size / 1024)} KB)</span>
                    <button
                      type="button"
                      className="icon-btn"
                      title="Quitar"
                      onClick={() => setFiles((prev) => prev.filter((_, k) => k !== i))}
                    >
                      ×
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {files.length > 0 && (
              <p className="field-hint" style={{ margin: 0 }}>
                Los adjuntos se mandan solo con «✅ Enviar» (no con Copiar ni Abrir en Gmail).
              </p>
            )}
          </div>
          <p className="field-hint" style={{ marginTop: 0 }}>
            Se envía desde la cuenta de reclutamiento. También podés copiarlo o abrirlo en Gmail para
            mandarlo a mano.
          </p>
          {errMsg && <div className="error-box">{errMsg}</div>}
          {sentMsg && <div className="mail-sent">{sentMsg}</div>}
          <div className="mail-actions">
            <button className="btn btn-ghost" onClick={copyBody} disabled={sending}>
              {copied ? "✓ Copiado" : "📋 Copiar"}
            </button>
            <button className="btn btn-ghost" onClick={openGmail} disabled={!to || sending}>
              ✉️ Abrir en Gmail
            </button>
            <button
              className="btn btn-ghost"
              onClick={openWhatsApp}
              disabled={!phone}
              title="Abrir WhatsApp con el mensaje y el número del candidato"
            >
              📱 WhatsApp
            </button>
            <button className="btn btn-primary" onClick={doSend} disabled={!to || sending}>
              {sending ? (
                <>
                  <span className="spinner" /> Enviando…
                </>
              ) : (
                "✅ Enviar"
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// Bot de WhatsApp: editar las preguntas por área + ver las evaluaciones.
interface AreaCfg {
  id: string;
  label: string;
  position: number;
  questions: { q: string }[];
  excel_message: string | null;
  final_message: string | null;
  enabled: boolean;
}
interface BotSess {
  id: string;
  candidate_id: string;
  candidate_name?: string | null;
  search_id: string | null;
  area: string | null;
  status: string;
  score: number | null;
  excel_score: number | null;
  answers: { q: string; a: string }[];
  excel_detail?: {
    summary?: string;
    total?: number;
    max?: number;
    dimensions?: { name: string; score: number; max: number; justification: string }[];
  } | null;
}

function WaBot({
  jobs,
  authHeaders,
}: {
  jobs: Job[];
  authHeaders: () => Record<string, string>;
}) {
  const [areas, setAreas] = useState<AreaCfg[]>([]);
  const [initial, setInitial] = useState("");
  const [sessions, setSessions] = useState<BotSess[]>([]);
  const [loading, setLoading] = useState(true);
  const [openSess, setOpenSess] = useState<string | null>(null);
  const [openAviso, setOpenAviso] = useState<string | null>(null);
  const [flash, setFlash] = useState("");

  useEffect(() => {
    (async () => {
      try {
        const [aRes, sRes] = await Promise.all([
          fetch("/api/whatsapp/areas", { headers: authHeaders() }),
          fetch("/api/whatsapp/sessions", { headers: authHeaders() }),
        ]);
        const a = await aRes.json().catch(() => ({}));
        const s = await sRes.json().catch(() => ({}));
        setAreas(Array.isArray(a.areas) ? a.areas : []);
        setInitial(a.initialMessage || "");
        setSessions(Array.isArray(s.sessions) ? s.sessions : []);
      } finally {
        setLoading(false);
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    })();
  }, []);

  const candName = useMemo(() => {
    const m = new Map<string, string>();
    for (const j of jobs) for (const c of j.candidates) m.set(c.id, c.name);
    return m;
  }, [jobs]);
  // Evaluaciones agrupadas por aviso (búsqueda). Lista TODOS los avisos; los que
  // tienen evaluaciones primero. Las sesiones sin aviso conocido van a "Sin aviso".
  const avisoGroups = useMemo(() => {
    const byId = new Map<string, BotSess[]>();
    for (const s of sessions) {
      const k = s.search_id || "_none";
      const list = byId.get(k) || [];
      list.push(s);
      byId.set(k, list);
    }
    const known = new Set(jobs.map((j) => j.id));
    const groups = jobs.map((j) => ({ id: j.id, title: j.title, sessions: byId.get(j.id) || [] }));
    const orphans: BotSess[] = [];
    for (const [k, list] of byId) if (k === "_none" || !known.has(k)) orphans.push(...list);
    if (orphans.length) groups.push({ id: "_none", title: "Sin aviso", sessions: orphans });
    return groups.sort((a, b) => b.sessions.length - a.sessions.length);
  }, [sessions, jobs]);

  async function deleteSession(id: string) {
    if (!window.confirm("¿Borrar esta evaluación? No se puede deshacer.")) return;
    await fetch(`/api/whatsapp/sessions?id=${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: authHeaders(),
    });
    setSessions((prev) => prev.filter((x) => x.id !== id));
    notify("Evaluación borrada ✓");
  }

  // Abre el Excel que envió el candidato (enlace firmado temporal).
  async function downloadExcel(id: string) {
    try {
      const r = await fetch(`/api/whatsapp/excel?id=${encodeURIComponent(id)}`, {
        headers: authHeaders(),
      });
      const d = await r.json().catch(() => ({}));
      if (d.url) window.open(d.url, "_blank");
      else notify(d.error || "No se pudo abrir el Excel.");
    } catch {
      notify("No se pudo abrir el Excel.");
    }
  }

  function notify(t: string) {
    setFlash(t);
    window.setTimeout(() => setFlash(""), 2500);
  }
  function setArea(id: string, patch: Partial<AreaCfg>) {
    setAreas((prev) => prev.map((a) => (a.id === id ? { ...a, ...patch } : a)));
  }
  async function saveArea(a: AreaCfg) {
    await fetch("/api/whatsapp/areas", {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders() },
      body: JSON.stringify({ area: a }),
    });
    notify(`«${a.label}» guardada ✓`);
  }
  async function saveInitial() {
    await fetch("/api/whatsapp/areas", {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders() },
      body: JSON.stringify({ initialMessage: initial }),
    });
    notify("Mensaje inicial guardado ✓");
  }

  if (loading) {
    return (
      <section className="card">
        <span className="spinner" /> Cargando…
      </section>
    );
  }

  return (
    <>
      {flash && <div className="toast">{flash}</div>}

      {/* EVALUACIONES arriba, agrupadas por aviso */}
      <section className="card">
        <div className="results-toolbar">
          <h2 style={{ margin: 0 }}>📊 Evaluaciones por aviso</h2>
          <span className="count">{sessions.length}</span>
        </div>
        <p className="field-hint" style={{ marginTop: 6 }}>
          Entrá a un aviso para ver sus evaluaciones. <strong>Resp</strong> = puntaje de las
          respuestas; <strong>Excel</strong> = puntaje de la prueba. Tocá el nombre para ver el detalle.
        </p>
        {avisoGroups.length === 0 ? (
          <p className="empty">Todavía no hay avisos.</p>
        ) : (
          avisoGroups.map((g) => (
            <div key={g.id} style={{ borderTop: "1px solid #eee" }}>
              <div
                onClick={() => setOpenAviso((o) => (o === g.id ? null : g.id))}
                style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 2px", cursor: "pointer" }}
              >
                <strong style={{ flex: 1 }}>{g.title}</strong>
                <span className="count">{g.sessions.length}</span>
                <span className="chevron">▾</span>
              </div>
              {openAviso === g.id &&
                (g.sessions.length === 0 ? (
                  <p className="empty" style={{ paddingBottom: 10 }}>
                    Sin evaluaciones todavía.
                  </p>
                ) : (
                  <div className="wabot-sessions">
                    {g.sessions.map((s) => (
                      <div className="wabot-sess" key={s.id}>
                        <div className="wabot-sess-head">
                          <span
                            className="wabot-sess-name"
                            style={{ flex: 1, cursor: "pointer" }}
                            onClick={() => setOpenSess((o) => (o === s.id ? null : s.id))}
                          >
                            {s.candidate_name || candName.get(s.candidate_id) || "Candidato"}
                          </span>
                          <span className={`wabot-sess-status st-${s.status}`}>{s.status}</span>
                          <span className="wabot-sess-score">
                            {s.score != null ? `Resp ${s.score}/10` : ""}
                            {s.excel_score != null
                              ? `${s.score != null ? " · " : ""}Excel ${s.excel_score}/10`
                              : ""}
                          </span>
                          <button
                            className="icon-btn"
                            title="Borrar evaluación"
                            onClick={() => deleteSession(s.id)}
                          >
                            🗑
                          </button>
                          <span
                            className="chevron"
                            style={{ cursor: "pointer" }}
                            onClick={() => setOpenSess((o) => (o === s.id ? null : s.id))}
                          >
                            ▾
                          </span>
                        </div>
                        {openSess === s.id && (
                          <div className="wabot-sess-body">
                            {(s.answers || []).map((qa, i) => (
                              <div className="wabot-qa" key={i}>
                                <div className="wabot-qa-q">{qa.q}</div>
                                <div className="wabot-qa-a">{qa.a}</div>
                              </div>
                            ))}
                            {(s.excel_detail || s.excel_score != null) && (
                              <button
                                className="btn btn-ghost btn-sm"
                                style={{ marginTop: 8 }}
                                onClick={() => downloadExcel(s.id)}
                              >
                                ⬇ Descargar Excel del candidato
                              </button>
                            )}
                            {s.excel_detail && (
                              <div className="wabot-excel">
                                <h4>
                                  Prueba de Excel — {s.excel_detail.total ?? s.excel_score}/
                                  {s.excel_detail.max ?? 10}
                                </h4>
                                {s.excel_detail.summary && <p className="why">{s.excel_detail.summary}</p>}
                                {(s.excel_detail.dimensions || []).map((d, i) => (
                                  <div className="crit" key={i}>
                                    <div className="crit-top">
                                      <span className="cname">{d.name}</span>
                                      <span className="cscore">
                                        {d.score}/{d.max}
                                      </span>
                                    </div>
                                    <p className="why">{d.justification}</p>
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                ))}
            </div>
          ))
        )}
      </section>

      <section className="card">
        <h2 style={{ margin: 0 }}>🤖 Bot de WhatsApp — preguntas</h2>
        <p className="field-hint" style={{ marginTop: 6 }}>
          Acá editás las <strong>preguntas de cada puesto</strong>. El bot salta el menú: saluda con el
          nombre del candidato y el aviso (vía la plantilla de Meta) y va directo a las preguntas del
          puesto que corresponde a la búsqueda.
        </p>
        <details style={{ marginTop: 6 }}>
          <summary className="field-hint" style={{ cursor: "pointer" }}>
            Mensaje inicial (referencia — lo maneja la plantilla de Meta)
          </summary>
          <textarea
            className="posting-input"
            rows={6}
            value={initial}
            onChange={(e) => setInitial(e.target.value)}
          />
          <button className="btn btn-ghost btn-sm" style={{ marginTop: 8 }} onClick={saveInitial}>
            Guardar texto de referencia
          </button>
        </details>
      </section>

      {areas
        .slice()
        .sort((a, b) => a.position - b.position)
        .map((a) => (
          <section className="card" key={a.id}>
            <div className="results-toolbar">
              <h3 style={{ margin: 0 }}>
                {a.position}. {a.label}
              </h3>
              <label className="cf-field" style={{ gap: 6 }}>
                <input
                  type="checkbox"
                  checked={a.enabled}
                  onChange={(e) => setArea(a.id, { enabled: e.target.checked })}
                />
                Activa
              </label>
            </div>
            <h4>Preguntas ({a.questions?.length || 0})</h4>
            {(a.questions || []).map((qq, i) => (
              <div className="wabot-q" key={i}>
                <span className="wabot-qn">{i + 1}</span>
                <textarea
                  rows={2}
                  value={qq.q}
                  onChange={(e) => {
                    const qs = [...a.questions];
                    qs[i] = { q: e.target.value };
                    setArea(a.id, { questions: qs });
                  }}
                />
                <button
                  className="icon-btn"
                  title="Quitar"
                  onClick={() => setArea(a.id, { questions: a.questions.filter((_, k) => k !== i) })}
                >
                  ×
                </button>
              </div>
            ))}
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => setArea(a.id, { questions: [...(a.questions || []), { q: "" }] })}
            >
              + Agregar pregunta
            </button>
            <h4 style={{ marginTop: 12 }}>Mensaje al enviar el Excel</h4>
            <textarea
              className="posting-input"
              rows={3}
              value={a.excel_message || ""}
              onChange={(e) => setArea(a.id, { excel_message: e.target.value })}
            />
            <h4 style={{ marginTop: 12 }}>Mensaje final</h4>
            <textarea
              className="posting-input"
              rows={3}
              value={a.final_message || ""}
              onChange={(e) => setArea(a.id, { final_message: e.target.value })}
            />
            <div style={{ marginTop: 10 }}>
              <button className="btn btn-primary" onClick={() => saveArea(a)}>
                Guardar «{a.label}»
              </button>
            </div>
          </section>
        ))}

    </>
  );
}

// Buscador global: busca palabras clave (habilidades, herramientas, etc.) en TODOS
// los candidatos de TODAS las búsquedas. Trabaja sobre los datos ya cargados.
function GlobalSearch({
  jobs,
  onOpenJob,
  onViewCv,
}: {
  jobs: Job[];
  onOpenJob: (jobId: string) => void;
  onViewCv: (c: { name: string; emailUid?: number; cvText?: string }) => void;
}) {
  const [q, setQ] = useState("");

  // Índice (texto buscable por candidato). Se arma una sola vez por cambio de datos.
  const index = useMemo(() => {
    const arr: { jobId: string; jobTitle: string; cand: Candidate; text: string; hay: string }[] = [];
    for (const j of jobs) {
      for (const c of j.candidates) {
        const ev = c.evaluation;
        const text = [
          c.name,
          c.cvText,
          ev?.summary,
          ...(ev?.strengths ?? []),
          ...(ev?.concerns ?? []),
          ...((ev?.criteria ?? []).map((cr) => cr.justification)),
          ev?.location,
          c.notes,
        ]
          .filter(Boolean)
          .join("  ");
        arr.push({ jobId: j.id, jobTitle: j.title, cand: c, text, hay: stripAccents(text) });
      }
    }
    return arr;
  }, [jobs]);

  const { results, terms } = useMemo(() => {
    const raw = q.trim().toLowerCase().split(/\s+/).filter((t) => t.length >= 2);
    const matchTerms = raw.map(stripAccents);
    if (!matchTerms.length) return { results: [], terms: raw };
    const out = index.filter((it) => matchTerms.every((t) => it.hay.includes(t)));
    out.sort(
      (a, b) => (b.cand.evaluation?.overallScore ?? -1) - (a.cand.evaluation?.overallScore ?? -1),
    );
    return { results: out, terms: raw };
  }, [index, q]);

  // Fragmento del CV alrededor de la primera coincidencia.
  function snippet(text: string): string {
    if (!text) return "";
    const low = text.toLowerCase();
    let idx = -1;
    for (const t of terms) {
      const i = low.indexOf(t);
      if (i >= 0 && (idx < 0 || i < idx)) idx = i;
    }
    if (idx < 0) return text.slice(0, 160).trim() + (text.length > 160 ? "…" : "");
    const start = Math.max(0, idx - 60);
    return (start > 0 ? "…" : "") + text.slice(start, start + 200).trim() + "…";
  }
  function highlight(s: string): ReactNode {
    if (!terms.length) return s;
    const esc = terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
    const parts = s.split(new RegExp(`(${esc})`, "gi"));
    const set = new Set(terms.map((t) => t.toLowerCase()));
    return parts.map((p, i) =>
      set.has(p.toLowerCase()) ? <mark key={i}>{p}</mark> : <span key={i}>{p}</span>,
    );
  }

  return (
    <section className="card">
      <div className="results-toolbar">
        <h2 style={{ margin: 0 }}>🔎 Buscador global</h2>
        {q.trim() && (
          <span className="count">
            {results.length} resultado{results.length !== 1 ? "s" : ""}
          </span>
        )}
      </div>
      <p className="field-hint" style={{ marginTop: 0 }}>
        Buscá por palabras clave (habilidades, herramientas, lo que sea) en TODOS los candidatos de
        todas las búsquedas. Si ponés varias palabras, muestra a quienes las tienen todas.
      </p>
      <div className="gsearch-box">
        <span className="cand-search-icon">🔎</span>
        <input
          autoFocus
          type="search"
          placeholder="Ej: excel tango, sql, inglés, liderazgo…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>

      {!q.trim() ? (
        <p className="empty">Escribí una o más palabras para buscar en toda la base.</p>
      ) : results.length === 0 ? (
        <p className="empty">Ningún candidato coincide con «{q.trim()}».</p>
      ) : (
        <div className="gsearch-results">
          {results.map(({ jobId, jobTitle, cand, text }) => (
            <div className="gsearch-row" key={cand.id}>
              <div className="gsearch-head">
                {cand.evaluation ? (
                  <span className={`score-chip ${scoreClass(cand.evaluation.overallScore)}`}>
                    {toTen(cand.evaluation.overallScore)}
                  </span>
                ) : (
                  <span className="score-chip none">—</span>
                )}
                <div className="gsearch-id">
                  <div className="who">{cand.name}</div>
                  <div className="file">
                    {jobTitle}
                    {cand.evaluation?.age != null ? ` · ${cand.evaluation.age} años` : ""}
                    {cand.evaluation?.location ? ` · ${cand.evaluation.location}` : ""}
                  </div>
                </div>
                <div className="gsearch-actions">
                  <button
                    className="btn btn-ghost btn-sm"
                    onClick={() =>
                      onViewCv({ name: cand.name, emailUid: cand.emailUid, cvText: cand.cvText })
                    }
                  >
                    📄 Ver CV
                  </button>
                  <button className="btn btn-ghost btn-sm" onClick={() => onOpenJob(jobId)}>
                    Abrir búsqueda
                  </button>
                </div>
              </div>
              <p className="gsearch-snippet">{highlight(snippet(text))}</p>
            </div>
          ))}
        </div>
      )}
    </section>
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
