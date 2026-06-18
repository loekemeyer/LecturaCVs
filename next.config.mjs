/** @type {import('next').NextConfig} */
const nextConfig = {
  // Librerías de servidor que no deben empaquetarse (lectura de correo IMAP).
  serverExternalPackages: ["imapflow", "mailparser"],
};

export default nextConfig;
