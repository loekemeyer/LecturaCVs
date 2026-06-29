/** @type {import('next').NextConfig} */
const nextConfig = {
  // Librerías de servidor que no deben empaquetarse (IMAP + armado de PDF).
  serverExternalPackages: ["imapflow", "mailparser", "pdf-lib"],
};

export default nextConfig;
