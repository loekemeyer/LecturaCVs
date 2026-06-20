import type { Metadata } from "next";
import { Analytics } from "@vercel/analytics/next";
import "./globals.css";

export const metadata: Metadata = {
  title: "LecturaCVs — Puntuá postulantes con IA",
  description:
    "Subí los CVs en PDF, definí tus criterios y la IA puntúa y rankea a los postulados.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es">
      <body>
        {children}
        <Analytics />
      </body>
    </html>
  );
}
