"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { Criterion, Evaluation } from "@/lib/types";

type CriterionDraft = { id: string; name: string; weight: number; description: string };
type ItemStatus = "pending" | "scoring" | "done" | "error";
type NameStatus = "reading" | "done" | "error";
type FileItem = {
  id: string;
  file: File;
  expectedSalary: string;
  candidateName: string;
  nameStatus: NameStatus;
  status: ItemStatus;
  result?: Evaluation;
  error?: string;
};

const STORAGE_KEY = "lecturacvs:config:v2";
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
      "Si el candidato pretende un sueldo igual o menor al que ofrece la empresa, puntaje alto; cuanto más por encima de la oferta, más bajo. Si falta algún dato de sueldo, puntaje neutral.",
  },
  {
    name: "Antigüedad en los últimos 3 trabajos",
    weight: 35,
    description:
      "Estabilidad laboral en los últimos empleos (relación de dependencia). Permanecer ~2 años o más en un puesto es una buena señal, sobre todo en gente joven. Lo que baja el puntaje es tener varios empleos (2, 3 o más) de menos de 1 año cada uno (job hopping). No cuentes emprendimientos propios ni trabajo freelance/independiente como empleo.",
  },
  {
    name: "Sector privado (penaliza empleo estatal)",
    weight: 35,
    description:
      "Si su experiencia es principalmente en el Estado o sector público, el puntaje debe ser MUY bajo. Experiencia mayormente en empresas privadas = puntaje alto.",
  },
];

const withIds = (list: Omit<CriterionDraft, "id">[]): CriterionDraft[] =>
  list.map((c) => ({ id: genId(), ...c }));

// Los puntajes internos van de 0 a 100; se muestran del 0 al 10.
const scoreClass = (score: number) => (score >= 75 ? "good" : score >= 50 ? "mid" : "low");
const toTen = (n: number) => {
  const v = Math.round(n) / 10;
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
};

// Separador de miles (formato argentino): "1200000" -> "1.200.000"
function formatMiles(value: string): string {
  const digits = (value || "").replace(/\D/g, "");
  if (!digits) return "";
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
}

// Acepta PDF e imágenes (foto/captura del CV).
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

