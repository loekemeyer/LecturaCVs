"use client";
import { useEffect, useMemo, useState } from "react";
import {
  PRUEBA_ROWS,
  PRUEBA_CAJA,
  PRUEBA_PRICE,
  PRUEBA_VENDEDORES,
  PRUEBA_MINUTOS,
} from "@/lib/prueba-data";

const fmt = (n: number) => "$" + (Number(n) || 0).toLocaleString("es-AR");

export default function ExamPrueba({
  cand,
  searchId,
  authHeaders,
  onClose,
  onSubmitted,
}: {
  cand: { id: string; name: string };
  searchId: string;
  authHeaders: () => Record<string, string>;
  onClose: () => void;
  onSubmitted: (score: number) => void;
}) {
  const [totals, setTotals] = useState<Record<string, number>>(() =>
    Object.fromEntries(PRUEBA_ROWS.map((r) => [r.ticket, r.total])),
  );
  const [priceInput, setPriceInput] = useState("");
  const [grabbed, setGrabbed] = useState<number | null>(null); // precio grabado
  const [comm, setComm] = useState<Record<string, string>>(() =>
    Object.fromEntries(PRUEBA_VENDEDORES.map((v) => [v, ""])),
  );
  const [totalDia, setTotalDia] = useState("");
  const [attempts, setAttempts] = useState(0);
  const [err, setErr] = useState("");
  const [phase, setPhase] = useState<"work" | "done" | "sent">("work");
  const [explanation, setExplanation] = useState("");
  const [sending, setSending] = useState(false);
  const startedAt = useMemo(() => Date.now(), []);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);
  const remaining = Math.max(0, PRUEBA_MINUTOS * 60 - Math.floor((now - startedAt) / 1000));
  const timeUp = remaining <= 0 && phase !== "sent";
  const mm = String(Math.floor(remaining / 60)).padStart(2, "0");
  const ss = String(remaining % 60).padStart(2, "0");

  const row016Total = grabbed != null ? grabbed * PRUEBA_PRICE.cantidad : 0;
  const sum = useMemo(
    () => Object.values(totals).reduce((a, b) => a + (Number(b) || 0), 0) + row016Total,
    [totals, row016Total],
  );

  function grabar() {
    const p = Number(priceInput);
    if (!p || p <= 0) {
      setErr("Ingresá el precio de venta calculado antes de grabar.");
      return;
    }
    setGrabbed(p);
    setErr("");
  }

  function cerrarCaja() {
    if (timeUp) return;
    setAttempts((a) => a + 1);
    if (grabbed == null) {
      setErr("Primero calculá y grabá el precio de venta del artículo (Parte 1).");
      return;
    }
    const typed = Number(totalDia);
    if (!typed) {
      setErr("Ingresá el total del día (ventas) antes de cerrar la caja.");
      return;
    }
    if (typed !== sum) {
      setErr(
        `El total ingresado (${fmt(typed)}) no coincide con la suma de las ventas de la tabla (${fmt(
          sum,
        )}). Revisá tu cálculo.`,
      );
      return;
    }
    if (PRUEBA_VENDEDORES.some((v) => !comm[v])) {
      setErr("Cargá la comisión de cada vendedor antes de cerrar (se pagan en efectivo de la caja).");
      return;
    }
    const commSum = PRUEBA_VENDEDORES.reduce((a, v) => a + (Number(comm[v]) || 0), 0);
    const efectivo = sum - commSum;
    if (efectivo !== PRUEBA_CAJA) {
      const diff = efectivo - PRUEBA_CAJA;
      setErr(
        `⚠️ No se puede cerrar la caja.\nVentas: ${fmt(sum)}\nComisiones pagadas: ${fmt(
          commSum,
        )}\nEfectivo esperado (ventas − comisiones): ${fmt(efectivo)}\nEfectivo contado en caja: ${fmt(
          PRUEBA_CAJA,
        )}\nDiferencia: ${fmt(Math.abs(diff))} ${diff > 0 ? "(de más)" : "(de menos)"}.\nRevisá las ventas (puede haber un dato mal cargado) y las comisiones.`,
      );
      return;
    }
    setErr("");
    setPhase("done");
  }

  async function enviar() {
    setSending(true);
    try {
      const durationSec = Math.round((Date.now() - startedAt) / 1000);
      const res = await fetch("/api/prueba", {
        method: "POST",
        headers: { "content-type": "application/json", ...authHeaders() },
        body: JSON.stringify({
          candidateId: cand.id,
          candidateName: cand.name,
          searchId,
          submission: {
            rowTotals: { ...totals, [PRUEBA_PRICE.ticket]: row016Total },
            priceEntered: grabbed || 0,
            commissions: Object.fromEntries(
              Object.entries(comm).map(([k, v]) => [k, Number(v) || 0]),
            ),
            totalEntered: Number(totalDia) || 0,
            closed: true,
            attempts,
            durationSec,
            explanation,
          },
        }),
      });
      const d = await res.json().catch(() => ({}));
      if (res.ok && d.result) {
        onSubmitted(d.result.total);
        setPhase("sent");
      } else {
        alert("No se pudo enviar la prueba: " + (d.error || "error"));
        setSending(false);
      }
    } catch {
      alert("No se pudo enviar la prueba.");
      setSending(false);
    }
  }

  const th: React.CSSProperties = { textAlign: "left", padding: "6px 8px", borderBottom: "2px solid #ccc", fontSize: 13 };
  const td: React.CSSProperties = { padding: "4px 8px", borderBottom: "1px solid #eee", fontSize: 14 };
  const dis = timeUp;

  return (
    <div style={{ position: "fixed", inset: 0, background: "#fff", zIndex: 1000, overflow: "auto" }}>
      <div style={{ maxWidth: 940, margin: "0 auto", padding: 24 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <h2 style={{ margin: 0, flex: 1 }}>🧩 Prueba — Cerrá la caja del día</h2>
          <span
            style={{
              fontWeight: 700,
              fontSize: 18,
              color: remaining < 300 ? "#b00020" : "#137333",
              fontVariantNumeric: "tabular-nums",
            }}
          >
            ⏱ {mm}:{ss}
          </span>
          <button className="icon-btn" title="Cerrar (supervisor)" onClick={onClose}>
            ✕
          </button>
        </div>
        <p style={{ color: "#555", marginTop: 4 }}>
          Candidato/a: <strong>{cand.name}</strong>
        </p>

        {phase === "sent" ? (
          <div
            style={{
              background: "#e6f4ea",
              border: "1px solid #b7e0c2",
              borderRadius: 8,
              padding: 24,
              margin: "24px 0",
              fontSize: 18,
              textAlign: "center",
            }}
          >
            ✅ <strong>Respuesta enviada.</strong>
            <div style={{ marginTop: 8 }}>Informá a Angie que ya finalizaste.</div>
          </div>
        ) : phase === "done" ? (
          <>
            <div
              style={{
                background: "#e6f4ea",
                border: "1px solid #b7e0c2",
                borderRadius: 8,
                padding: 12,
                margin: "16px 0",
                fontSize: 15,
              }}
            >
              ✅ ¡Caja cerrada! El total coincide con el dinero en caja.
            </div>
            <h4 style={{ margin: "6px 0" }}>Para terminar, contanos:</h4>
            <p style={{ color: "#555", fontSize: 14, margin: "0 0 6px" }}>
              ¿Qué problema encontraste y cómo lo resolviste? ¿Usaste alguna herramienta?
            </p>
            <textarea
              className="posting-input"
              rows={5}
              style={{ width: "100%" }}
              value={explanation}
              onChange={(e) => setExplanation(e.target.value)}
            />
            <div style={{ marginTop: 12 }}>
              <button className="btn btn-primary" onClick={enviar} disabled={sending}>
                {sending ? "Enviando…" : "Enviar prueba"}
              </button>
            </div>
          </>
        ) : (
          <>
            <div
              style={{
                background: "#f4f6fb",
                border: "1px solid #dde3f0",
                borderRadius: 8,
                padding: 12,
                margin: "12px 0",
                fontSize: 14,
                lineHeight: 1.5,
              }}
            >
              Sos el/la administrativo/a de ventas. Estas son las ventas del día. Tenés que:
              <ol style={{ margin: "6px 0 0 18px" }}>
                <li>Calcular el <strong>precio de venta</strong> del artículo (Parte 1) y grabarlo.</li>
                <li>Calcular la <strong>comisión (5%)</strong> de cada vendedor.</li>
                <li>Ingresar el <strong>total del día</strong> y tocar <strong>“Cerrar caja”</strong>.</li>
              </ol>
              Podés usar las herramientas que consideres necesario (calculadora, Excel, IA, Google).
              Tenés <strong>{PRUEBA_MINUTOS} minutos</strong> para completar la prueba.
            </div>

            {/* PARTE 1 — precio de venta */}
            <div style={{ border: "1px solid #e3e3e3", borderRadius: 8, padding: 12, margin: "12px 0" }}>
              <strong>Parte 1 — Precio de venta</strong>
              <p style={{ fontSize: 14, margin: "6px 0" }}>
                El artículo <strong>COD {PRUEBA_PRICE.codigo} — {PRUEBA_PRICE.producto}</strong> tiene
                un <strong>costo de {fmt(PRUEBA_PRICE.costo)}</strong> y se vende con un{" "}
                <strong>{PRUEBA_PRICE.gananciaPct}% de ganancia sobre el costo</strong>. Calculá el{" "}
                <strong>precio de venta unitario</strong> y grabalo (se cargará en el cuadro; se
                venden {PRUEBA_PRICE.cantidad} unidades a nombre de {PRUEBA_PRICE.vendedor}).
              </p>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <input
                  type="number"
                  placeholder="Precio de venta unitario ($)"
                  value={priceInput}
                  disabled={dis || grabbed != null}
                  onChange={(e) => setPriceInput(e.target.value)}
                  style={{ width: 220, padding: "4px 6px" }}
                />
                <button className="btn btn-primary btn-sm" onClick={grabar} disabled={dis || grabbed != null}>
                  {grabbed != null ? "✓ Grabado" : "Grabar"}
                </button>
              </div>
            </div>

            <div style={{ fontSize: 15, margin: "8px 0" }}>
              💵 Efectivo contado en caja: <strong>{fmt(PRUEBA_CAJA)}</strong>
            </div>

            <table style={{ borderCollapse: "collapse", width: "100%" }}>
              <thead>
                <tr>
                  <th style={th}>Ticket</th>
                  <th style={th}>Cód.</th>
                  <th style={th}>Vendedor</th>
                  <th style={th}>Producto</th>
                  <th style={{ ...th, textAlign: "right" }}>Cant.</th>
                  <th style={{ ...th, textAlign: "right" }}>Precio</th>
                  <th style={{ ...th, textAlign: "right" }}>Total</th>
                </tr>
              </thead>
              <tbody>
                {PRUEBA_ROWS.map((r) => (
                  <tr key={r.ticket}>
                    <td style={td}>{r.ticket}</td>
                    <td style={td}>{r.codigo}</td>
                    <td style={td}>{r.vendedor}</td>
                    <td style={td}>{r.producto}</td>
                    <td style={{ ...td, textAlign: "right" }}>{r.cantidad}</td>
                    <td style={{ ...td, textAlign: "right" }}>{fmt(r.precio)}</td>
                    <td style={{ ...td, textAlign: "right" }}>
                      <input
                        type="number"
                        value={totals[r.ticket]}
                        disabled={dis}
                        onChange={(e) =>
                          setTotals((t) => ({ ...t, [r.ticket]: Number(e.target.value) }))
                        }
                        style={{ width: 110, textAlign: "right", padding: "2px 4px" }}
                      />
                    </td>
                  </tr>
                ))}
                {grabbed != null && (
                  <tr style={{ background: "#f0f7ff" }}>
                    <td style={td}>{PRUEBA_PRICE.ticket}</td>
                    <td style={td}>{PRUEBA_PRICE.codigo}</td>
                    <td style={td}>{PRUEBA_PRICE.vendedor}</td>
                    <td style={td}>{PRUEBA_PRICE.producto}</td>
                    <td style={{ ...td, textAlign: "right" }}>{PRUEBA_PRICE.cantidad}</td>
                    <td style={{ ...td, textAlign: "right" }}>{fmt(grabbed)}</td>
                    <td style={{ ...td, textAlign: "right" }}>{fmt(row016Total)}</td>
                  </tr>
                )}
              </tbody>
            </table>

            {/* PARTE 2 — comisiones (aparte de la caja) */}
            <h4 style={{ margin: "16px 0 4px" }}>Parte 2 — Comisión a pagar por vendedor (5%)</h4>
            <p style={{ fontSize: 12, color: "#888", margin: "0 0 6px" }}>
              Las comisiones se pagan en efectivo de la caja: se restan del efectivo
              (Ventas − Comisiones = efectivo en caja).
            </p>
            <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
              {PRUEBA_VENDEDORES.map((v) => (
                <label key={v} style={{ display: "flex", flexDirection: "column", fontSize: 13 }}>
                  {v}
                  <input
                    type="number"
                    placeholder="$"
                    value={comm[v]}
                    disabled={dis}
                    onChange={(e) => setComm((c) => ({ ...c, [v]: e.target.value }))}
                    style={{ width: 140, padding: "4px 6px" }}
                  />
                </label>
              ))}
            </div>

            {/* PARTE 3 — total del día + cerrar caja */}
            <h4 style={{ margin: "16px 0 6px" }}>Parte 3 — Cerrar caja</h4>
            <label style={{ fontSize: 14 }}>
              Total del día:{" "}
              <input
                type="number"
                placeholder="$"
                value={totalDia}
                disabled={dis}
                onChange={(e) => setTotalDia(e.target.value)}
                style={{ width: 170, padding: "4px 6px" }}
              />
            </label>

            {err && (
              <div
                style={{
                  background: "#fdecea",
                  border: "1px solid #f5c2c0",
                  color: "#b00020",
                  borderRadius: 8,
                  padding: 12,
                  margin: "14px 0",
                  fontSize: 14,
                  whiteSpace: "pre-line",
                }}
              >
                {err}
              </div>
            )}

            <div style={{ marginTop: 16 }}>
              <button className="btn btn-primary" onClick={cerrarCaja} disabled={dis}>
                🔒 Cerrar caja
              </button>
            </div>
          </>
        )}
      </div>

      {timeUp && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            background: "rgba(255,255,255,0.96)",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 10,
          }}
        >
          <div style={{ fontSize: 26, fontWeight: 700, color: "#b00020" }}>⏱ Se terminó el tiempo.</div>
          <p style={{ color: "#555", marginTop: 8 }}>No podés continuar con la prueba.</p>
          <button className="btn btn-ghost" style={{ marginTop: 16 }} onClick={onClose}>
            Cerrar
          </button>
        </div>
      )}
    </div>
  );
}
