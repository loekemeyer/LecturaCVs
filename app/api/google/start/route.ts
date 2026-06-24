// Inicia la conexión con Google: redirige al consentimiento de OAuth.
import { googleConfigured, googleCreds, redirectUri, GOOGLE_SCOPES } from "@/lib/google";

export const runtime = "nodejs";

export async function GET(req: Request) {
  if (!googleConfigured()) {
    return new Response("Google no está configurado en el servidor.", { status: 500 });
  }
  const { clientId } = googleCreds();
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri(req),
    response_type: "code",
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    scope: GOOGLE_SCOPES,
  });
  return Response.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`, 302);
}