// Los PDFs se mandan tal cual. Las imágenes se reescalan (máx 1600px) y se exportan a
// JPEG para que pesen poco y entren en el límite del servidor.
async function prepareUpload(file: File): Promise<{ blob: Blob; filename: string }> {
  const isPdf = file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
  if (isPdf) return { blob: file, filename: file.name };
  try {
    const img = await loadImage(file);
    const maxDim = 1600;
    const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
    const w = Math.max(1, Math.round(img.width * scale));
    const h = Math.max(1, Math.round(img.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return { blob: file, filename: file.name };
    ctx.drawImage(img, 0, 0, w, h);
    const blob = await new Promise<Blob | null>((res) =>
      canvas.toBlob(res, "image/jpeg", 0.85),
    );
    if (!blob) return { blob: file, filename: file.name };
    return { blob, filename: file.name.replace(/\.[^.]+$/, "") + ".jpg" };
  } catch {
    return { blob: file, filename: file.name };
  }
}

export default function Home() {
  const [jobContext, setJobContext] = useState("");
  const [offeredSalary, setOfferedSalary] = useState("");
  const [criteria, setCriteria] = useState<CriterionDraft[]>(() => withIds(DEFAULT_CRITERIA));
  const [items, setItems] = useState<FileItem[]>([]);
  const [running, setRunning] = useState(false);
  const [formError, setFormError] = useState("");
  const [drag, setDrag] = useState(false);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [loaded, setLoaded] = useState(false);

  const inputRef = useRef<HTMLInputElement>(null);

  // Cargar configuración guardada
  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (typeof parsed.jobContext === "string") setJobContext(parsed.jobContext);
        if (typeof parsed.offeredSalary === "string") setOfferedSalary(parsed.offeredSalary);
        if (Array.isArray(parsed.criteria) && parsed.criteria.length) {
          setCriteria(
            parsed.criteria.map((c: Partial<Criterion>) => ({
              id: genId(),
              name: c.name ?? "",
              weight: Number(c.weight) || 0,
              description: c.description ?? "",
            })),
          );
        }
      }
    } catch {
      /* ignorar */
    }
    setLoaded(true);
  }, []);

  // Guardar configuración
  useEffect(() => {
    if (!loaded) return;
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          jobContext,
          offeredSalary,
          criteria: criteria.map(({ name, weight, description }) => ({
            name,
            weight,
            description,
          })),
        }),
      );
    } catch {
      /* ignorar */
    }
  }, [jobContext, offeredSalary, criteria, loaded]);

  const totalWeight = useMemo(
    () => criteria.reduce((s, c) => s + (c.name.trim() && c.weight > 0 ? c.weight : 0), 0),
    [criteria],
  );

  const results = useMemo(
    () =>
      items
        .filter((it) => it.status === "done" && it.result)
        .sort((a, b) => (b.result!.overallScore ?? 0) - (a.result!.overallScore ?? 0)),
    [items],
  );

  // ---------- criterios ----------
  function updateCriterion(id: string, patch: Partial<CriterionDraft>) {
    setCriteria((prev) => prev.map((c) => (c.id === id ? { ...c, ...patch } : c)));
  }
  function addCriterion() {
    setCriteria((prev) => [...prev, { id: genId(), name: "", weight: 10, description: "" }]);
  }
  function removeCriterion(id: string) {
    setCriteria((prev) => prev.filter((c) => c.id !== id));
  }
  function resetCriteria() {
    setCriteria(withIds(DEFAULT_CRITERIA));
  }

  // ---------- archivos ----------
  function addFiles(list: FileList | File[]) {
    const supported = Array.from(list).filter(isSupportedFile);
    const seen = new Set(items.map((p) => `${p.file.name}:${p.file.size}`));
    const toAdd = supported
      .filter((f) => !seen.has(`${f.name}:${f.size}`))
      .map((f) => ({
        id: genId(),
        file: f,
        expectedSalary: "",
        candidateName: "",
        nameStatus: "reading" as const,
        status: "pending" as const,
      }));
    if (!toAdd.length) return;
    setItems((prev) => [...prev, ...toAdd]);
    void extractNames(toAdd.map((t) => ({ id: t.id, file: t.file })));
  }

  // Lee cada CV recién subido para mostrar el nombre del postulante en la lista.
  async function extractNames(targets: { id: string; file: File }[]) {
    let i = 0;
    const worker = async (): Promise<void> => {
      while (i < targets.length) {
        const { id, file } = targets[i++];
        try {
          const { blob, filename } = await prepareUpload(file);
          const fd = new FormData();
          fd.append("file", blob, filename);
          const res = await fetch("/api/extract-name", { method: "POST", body: fd });
          const data = await res.json().catch(() => ({}));
          if (res.ok && data?.name) {
            updateItem(id, { candidateName: String(data.name), nameStatus: "done" });
          } else {
            updateItem(id, { nameStatus: "error" });
          }
        } catch {
          updateItem(id, { nameStatus: "error" });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(3, targets.length) }, () => worker()));
  }
  function updateItem(id: string, patch: Partial<FileItem>) {
    setItems((prev) => prev.map((it) => (it.id === id ? { ...it, ...patch } : it)));
  }
  function removeItem(id: string) {
    setItems((prev) => prev.filter((it) => it.id !== id));
  }
  function clearAll() {
    setItems([]);
    setOpen(new Set());
  }

  function toggleOpen(id: string) {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  // ---------- evaluación ----------
  async function scoreOne(
    file: File,
    payloadCriteria: Criterion[],
    expectedSalary: string,
  ): Promise<Evaluation> {
    const { blob, filename } = await prepareUpload(file);
    const fd = new FormData();
    fd.append("file", blob, filename);
    fd.append("criteria", JSON.stringify(payloadCriteria));
    fd.append("jobContext", jobContext);
    fd.append("offeredSalary", offeredSalary);
    fd.append("expectedSalary", expectedSalary);
    const res = await fetch("/api/score", { method: "POST", body: fd });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error || `Error ${res.status}`);
    return data as Evaluation;
  }

  async function evaluate() {
    const valid = criteria.filter((c) => c.name.trim() && c.weight > 0);
    if (!valid.length) {
      setFormError("Definí al menos un criterio con nombre y peso mayor a cero.");
      return;
    }
    if (!items.length) {
      setFormError("Subí al menos un CV en PDF.");
      return;
    }
    setFormError("");
    setRunning(true);

    const payloadCriteria: Criterion[] = valid.map(({ name, weight, description }) => ({
      name,
      weight,
      description,
    }));

    const queue = items
      .filter((it) => it.status === "pending" || it.status === "error")
      .map((it) => ({ id: it.id, file: it.file, expectedSalary: it.expectedSalary }));

    let idx = 0;
    const worker = async (): Promise<void> => {
      while (idx < queue.length) {
        const { id, file, expectedSalary } = queue[idx++];
        updateItem(id, { status: "scoring", error: undefined });
        try {
          const ev = await scoreOne(file, payloadCriteria, expectedSalary);
          updateItem(id, { status: "done", result: ev });
        } catch (e) {
          const msg = e instanceof Error ? e.message : "Error al procesar el CV.";
          updateItem(id, { status: "error", error: msg });
        }
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, queue.length) }, () => worker()),
    );
    setRunning(false);
  }

  const pendingCount = items.filter(
    (it) => it.status === "pending" || it.status === "error",
  ).length;

  return (
    <main className="page">
      <header className="masthead">
        <div className="logo">CV</div>
        <div>
          <h1>LecturaCVs</h1>
          <p>Subí los CVs en PDF y la IA puntúa a los postulados del 1 al 10 según tus criterios.</p>
        </div>
      </header>

      {/* PASO 1 — parámetros */}
      <section className="card">
        <h2>
          <span className="step">1</span>Parámetros de evaluación
        </h2>
        <p className="card-hint">
          Definí qué buscás. Los pesos no necesitan sumar 100: se normalizan automáticamente.
        </p>

        <label className="field" htmlFor="jobctx">
          Puesto y contexto (opcional)
        </label>
        <textarea
          id="jobctx"
          placeholder="Ej: Vendedor/a para local de electrodomésticos en Córdoba. Jornada completa…"
          value={jobContext}
          onChange={(e) => setJobContext(e.target.value)}
        />

        <div style={{ marginTop: 14 }}>
          <label className="field" htmlFor="offered">
            Sueldo ofrecido por la empresa (opcional)
          </label>
          <input
            id="offered"
            type="text"
            inputMode="numeric"
            placeholder="Ej: 1.200.000"
            value={offeredSalary}
            onChange={(e) => setOfferedSalary(formatMiles(e.target.value))}
          />
          <p className="card-hint" style={{ marginTop: 6, marginBottom: 0 }}>
            Se compara con el sueldo pretendido que cargás en cada CV (criterio de sueldo).
          </p>
        </div>

        <div style={{ marginTop: 18 }}>
          {criteria.map((c) => {
            const pct =
              c.name.trim() && c.weight > 0 && totalWeight > 0
                ? Math.round((c.weight / totalWeight) * 100)
                : 0;
            return (
              <div className="criterion" key={c.id}>
                <input
                  type="text"
                  placeholder="Nombre del criterio (ej: Inglés avanzado)"
                  value={c.name}
                  onChange={(e) => updateCriterion(c.id, { name: e.target.value })}
                />
                <div className="weight-wrap">
                  <input
                    type="number"
                    min={0}
                    step={5}
                    aria-label="Peso"
                    value={c.weight}
                    onChange={(e) =>
                      updateCriterion(c.id, {
                        weight: e.target.value === "" ? 0 : Math.max(0, Number(e.target.value)),
                      })
                    }
                  />
                  <div className="weight-pct">{pct}%</div>
                </div>
                <button
                  className="icon-btn"
                  aria-label="Eliminar criterio"
                  title="Eliminar criterio"
                  onClick={() => removeCriterion(c.id)}
                >
                  ×
                </button>
                <input
                  className="desc"
                  type="text"
                  placeholder="Descripción opcional para guiar a la IA"
                  value={c.description}
                  onChange={(e) => updateCriterion(c.id, { description: e.target.value })}
                />
              </div>
            );
          })}
        </div>

        <div className="btn-row">
          <button className="btn btn-ghost" onClick={addCriterion}>
            + Agregar criterio
          </button>
          <button className="btn btn-ghost" onClick={resetCriteria}>
            Restablecer criterios
          </button>
        </div>
      </section>

      {/* PASO 2 — subir CVs */}
      <section className="card">
        <h2>
          <span className="step">2</span>Subir CVs (PDF o imagen)
        </h2>
        <p className="card-hint">
          Podés arrastrar varios archivos (PDF o foto/imagen del CV). Cargá el sueldo pretendido
          de cada candidato (lo muestran ZonaJobs y Computrabajo).
        </p>

        <div
          className={`dropzone${drag ? " drag" : ""}`}
          onClick={() => inputRef.current?.click()}
          onDragOver={(e) => {
            e.preventDefault();
            setDrag(true);
          }}
          onDragLeave={() => setDrag(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDrag(false);
            addFiles(e.dataTransfer.files);
          }}
        >
          <strong>Hacé clic para elegir</strong> o arrastrá PDFs o imágenes acá
        </div>
        <input
          ref={inputRef}
          type="file"
          accept="application/pdf,.pdf,image/*,.png,.jpg,.jpeg,.webp"
          multiple
          style={{ display: "none" }}
          onChange={(e) => {
            if (e.target.files) addFiles(e.target.files);
            e.target.value = "";
          }}
        />

        {items.length > 0 && (
          <ul className="filelist">
            {items.map((it) => (
              <li className="fileitem" key={it.id}>
                <span className="name" title={it.file.name}>
                  {it.nameStatus === "reading" ? (
                    <span className="who muted">
                      <span className="spinner" /> Leyendo nombre…
                    </span>
                  ) : it.candidateName && it.candidateName.toLowerCase() !== "desconocido" ? (
                    <>
                      <span className="who">{it.candidateName}</span>
                      <span className="sub">{it.file.name}</span>
                    </>
                  ) : (
                    <span className="who">{it.file.name}</span>
                  )}
                </span>
                <div className="fileitem-right">
                  <input
                    type="text"
                    inputMode="numeric"
                    className="salary-input"
                    placeholder="Sueldo pretendido"
                    value={it.expectedSalary}
                    disabled={running}
                    onChange={(e) =>
                      updateItem(it.id, { expectedSalary: formatMiles(e.target.value) })
                    }
                  />
                  <span className={`status ${it.status}`}>
                    {it.status === "pending" && "En espera"}
                    {it.status === "scoring" && (
                      <>
                        <span className="spinner" /> Evaluando
                      </>
                    )}
                    {it.status === "done" && "Listo"}
                    {it.status === "error" && "Error"}
                  </span>
                  {!running && (
                    <button
                      className="icon-btn"
                      style={{ width: 30, height: 30, fontSize: 16 }}
                      aria-label="Quitar archivo"
                      onClick={() => removeItem(it.id)}
                    >
                      ×
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}

        {formError && <div className="error-box">{formError}</div>}

        <div className="btn-row">
          <button className="btn btn-primary" onClick={evaluate} disabled={running}>
            {running ? (
              <>
                <span className="spinner" /> Evaluando…
              </>
            ) : pendingCount > 0 && pendingCount !== items.length ? (
              `Evaluar ${pendingCount} pendiente${pendingCount > 1 ? "s" : ""}`
            ) : (
              "Evaluar postulantes"
            )}
          </button>
          {items.length > 0 && !running && (
            <button className="btn btn-ghost" onClick={clearAll}>
              Limpiar todo
            </button>
          )}
        </div>
      </section>

      {/* PASO 3 — resultados */}
      <section className="card">
        <div className="results-toolbar">
          <h2 style={{ margin: 0 }}>
            <span className="step">3</span>Ranking de postulantes
          </h2>
          {results.length > 0 && <span className="count">{results.length} evaluados</span>}
        </div>

        {results.length === 0 ? (
          <p className="empty">
            Todavía no hay resultados. Definí tus criterios, subí los CVs y tocá «Evaluar
            postulantes».
          </p>
        ) : (
          <div style={{ marginTop: 14 }}>
            {results.map((it, i) => {
              const ev = it.result!;
              const isOpen = open.has(it.id);
              return (
                <div className={`result${isOpen ? " open" : ""}`} key={it.id}>
                  <div className="result-head" onClick={() => toggleOpen(it.id)}>
                    <span className="rank">#{i + 1}</span>
                    <div className={`score-chip ${scoreClass(ev.overallScore)}`}>
                      {toTen(ev.overallScore)}
                    </div>
                    <div className="result-id">
                      <div className="who">{ev.candidateName}</div>
                      <div className="file">{ev.fileName}</div>
                    </div>
                    <span className={`badge ${ev.recommendation}`}>{ev.recommendation}</span>
                    <span className="chevron">▾</span>
                  </div>

                  {isOpen && (
                    <div className="result-body">
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
                            <span
                              className={scoreClass(cr.score)}
                              style={{ width: `${cr.score}%` }}
                            />
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
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {items.some((it) => it.status === "error") && (
          <div style={{ marginTop: 14 }}>
            {items
              .filter((it) => it.status === "error")
              .map((it) => (
                <div className="error-box" key={it.id} style={{ marginTop: 8 }}>
                  <strong>{it.file.name}:</strong> {it.error}
                </div>
              ))}
          </div>
        )}
      </section>
    </main>
  );
}
