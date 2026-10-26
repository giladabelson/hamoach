// MCP endpoint (Streamable HTTP, stateless). Requires a bearer token from the OAuth flow.
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { baseUrl, verify } from "../lib/auth.js";
import { FsStore, GitHubStore } from "../lib/store.js";
import { createServer } from "../lib/tools.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, mcp-protocol-version, mcp-session-id");
  res.setHeader("Access-Control-Expose-Headers", "WWW-Authenticate, mcp-session-id");
  if (req.method === "OPTIONS") return res.status(204).end();

  const auth = String(req.headers.authorization ?? "");
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token || !(await verify("access", token))) {
    res.setHeader(
      "WWW-Authenticate",
      `Bearer resource_metadata="${baseUrl(req.headers)}/.well-known/oauth-protected-resource"`,
    );
    return res.status(401).json({ error: "invalid_token", error_description: "Authentication required" });
  }

  if (req.method !== "POST") {
    // Stateless server: no server-initiated stream, no sessions to delete.
    return res.status(405).setHeader("Allow", "POST").json({ error: "Method not allowed" });
  }

  const dir = process.env.LOCAL_VAULT_DIR; // local testing only
  const server = createServer(dir ? new FsStore(dir) : GitHubStore.fromEnv());
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => {
    transport.close();
    server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
}
