# LecturaCVs

Subí los CVs de los postulantes en PDF, definí **tus** criterios con pesos, y la IA
(Claude) los lee, puntúa cada criterio con su justificación y arma un **ranking** de
candidatos.

Pensado para crecer: hoy es una página web; el día de mañana podés llevarlo a una app
de Play Store reutilizando el mismo backend (ver más abajo).

---

## Cómo funciona

1. **Definís los parámetros**: un contexto del puesto, el **sueldo que ofrece la empresa**
   y una lista de criterios con su **peso**. Vienen tres criterios por defecto, que podés
   editar, borrar o ampliar:
   - **Sueldo pretendido vs. ofrecido** — premia a quien pretende igual o menos que la oferta.
   - **Antigüedad en los últimos 3 trabajos** — penaliza los cambios muy cortos (job hopping).
   - **Sector privado (penaliza empleo estatal)** — la experiencia mayormente estatal baja
     mucho el puntaje.
2. **Subís los PDFs** de los CVs (uno o varios) y cargás el **sueldo pretendido** de cada
   candidato (lo muestran ZonaJobs y Computrabajo).
3. La IA evalúa cada CV: puntúa cada criterio, extrae el nombre, un resumen, fortalezas y dudas.
4. El **puntaje final** (del **1 al 10**) se calcula como el promedio de los criterios
   **ponderado por tus pesos** — así el ranking refleja exactamente lo que vos priorizás.

La cuenta final se hace en el servidor (no la inventa la IA), por lo que el orden es
consistente y reproducible.

---

## Puesta en marcha

Requisitos: **Node.js 18+** y una **API key de Anthropic**
(la sacás en <https://console.anthropic.com/>).

```bash
# 1. Instalar dependencias
npm install

# 2. Configurar la clave
cp .env.example .env.local
#   y editá .env.local poniendo tu ANTHROPIC_API_KEY

# 3. Levantar en modo desarrollo
npm run dev
```

Abrí <http://localhost:3000>.

Para producción:

```bash
npm run build
npm start
```

### Variables de entorno

| Variable            | Obligatoria | Descripción                                                        |
| ------------------- | ----------- | ------------------------------------------------------------------ |
| `ANTHROPIC_API_KEY` | Sí          | Tu clave de Anthropic. **Vive solo en el servidor**, nunca se expone al navegador. |
| `ANTHROPIC_MODEL`   | No          | Modelo a usar. Por defecto `claude-opus-4-8`. Para abaratar costos: `claude-sonnet-4-6` o `claude-haiku-4-5`. |

---

## Deploy (ponerla online)

La forma más simple es **Vercel** (gratis, con soporte nativo de Next.js):

1. Entrá a [vercel.com](https://vercel.com) e iniciá sesión con tu cuenta de **GitHub**.
2. **Add New… → Project** e importá el repo `loekemeyer/lecturacvs`.
3. Antes de deployar, abrí **Environment Variables** y agregá:
   - `ANTHROPIC_API_KEY` = tu clave de Anthropic (¡usá una nueva, no una que hayas pegado en un chat!).
   - (opcional) `ANTHROPIC_MODEL` = `claude-opus-4-8`.
4. **Deploy**. En ~2 minutos tenés una URL pública (ej. `lecturacvs.vercel.app`).

Notas:

- La **rama de producción** debe ser `main` (Vercel → Project Settings → Git, o GitHub → Settings → Branches → default `main`).
- En el plan gratuito de Vercel cada request tiene un límite de ~4,5 MB; alcanza de sobra para CVs normales.
- La API key queda como variable de entorno **en el servidor**: nunca se expone al navegador.

---

## Arquitectura (y por qué sirve para la futura app móvil)

```
Navegador (página)  ──POST /api/score (PDF + criterios)──►  Backend Next.js
                                                              │  guarda la API key
                                                              ▼
                                                        Claude (Anthropic)
```

- **`app/page.tsx`** — la interfaz: criterios, subida de PDFs y ranking.
- **`app/api/score/route.ts`** — el endpoint. Recibe **un** PDF + los criterios y
  devuelve la evaluación en JSON. Acá vive la API key (nunca en el cliente).
- **`lib/scoring.ts`** — el núcleo (`scoreCv`): toma el PDF y los criterios y llama a
  Claude. Es una función independiente, reutilizable por cualquier otra entrada de CVs.

Cuando hagas la **app de Play Store**, la app sería solo otra interfaz que le pega al
mismo `POST /api/score`. La lógica de IA y la clave quedan del lado del servidor: no se
reescribe nada del cerebro de la app.

> ⚠️ **Seguridad:** la API key debe quedar siempre en el servidor. Una app móvil **no**
> debe llevar la clave embebida; debe llamar a este backend.

---

## ¿Se puede conectar directo a ZonaJobs / Computrabajo (sin subir los PDFs a mano)?

Resumen honesto: **ninguna de las dos ofrece una API pública y abierta** para que un
empleador baje los CVs de sus postulantes de forma automática. Las opciones reales son:

1. **Ingesta por email (lo más viable para hacerlo nosotros).** Cuando alguien se postula,
   los portales te mandan un mail. Si ese mail trae el CV (adjunto o link), se puede armar
   un módulo que lea una casilla (ej. con Gmail) y meta esos PDFs en el evaluador
   automáticamente. *Depende de qué incluye exactamente el mail de cada portal.*
2. **ATS oficiales con integración.** El camino “oficial” para centralizar candidatos sin
   bajarlos a mano es un ATS conectado al portal: **Pandapé** (integración exclusiva con
   Computrabajo) y **Hiring Room / Manatal / etc.** para **ZonaJobs–Bumeran**. Son productos
   pagos aparte; podrían exportar candidatos hacia esta app si exponen una API/exportación.
3. **Descarga masiva manual.** Desde el panel del portal bajás los CVs y los arrastrás
   todos juntos acá (sigue siendo manual, pero en lote).
4. **Automatización del navegador / scraping** del panel: técnicamente posible, pero suele
   **violar los términos de uso**, es frágil y arriesgado. No recomendado.

**Recomendación:** empezar con la subida manual (lo que ya hace esta app) y, si querés,
sumar después la **ingesta por email**, que reutiliza el mismo `scoreCv`. Para eso primero
hay que ver qué traen tus mails de aviso de ZonaJobs y Computrabajo (¿el PDF adjunto, o
solo un link al perfil?).

---

## Notas

- Los CVs no se guardan: se procesan en memoria para puntuarlos y nada más.
- Funciona con CVs escaneados (imágenes): Claude también lee el PDF como imagen.
- Cada PDF se evalúa en su propia llamada, así que un error en uno no frena a los demás.
- Tus criterios y el contexto del puesto se guardan en el navegador (localStorage) para
  no recargarlos cada vez.
