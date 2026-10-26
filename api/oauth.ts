// OAuth endpoints, routed by ?op= (see vercel.json rewrites).
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { baseUrl, checkPassword, codeTtl, isAllowedRedirect, issueTokens, s256, sign, verify } from "../lib/auth.js";

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function cors(res: VercelResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, mcp-protocol-version");
}

const oauthError = (res: VercelResponse, status: number, error: string, description: string) =>
  res.status(status).json({ error, error_description: description });

export default async function handler(req: VercelRequest, res: VercelResponse) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  const base = baseUrl(req.headers);
  const op = String(req.query.op ?? "");

  switch (op) {
    case "resource-metadata":
      return res.json({
        resource: `${base}/mcp`,
        authorization_servers: [base],
        bearer_methods_supported: ["header"],
      });

    case "server-metadata":
      return res.json({
        issuer: base,
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: `${base}/token`,
        registration_endpoint: `${base}/register`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
      });

    case "register":
      return register(req, res);
    case "authorize":
      return authorize(req, res);
    case "token":
      return token(req, res);
    default:
      return res.status(404).send("Not found");
  }
}

async function register(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return res.status(405).end();
  const body = (req.body ?? {}) as Record<string, any>;
  const redirectUris: string[] = Array.isArray(body.redirect_uris) ? body.redirect_uris.map(String) : [];
  if (!redirectUris.length || !redirectUris.every(isAllowedRedirect)) {
    return oauthError(res, 400, "invalid_redirect_uri", "Redirect URI not allowed");
  }
  const clientId = await sign("client", { redirect_uris: redirectUris });
  return res.status(201).json({
    client_id: clientId,
    client_id_issued_at: Math.floor(Date.now() / 1000),
    client_name: body.client_name,
    redirect_uris: redirectUris,
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  });
}

interface AuthParams {
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  code_challenge_method: string;
  state: string;
  response_type: string;
}

async function checkAuthParams(p: AuthParams): Promise<string | null> {
  const client = await verify("client", p.client_id);
  if (!client) return "החיבור לא מוכר. נסה להתחבר מחדש מ-Claude.";
  if (!(client.redirect_uris as string[]).includes(p.redirect_uri)) return "כתובת החזרה לא תואמת.";
  if (p.response_type !== "code" || p.code_challenge_method !== "S256" || !p.code_challenge) return "בקשה לא תקינה.";
  return null;
}

function page(p: AuthParams, error?: string): string {
  const hidden = (Object.keys(p) as (keyof AuthParams)[])
    .map((k) => `<input type="hidden" name="${k}" value="${esc(p[k])}">`)
    .join("");
  return `<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>המוח: כניסה</title>
<style>
body{font-family:system-ui,sans-serif;background:#f4f4f5;margin:0;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:16px}
form{background:#fff;padding:24px;border-radius:12px;max-width:360px;width:100%;box-shadow:0 1px 4px #0002;text-align:right}
h1{font-size:22px;margin:0 0 8px}p{color:#555;margin:0 0 16px}
input[type=password]{width:100%;box-sizing:border-box;font-size:18px;padding:10px;border:1px solid #ccc;border-radius:8px}
button{margin-top:12px;width:100%;font-size:18px;padding:10px;border:0;border-radius:8px;background:#2563eb;color:#fff}
.err{color:#b91c1c}
</style></head><body><form method="post">
<h1>המוח</h1><p>Claude מבקש גישה למוח שלך. הקלד את הסיסמה.</p>
${error ? `<p class="err">${esc(error)}</p>` : ""}
${hidden}<input type="password" name="password" autofocus autocomplete="current-password" required>
<button type="submit">אישור</button></form></body></html>`;
}

async function authorize(req: VercelRequest, res: VercelResponse) {
  const src = (req.method === "POST" ? req.body : req.query) as Record<string, any>;
  const p: AuthParams = {
    client_id: String(src.client_id ?? ""),
    redirect_uri: String(src.redirect_uri ?? ""),
    code_challenge: String(src.code_challenge ?? ""),
    code_challenge_method: String(src.code_challenge_method ?? ""),
    state: String(src.state ?? ""),
    response_type: String(src.response_type ?? ""),
  };
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  const problem = await checkAuthParams(p);
  if (problem) return res.status(400).send(page(p, problem));
  if (req.method !== "POST") return res.send(page(p));

  if (!checkPassword(String(src.password ?? ""))) {
    await new Promise((r) => setTimeout(r, 1500)); // slow down guessing
    return res.status(401).send(page(p, "סיסמה שגויה."));
  }
  const code = await sign(
    "code",
    { client_id: p.client_id, redirect_uri: p.redirect_uri, code_challenge: p.code_challenge },
    codeTtl,
  );
  const target = new URL(p.redirect_uri);
  target.searchParams.set("code", code);
  if (p.state) target.searchParams.set("state", p.state);
  return res.redirect(302, target.toString());
}

async function token(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return res.status(405).end();
  res.setHeader("Cache-Control", "no-store");
  const b = (req.body ?? {}) as Record<string, any>;

  if (b.grant_type === "authorization_code") {
    const code = await verify("code", String(b.code ?? ""));
    if (!code) return oauthError(res, 400, "invalid_grant", "Code invalid or expired");
    if (code.redirect_uri !== b.redirect_uri || (b.client_id && code.client_id !== b.client_id)) {
      return oauthError(res, 400, "invalid_grant", "Client or redirect mismatch");
    }
    if (s256(String(b.code_verifier ?? "")) !== code.code_challenge) {
      return oauthError(res, 400, "invalid_grant", "PKCE verification failed");
    }
    return res.json(await issueTokens(code.client_id));
  }

  if (b.grant_type === "refresh_token") {
    const refresh = await verify("refresh", String(b.refresh_token ?? ""));
    if (!refresh) return oauthError(res, 400, "invalid_grant", "Refresh token invalid or expired");
    return res.json(await issueTokens(refresh.client_id));
  }

  return oauthError(res, 400, "unsupported_grant_type", "Unsupported grant type");
}
