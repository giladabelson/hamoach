// Runs the Vercel handlers in a plain Node server, using the same routes as vercel.json.
import http from "node:http";
import { readFileSync } from "node:fs";
import dashboardHandler from "../api/dashboard.js";
import mcpHandler from "../api/mcp.js";
import oauthHandler from "../api/oauth.js";

const handlers: Record<string, (req: any, res: any) => unknown> = {
  "/api/dashboard": dashboardHandler,
  "/api/mcp": mcpHandler,
  "/api/oauth": oauthHandler,
};

const routes: { source: string; destination: string }[] = JSON.parse(
  readFileSync(new URL("../vercel.json", import.meta.url), "utf8"),
).rewrites;

function route(pathname: string): URL | null {
  for (const r of routes) {
    const re = new RegExp("^" + r.source.replace(/\./g, "\\.").replace("/:path*", "(/.*)?") + "$");
    if (re.test(pathname)) return new URL(r.destination, "http://x");
  }
  return null;
}

export function createLocalServer(): http.Server {
  return http.createServer(async (req, res: any) => {
    const url = new URL(req.url!, "http://localhost");
    const dest = route(url.pathname);
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString();
    const type = String(req.headers["content-type"] ?? "");
    (req as any).body = !raw
      ? undefined
      : type.includes("json")
        ? JSON.parse(raw)
        : Object.fromEntries(new URLSearchParams(raw));
    (req as any).query = { ...Object.fromEntries(url.searchParams), ...Object.fromEntries(dest?.searchParams ?? []) };
    req.headers["x-forwarded-proto"] ??= "http";
    res.status = (s: number) => ((res.statusCode = s), res);
    res.json = (o: unknown) => (res.setHeader("Content-Type", "application/json"), res.end(JSON.stringify(o)), res);
    res.send = (s: string) => (res.end(s), res);
    res.redirect = (s: number, to: string) => (res.writeHead(s, { Location: to }), res.end(), res);
    const handler = dest && handlers[dest.pathname];
    if (!handler) return res.status(404).send("no route");
    return handler(req, res);
  });
}

// Dev preview: npx tsx test/local-server.ts <vault-dir> [port]
if (process.argv[1]?.endsWith("local-server.ts")) {
  process.env.LOCAL_VAULT_DIR = process.argv[2];
  process.env.AUTH_SECRET ??= "local-dev-only";
  process.env.ACCESS_PASSWORD ??= "local";
  const port = Number(process.argv[3] ?? 3210);
  createLocalServer().listen(port, () => console.log(`http://localhost:${port}`));
}
