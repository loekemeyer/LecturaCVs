/** @type {import('next').NextConfig} */
const nextConfig = {
  // Librerías de servidor que no deben empaquetarse (IMAP + lectura/armado de PDF).
  serverExternalPackages: ["imapflow", "mailparser", "pdfjs-dist", "pdf-lib"],
};

export default nextConfig;
