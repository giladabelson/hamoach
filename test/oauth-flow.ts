// End-to-end check of the password-protected OAuth flow and the MCP endpoint over real HTTP.
// Runs the Vercel handlers in a small local server with the same routes as vercel.json.
// Usage: npx tsx test/oauth-flow.ts <vault-copy-dir>
import assert from "node:assert/strict";
import { randomBytes, createHash } from "node:crypto";
import { createLocalServer } from "./local-server.js";

process.env.LOCAL_VAULT_DIR = process.argv[2];
process.env.AUTH_SECRET = randomBytes(32).toString("hex");
process.env.ACCESS_PASSWORD = "test-password-only";

const server = createLocalServer();

async function main() {
  await new Promise<void>((r) => server.listen(0, r));
  const base = `http://localhost:${(server.address() as any).port}`;
  const form = (o: Record<string, string>) => ({
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(o).toString(),
    redirect: "manual" as const,
  });
  const mcp = (token: string, body: unknown) =>
    fetch(`${base}/mcp`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify(body),
    });

  // 1. No token -> 401 pointing to metadata
  const r1 = await mcp("", { jsonrpc: "2.0", id: 1, method: "tools/list" });
  assert.equal(r1.status, 401);
  assert.match(r1.headers.get("www-authenticate")!, /resource_metadata=".*\/\.well-known\/oauth-protected-resource"/);
  console.log("1. no token -> 401 with resource_metadata: OK");

  // 2. Metadata
  const prm = await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json();
  const asm = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();
  assert.equal(prm.resource, `${base}/mcp`);
  assert.equal(asm.token_endpoint, `${base}/token`);
  console.log("2. metadata: OK");

  // 3. Registration: bad redirect rejected, claude.ai accepted
  const bad = await fetch(`${base}/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ redirect_uris: ["https://evil.example/cb"] }) });
  assert.equal(bad.status, 400);
  const redirect = "https://claude.ai/api/mcp/auth_callback";
  const reg = await (await fetch(`${base}/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ redirect_uris: [redirect], client_name: "Claude" }) })).json();
  assert.ok(reg.client_id);
  console.log("3. registration (foreign redirect rejected): OK");

  // 4. Authorize page, wrong and right password
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const params = { response_type: "code", client_id: reg.client_id, redirect_uri: redirect, code_challenge: challenge, code_challenge_method: "S256", state: "xyz" };
  const pageRes = await fetch(`${base}/authorize?${new URLSearchParams(params)}`);
  assert.equal(pageRes.status, 200);
  assert.match(await pageRes.text(), /dir="rtl"/);
  const wrong = await fetch(`${base}/authorize`, form({ ...params, password: "nope" }));
  assert.equal(wrong.status, 401);
  const right = await fetch(`${base}/authorize`, form({ ...params, password: "test-password-only" }));
  assert.equal(right.status, 302);
  const loc = new URL(right.headers.get("location")!);
  assert.equal(loc.origin + loc.pathname, redirect);
  assert.equal(loc.searchParams.get("state"), "xyz");
  const code = loc.searchParams.get("code")!;
  console.log("4. authorize (wrong password 401, right password redirects): OK");

  // 5. Token exchange: wrong verifier fails, right succeeds
  const tokBad = await fetch(`${base}/token`, form({ grant_type: "authorization_code", code, redirect_uri: redirect, client_id: reg.client_id, code_verifier: "wrong" }));
  assert.equal(tokBad.status, 400);
  const tok = await (await fetch(`${base}/token`, form({ grant_type: "authorization_code", code, redirect_uri: redirect, client_id: reg.client_id, code_verifier: verifier }))).json();
  assert.ok(tok.access_token && tok.refresh_token);
  console.log("5. token exchange with PKCE: OK");

  // 6. MCP with token
  const init = await mcp(tok.access_token, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
  assert.equal(init.status, 200);
  const list = await (await mcp(tok.access_token, { jsonrpc: "2.0", id: 2, method: "tools/list" })).json();
  assert.equal(list.result.tools.length, 13);
  const ov = await (await mcp(tok.access_token, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "get_overview", arguments: {} } })).json();
  assert.match(ov.result.content[0].text, /LaBot 2\.0/);
  console.log("6. MCP initialize, tools/list (13), get_overview over HTTP: OK");

  // 7. Refresh, and a refresh token is not accepted as an access token
  const ref = await (await fetch(`${base}/token`, form({ grant_type: "refresh_token", refresh_token: tok.refresh_token }))).json();
  assert.ok(ref.access_token);
  assert.equal((await mcp(tok.refresh_token, { jsonrpc: "2.0", id: 4, method: "tools/list" })).status, 401);
  console.log("7. refresh works, refresh token rejected at /mcp: OK");

  // 8. Changing the password revokes existing tokens
  process.env.ACCESS_PASSWORD = "changed";
  assert.equal((await mcp(ref.access_token, { jsonrpc: "2.0", id: 5, method: "tools/list" })).status, 401);
  console.log("8. password change revokes tokens: OK");

  console.log("\nOAUTH FLOW PASSED");
  server.close();
}

main().catch((e) => {
  console.error(e);
  server.close();
  process.exit(1);
});
