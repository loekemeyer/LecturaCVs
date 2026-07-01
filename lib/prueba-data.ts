// Datos "puros" de la prueba de resolución (sin IA) — se usan en la pantalla (cliente)
// y en la puntuación (servidor). Artículos reales del catálogo Loekemeyer.
// Parte 1: calcular el precio de venta de un artículo (costo + ganancia) y grabarlo.
// Parte 2: comisión 5% por vendedor. Parte 3: cerrar la caja (hay un dato mal cargado).
// El error premeditado está en el ticket 008 (Espumadera 988E): el total figura mal.
export interface PruebaRow {
  ticket: string;
  codigo: string;
  vendedor: string;
  producto: string;
  cantidad: number;
  precio: number;
  total: number; // total TAL CUAL figura (008 viene mal cargado)
}

export const PRUEBA_CAJA = 611500; // dinero real contado en caja (total correcto, ya con la parte 1)
export const PRUEBA_RATE = 0.05; // comisión 5%
export const PRUEBA_ERROR_TICKET = "008";
export const PRUEBA_MINUTOS = 30;

// Parte 1 — artículo al que hay que calcular el precio de venta.
export const PRUEBA_PRICE = {
  ticket: "016",
  codigo: "819E",
  vendedor: "Sofía",
  producto: "Sacacorcho Fish 14cm",
  costo: 8000,
  gananciaPct: 60, // % de ganancia sobre el costo (markup)
  cantidad: 5,
};
export const PRUEBA_PRECIO_CORRECTO = Math.round(PRUEBA_PRICE.costo * (1 + PRUEBA_PRICE.gananciaPct / 100)); // 12800

export const PRUEBA_ROWS: PruebaRow[] = [
  { ticket: "001", codigo: "501", vendedor: "Sofía", producto: "Abrelatas a manija", cantidad: 6, precio: 3500, total: 21000 },
  { ticket: "002", codigo: "586", vendedor: "Martín", producto: "Pelapapas mango ergonómico", cantidad: 10, precio: 2800, total: 28000 },
  { ticket: "003", codigo: "504", vendedor: "Lucía", producto: "Afila cuchillos", cantidad: 8, precio: 4200, total: 33600 },
  { ticket: "004", codigo: "520", vendedor: "Sofía", producto: "Sacacorcho tipo mozo cromado", cantidad: 5, precio: 6500, total: 32500 },
  { ticket: "005", codigo: "546", vendedor: "Martín", producto: "Corta queso con mango", cantidad: 4, precio: 5200, total: 20800 },
  { ticket: "006", codigo: "562", vendedor: "Lucía", producto: "Corta pizza 6cm", cantidad: 7, precio: 3800, total: 26600 },
  { ticket: "007", codigo: "360E", vendedor: "Sofía", producto: "Rallador 4 lados", cantidad: 6, precio: 7400, total: 44400 },
  { ticket: "008", codigo: "988E", vendedor: "Martín", producto: "Espumadera premium", cantidad: 10, precio: 4500, total: 60000 }, // ← error (debería 45000)
  { ticket: "009", codigo: "439E", vendedor: "Lucía", producto: "Colador de pasta inox", cantidad: 9, precio: 5600, total: 50400 },
  { ticket: "010", codigo: "541E", vendedor: "Sofía", producto: "Prensa ajo", cantidad: 12, precio: 3900, total: 46800 },
  { ticket: "011", codigo: "983E", vendedor: "Martín", producto: "Cucharón premium", cantidad: 8, precio: 5300, total: 42400 },
  { ticket: "012", codigo: "870E", vendedor: "Lucía", producto: "Mandolina 3 grosores", cantidad: 3, precio: 15800, total: 47400 },
  { ticket: "013", codigo: "368E", vendedor: "Sofía", producto: "Rallador hexagonal 25cm", cantidad: 5, precio: 9200, total: 46000 },
  { ticket: "014", codigo: "440", vendedor: "Martín", producto: "Colador extensible", cantidad: 6, precio: 6100, total: 36600 },
  { ticket: "015", codigo: "034", vendedor: "Lucía", producto: "Filtro de café gastronómico", cantidad: 10, precio: 2600, total: 26000 },
];

export const PRUEBA_VENDEDORES = Array.from(
  new Set([...PRUEBA_ROWS.map((r) => r.vendedor), PRUEBA_PRICE.vendedor]),
);

// Total correcto de cada ticket (las 15 filas + la del precio grabado bien).
export function correctTotals(): Record<string, number> {
  const m: Record<string, number> = {};
  for (const r of PRUEBA_ROWS) m[r.ticket] = r.cantidad * r.precio;
  m[PRUEBA_PRICE.ticket] = PRUEBA_PRECIO_CORRECTO * PRUEBA_PRICE.cantidad;
  return m;
}

export function correctCommissions(): Record<string, number> {
  const byV: Record<string, number> = {};
  for (const r of PRUEBA_ROWS) byV[r.vendedor] = (byV[r.vendedor] || 0) + r.cantidad * r.precio;
  byV[PRUEBA_PRICE.vendedor] =
    (byV[PRUEBA_PRICE.vendedor] || 0) + PRUEBA_PRECIO_CORRECTO * PRUEBA_PRICE.cantidad;
  const c: Record<string, number> = {};
  for (const v in byV) c[v] = Math.round(byV[v] * PRUEBA_RATE);
  return c;
}

export interface PruebaSubmission {
  rowTotals: Record<string, number>; // ticket -> total final (incluye 016, la fila del precio)
  priceEntered: number; // precio de venta que grabó (parte 1)
  commissions: Record<string, number>; // vendedor -> comisión ingresada
  totalEntered: number; // total del día que ingresó
  closed: boolean;
  attempts: number;
  durationSec: number;
  explanation: string;
}
