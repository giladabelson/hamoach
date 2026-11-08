// Checks get_pipeline and the pipeline section of get_project("כסף מהצד").
// Usage: SUPABASE_URL=... SUPABASE_PUBLISHABLE_KEY=... npx tsx test/pipeline.ts <vault-dir> <expected-leads-count>
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { FsStore } from "../lib/store.js";
import { createServer } from "../lib/tools.js";
import { projectDetails } from "../lib/vault.js";

const [vaultDir, expectedLeads] = process.argv.slice(2);
const store = new FsStore(vaultDir);

async function connect() {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createServer(store).connect(a);
  const client = new Client({ name: "test", version: "1" });
  await client.connect(b);
  return async (name: string, args: Record<string, unknown> = {}) => {
    const r: any = await client.callTool({ name, arguments: args });
    return { text: r.content[0].text as string, isError: !!r.isError };
  };
}

async function main() {
  const call = await connect();
  const base = projectDetails(await store.snapshot(), "כסף מהצד");

  // 1. get_pipeline totals match the direct count
  const p = await call("get_pipeline");
  assert.equal(p.isError, false, p.text);
  const leads = Number(p.text.match(/- לידים: (\d+)/)?.[1]);
  assert.equal(leads, Number(expectedLeads), `get_pipeline says ${leads}, direct count ${expectedLeads}`);
  console.log(`1. get_pipeline leads=${leads} matches direct count: OK`);

  // 2. get_project keeps the project data and adds the section
  const g = await call("get_project", { project: "כסף מהצד" });
  assert.ok(g.text.startsWith(base), "project data changed");
  assert.match(g.text.slice(base.length), /^\n\n## מצב הצנרת\n- נשלחו \d+ מתוך \d+ לידים/);
  console.log("2. get_project has unchanged project data + מצב הצנרת: OK");

  // 3. other projects get no pipeline section
  const other = await call("get_project", { project: "Demo Project" });
  assert.ok(!other.text.includes("מצב הצנרת"));
  console.log("3. other projects unaffected: OK");

  // 4. Supabase unreachable: get_project still works, get_pipeline reports it
  process.env.SUPABASE_URL = "https://unreachable.invalid";
  const down = await call("get_project", { project: "כסף מהצד" });
  assert.equal(down.isError, false);
  assert.ok(down.text.startsWith(base) && down.text.endsWith("נתוני הצנרת לא זמינים כרגע."));
  const pDown = await call("get_pipeline");
  assert.equal(pDown.isError, true);
  assert.match(pDown.text, /נתוני הצנרת לא זמינים כרגע/);
  console.log("4. Supabase down: get_project still works, get_pipeline says unavailable: OK");

  console.log("\nPIPELINE CHECKS PASSED\n\n--- example get_pipeline output ---\n" + p.text);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
