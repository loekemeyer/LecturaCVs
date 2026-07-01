// Datos "puros" de la prueba de resolución (sin IA) — se usan en la pantalla (cliente)
// y en la puntuación (servidor). El error premeditado está en el ticket 008.
export interface PruebaRow {
  ticket: string;
  vendedor: string;
  producto: string;
  cantidad: number;
  precio: number;
  total: number; // total TAL CUAL figura (008 viene mal cargado)
}

export const PRUEBA_CAJA = 1231000; // dinero real contado en caja (total correcto)
export const PRUEBA_RATE = 0.05; // comisión 5%
export const PRUEBA_ERROR_TICKET = "008";
export const PRUEBA_MINUTOS = 30;

export const PRUEBA_ROWS: PruebaRow[] = [
  { ticket: "001", vendedor: "Sofía", producto: "Olla de acero 24cm", cantidad: 3, precio: 28000, total: 84000 },
  { ticket: "002", vendedor: "Martín", producto: "Sartén antiadherente 28cm", cantidad: 5, precio: 19500, total: 97500 },
  { ticket: "003", vendedor: "Lucía", producto: "Juego de cuchillos x6", cantidad: 2, precio: 42000, total: 84000 },
  { ticket: "004", vendedor: "Sofía", producto: "Tabla de picar madera", cantidad: 8, precio: 12000, total: 96000 },
  { ticket: "005", vendedor: "Martín", producto: "Set de cucharones x5", cantidad: 6, precio: 9500, total: 57000 },
  { ticket: "006", vendedor: "Lucía", producto: "Colador de acero", cantidad: 10, precio: 6500, total: 65000 },
  { ticket: "007", vendedor: "Sofía", producto: "Pinza de cocina", cantidad: 12, precio: 4500, total: 54000 },
  { ticket: "008", vendedor: "Martín", producto: "Espumadera", cantidad: 10, precio: 5000, total: 65000 },
  { ticket: "009", vendedor: "Lucía", producto: "Bowl de acero 20cm", cantidad: 7, precio: 8000, total: 56000 },
  { ticket: "010", vendedor: "Sofía", producto: "Olla de acero 20cm", cantidad: 4, precio: 22000, total: 88000 },
  { ticket: "011", vendedor: "Martín", producto: "Sartén 24cm", cantidad: 6, precio: 16000, total: 96000 },
  { ticket: "012", vendedor: "Lucía", producto: "Set 3 sartenes", cantidad: 3, precio: 45000, total: 135000 },
  { ticket: "013", vendedor: "Sofía", producto: "Cuchillo chef", cantidad: 9, precio: 11000, total: 99000 },
  { ticket: "014", vendedor: "Martín", producto: "Rallador 4 caras", cantidad: 14, precio: 4000, total: 56000 },
  { ticket: "015", vendedor: "Lucía", producto: "Fuente para horno", cantidad: 5, precio: 15000, total: 75000 },
  { ticket: "016", vendedor: "Sofía", producto: "Batidor manual", cantidad: 11, precio: 3500, total: 38500 },
];

export const PRUEBA_VENDEDORES = Array.from(new Set(PRUEBA_ROWS.map((r) => r.vendedor)));

export function correctTotals(): Record<string, number> {
  const m: Record<string, number> = {};
  for (const r of PRUEBA_ROWS) m[r.ticket] = r.cantidad * r.precio;
  return m;
}

export function correctCommissions(): Record<string, number> {
  const byV: Record<string, number> = {};
  for (const r of PRUEBA_ROWS) byV[r.vendedor] = (byV[r.vendedor] || 0) + r.cantidad * r.precio;
  const c: Record<string, number> = {};
  for (const v in byV) c[v] = Math.round(byV[v] * PRUEBA_RATE);
  return c;
}

export interface PruebaSubmission {
  rowTotals: Record<string, number>;
  commissions: Record<string, number>;
  closed: boolean;
  attempts: number;
  durationSec: number;
  explanation: string;
}
