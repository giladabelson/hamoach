// Calls every tool once against a temporary test project, checks the result, then removes the test data.
// Local:  npx tsx test/run-tools.ts <vault-copy-dir>
// GitHub: npx tsx test/run-tools.ts --github   (needs GITHUB_TOKEN / GITHUB_OWNER / GITHUB_REPO)
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { FsStore, GitHubStore, type Store } from "../lib/store.js";
import { createServer } from "../lib/tools.js";
import { parseDoc, today } from "../lib/vault.js";

const PROJECT = "_בדיקה";
const arg = process.argv[2];
const store: Store = arg === "--github" ? GitHubStore.fromEnv() : new FsStore(arg);

async function setup() {
  const snap = await store.snapshot();
  const content = `---\ntype: status\nproject: "${PROJECT}"\nstate:\nnext_step:\nupdated: ${today()}\n---\n# ${PROJECT}\n\n## מצב נוכחי\n\n\n## הצעד הבא\n\n`;
  assert.ok(await store.commit(snap.head, [{ path: `פרויקטים/${PROJECT}/סטטוס.md`, content }], `Test: create project ${PROJECT}`));
}

async function cleanup() {
  const snap = await store.snapshot();
  const paths = [...snap.files.entries()]
    .filter(([p, text]) => p.startsWith(`פרויקטים/${PROJECT}/`) || parseDoc(text).data.project === PROJECT)
    .map(([p]) => p);
  if (paths.length) {
    await store.commit(snap.head, paths.map((p) => ({ path: p, content: null })), `Test: remove test data (${paths.length} files)`);
  }
  const after = await store.snapshot();
  const left = [...after.files.entries()].filter(([p, t]) => p.includes(PROJECT) || t.includes(PROJECT));
  assert.equal(left.length, 0, `test data left: ${left.map(([p]) => p)}`);
  console.log(`cleanup: removed ${paths.length} files, nothing left`);
}

async function main() {
  const server = createServer(store);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "test", version: "1" });
  await client.connect(b);

  const tools = (await client.listTools()).tools.map((t) => t.name).sort();
  console.log("tools:", tools.join(", "));
  assert.equal(tools.length, 13);

  const call = async (name: string, args: Record<string, unknown> = {}, expectError = false) => {
    const r: any = await client.callTool({ name, arguments: args });
    const text = r.content[0].text as string;
    console.log(`\n=== ${name} ${expectError ? "(expect error)" : ""}\n${text.slice(0, 700)}`);
    assert.equal(!!r.isError, expectError, `${name} isError=${r.isError}`);
    return text;
  };
  const files = async () => (await store.snapshot()).files;
  const taskByTitle = async (title: string) =>
    [...(await files()).entries()].map(([p, t]) => ({ p, d: parseDoc(t).data })).find((x) => x.d.title === title)!;

  await setup();
  try {
    await call("update_status", { project: PROJECT, status: "בבדיקה", next_step: "לסיים בדיקה" });
    const st = parseDoc((await files()).get(`פרויקטים/${PROJECT}/סטטוס.md`)!);
    assert.equal(st.data.state, "בבדיקה");
    assert.match(st.body, /## הצעד הבא\nלסיים בדיקה/);

    await call("add_decision", { project: PROJECT, decision: "החלטת בדיקה", reason: "כי בודקים" });
    assert.match((await files()).get(`פרויקטים/${PROJECT}/החלטות.md`)!, /\*\*החלטה:\*\* החלטת בדיקה/);

    await call("add_task", { title: "משימה עם תאריך", project: PROJECT, due: "2020-01-01" });
    await call("add_task", { title: "משימה בלי תאריך", project: PROJECT });
    const dated = await taskByTitle("משימה עם תאריך");
    const undated = await taskByTitle("משימה בלי תאריך");
    assert.equal(dated.d.due, "2020-01-01");
    assert.equal(undated.d.due, null);
    assert.equal(undated.d.status, "open");

    const overdue = await call("list_tasks", { filter: "overdue", project: PROJECT });
    assert.ok(overdue.includes(dated.d.id) && !overdue.includes(undated.d.id), "undated task must never be overdue");
    const noDue = await call("list_tasks", { filter: "no_due", project: PROJECT });
    assert.ok(noDue.includes(undated.d.id));

    await call("postpone_task", { id: dated.d.id, new_due: "2099-12-31" });
    const postponed = await taskByTitle("משימה עם תאריך");
    assert.equal(postponed.d.due, "2099-12-31");
    assert.equal(postponed.d.postponed_count, 1);

    await call("set_calendar_event_id", { id: dated.d.id, calendar_event_id: "test-event-123" });
    assert.equal((await taskByTitle("משימה עם תאריך")).d.calendar_event_id, "test-event-123");
    assert.ok((await call("list_tasks", { filter: "open", project: PROJECT })).includes("test-event-123"));

    await call("complete_task", { id: undated.d.id });
    const done = await taskByTitle("משימה בלי תאריך");
    assert.equal(done.d.status, "done");
    assert.ok((await files()).has(done.p), "complete_task must not delete");

    await call("log_chat_summary", {
      project: PROJECT,
      title: "שיחת בדיקה",
      summary: "סיכום בדיקה",
      decisions: ["החלטה מתוך שיחה"],
      tasks: [{ title: "משימה מתוך שיחה" }],
    });
    const f = await files();
    assert.ok([...f.keys()].some((p) => p.startsWith(`פרויקטים/${PROJECT}/שיחות/`)));
    assert.match(f.get(`פרויקטים/${PROJECT}/החלטות.md`)!, /החלטה מתוך שיחה/);
    assert.ok(await taskByTitle("משימה מתוך שיחה"));

    await call("save_meeting", { project: PROJECT, title: "פגישת בדיקה", people: ["דנה"], summary: "סיכום פגישה", transcript: "שלום" });
    assert.ok([...(await files()).keys()].some((p) => p.startsWith("פגישות/") && p.includes("פגישת בדיקה")));

    const proj = await call("get_project", { project: PROJECT });
    assert.ok(proj.includes("בבדיקה") && proj.includes("משימה מתוך שיחה") && proj.includes("שיחת בדיקה"));

    const ov = await call("get_overview");
    assert.ok(ov.includes(PROJECT) && ov.includes("Demo Project"));

    const found = await call("search", { query: "החלטת בדיקה" });
    assert.ok(found.includes("החלטות.md"));

    // error paths
    await call("get_project", { project: "פרויקט שלא קיים" }, true);
    await call("complete_task", { id: "t000000-xxx" }, true);
    await call("add_task", { title: "x", project: PROJECT, due: "31/12/2026" }, true);

    console.log("\nALL TOOL CHECKS PASSED");
  } finally {
    await cleanup();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
