// Minimal single-user OAuth 2.1 server (PKCE + dynamic client registration), stateless.
// Every value is a signed JWT. Changing ACCESS_PASSWORD invalidates all clients and tokens.
import { createHash, timingSafeEqual } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";

export const ACCESS_TTL = 60 * 60 * 24; // 1 day
const REFRESH_TTL = "365d";
const CODE_TTL = "5m";

// claude.ai / claude.com callbacks, plus localhost for local MCP clients.
export function isAllowedRedirect(uri: string): boolean {
  try {
    const u = new URL(uri);
    if (u.protocol === "https:" && ["claude.ai", "claude.com"].includes(u.hostname)) return true;
    return u.protocol === "http:" && ["localhost", "127.0.0.1"].includes(u.hostname);
  } catch {
    return false;
  }
}

function key(): Uint8Array {
  const { AUTH_SECRET, ACCESS_PASSWORD } = process.env;
  if (!AUTH_SECRET || !ACCESS_PASSWORD) throw new Error("Missing AUTH_SECRET / ACCESS_PASSWORD environment variables");
  return createHash("sha256").update(`${AUTH_SECRET}\n${ACCESS_PASSWORD}`).digest();
}

export function checkPassword(input: string): boolean {
  const a = createHash("sha256").update(input).digest();
  const b = createHash("sha256").update(process.env.ACCESS_PASSWORD ?? "").digest();
  return timingSafeEqual(a, b) && !!process.env.ACCESS_PASSWORD;
}

type Kind = "client" | "code" | "access" | "refresh";

export async function sign(kind: Kind, claims: Record<string, unknown>, ttl?: string | number): Promise<string> {
  let jwt = new SignJWT({ ...claims, kind }).setProtectedHeader({ alg: "HS256" }).setIssuedAt();
  if (ttl !== undefined) jwt = jwt.setExpirationTime(typeof ttl === "number" ? Math.floor(Date.now() / 1000) + ttl : ttl);
  return jwt.sign(key());
}

export async function verify(kind: Kind, token: string): Promise<Record<string, any> | null> {
  try {
    const { payload } = await jwtVerify(token, key(), { algorithms: ["HS256"] });
    return payload.kind === kind ? (payload as Record<string, any>) : null;
  } catch {
    return null;
  }
}

export const s256 = (verifier: string) => createHash("sha256").update(verifier).digest("base64url");

export async function issueTokens(clientId: string) {
  return {
    access_token: await sign("access", { client_id: clientId }, ACCESS_TTL),
    token_type: "Bearer",
    expires_in: ACCESS_TTL,
    refresh_token: await sign("refresh", { client_id: clientId }, REFRESH_TTL),
  };
}

export const codeTtl = CODE_TTL;

export function baseUrl(headers: Record<string, string | string[] | undefined>): string {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/$/, "");
  const host = String(headers["x-forwarded-host"] ?? headers.host);
  const proto = String(headers["x-forwarded-proto"] ?? (host.startsWith("localhost") ? "http" : "https"));
  return `${proto}://${host}`;
}
