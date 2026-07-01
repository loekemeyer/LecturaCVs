"use client";
import { useMemo, useState } from "react";
import {
  PRUEBA_ROWS,
  PRUEBA_CAJA,
  PRUEBA_RATE,
  PRUEBA_VENDEDORES,
  PRUEBA_MINUTOS,
} from "@/lib/prueba-data";

const fmt = (n: number) => "$" + (Number(n) || 0).toLocaleString("es-AR");

// Pantalla completa de la prueba de resolución (se abre para un candidato ya
// preseleccionado). El error premeditado ya está en los datos (ticket 008).
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
  const [comm, setComm] = useState<Record<string, string>>(() =>
    Object.fromEntries(PRUEBA_VENDEDORES.map((v) => [v, ""])),
  );
  const [attempts, setAttempts] = useState(0);
  const [err, setErr] = useState("");
  const [phase, setPhase] = useState<"work" | "done">("work");
  const [explanation, setExplanation] = useState("");
  const [sending, setSending] = useState(false);
  const startedAt = useMemo(() => Date.now(), []);

  const sum = useMemo(
    () => Object.values(totals).reduce((a, b) => a + (Number(b) || 0), 0),
    [totals],
  );

  function cerrarCaja() {
    setAttempts((a) => a + 1);
    if (sum === PRUEBA_CAJA) {
      setErr("");
      setPhase("done");
    } else {
      const diff = sum - PRUEBA_CAJA;
      setErr(
        `⚠️ No se puede cerrar la caja. El total calculado (${fmt(sum)}) ${
          diff > 0 ? "es MAYOR" : "es MENOR"
        } al dinero en caja (${fmt(PRUEBA_CAJA)}). Diferencia: ${fmt(
          Math.abs(diff),
        )}. Revisá las ventas y corregí el error antes de cerrar.`,
      );
    }
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
            rowTotals: totals,
            commissions: Object.fromEntries(
              Object.entries(comm).map(([k, v]) => [k, Number(v) || 0]),
            ),
            closed: true,
            attempts,
            durationSec,
            explanation,
          },
        }),
      });
      const d = await res.json().catch(() => ({}));
      if (res.ok && d.result) onSubmitted(d.result.total);
      else {
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

  return (
    <div style={{ position: "fixed", inset: 0, background: "#fff", zIndex: 1000, overflow: "auto" }}>
      <div style={{ maxWidth: 900, margin: "0 auto", padding: 24 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <h2 style={{ margin: 0, flex: 1 }}>🧩 Prueba de resolución — Cerrá la caja del día</h2>
          <button className="icon-btn" title="Cerrar (supervisor)" onClick={onClose}>
            ✕
          </button>
        </div>
        <p style={{ color: "#555", marginTop: 4 }}>
          Candidato/a: <strong>{cand.name}</strong>
        </p>

        {phase === "work" ? (
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
                <li>Calcular la <strong>comisión (5%)</strong> de cada vendedor.</li>
                <li>Ingresar el <strong>total del día</strong> y tocar <strong>“Cerrar caja”</strong>.</li>
              </ol>
              Podés usar las herramientas que quieras (calculadora, Excel, IA, Google). Tenés{" "}
              <strong>{PRUEBA_MINUTOS} minutos</strong>. El campo de cada <strong>Total</strong> es
              editable por si necesitás corregir algo.
            </div>

            <div style={{ fontSize: 15, margin: "8px 0" }}>
              💵 Dinero contado en caja: <strong>{fmt(PRUEBA_CAJA)}</strong>
            </div>

            <table style={{ borderCollapse: "collapse", width: "100%" }}>
              <thead>
                <tr>
                  <th style={th}>Ticket</th>
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
                    <td style={td}>{r.vendedor}</td>
                    <td style={td}>{r.producto}</td>
                    <td style={{ ...td, textAlign: "right" }}>{r.cantidad}</td>
                    <td style={{ ...td, textAlign: "right" }}>{fmt(r.precio)}</td>
                    <td style={{ ...td, textAlign: "right" }}>
                      <input
                        type="number"
                        value={totals[r.ticket]}
                        onChange={(e) =>
                          setTotals((t) => ({ ...t, [r.ticket]: Number(e.target.value) }))
                        }
                        style={{ width: 110, textAlign: "right", padding: "2px 4px" }}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            <div style={{ margin: "12px 0", fontSize: 15 }}>
              Total calculado:{" "}
              <strong style={{ color: sum === PRUEBA_CAJA ? "#137333" : "#b00020" }}>
                {fmt(sum)}
              </strong>
            </div>

            <h4 style={{ margin: "14px 0 6px" }}>Comisión a pagar por vendedor (5%)</h4>
            <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
              {PRUEBA_VENDEDORES.map((v) => (
                <label key={v} style={{ display: "flex", flexDirection: "column", fontSize: 13 }}>
                  {v}
                  <input
                    type="number"
                    placeholder="$"
                    value={comm[v]}
                    onChange={(e) => setComm((c) => ({ ...c, [v]: e.target.value }))}
                    style={{ width: 140, padding: "4px 6px" }}
                  />
                </label>
              ))}
            </div>

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
                }}
              >
                {err}
              </div>
            )}

            <div style={{ marginTop: 16 }}>
              <button className="btn btn-primary" onClick={cerrarCaja}>
                🔒 Cerrar caja
              </button>
            </div>
          </>
        ) : (
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
        )}
      </div>
    </div>
  );
}
