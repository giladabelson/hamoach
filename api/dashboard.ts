// Dashboard page. Same password as the connector; a signed cookie keeps the browser logged in.
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { checkPassword, sign, verify } from "../lib/auth.js";
import { FsStore, GitHubStore, type Snapshot } from "../lib/store.js";
import { isOverdue, listAllTasks, listProjects, readStatus, today, type Task } from "../lib/vault.js";

const COOKIE = "hamoach_session";
const SESSION_DAYS = 30;

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function cookie(req: VercelRequest): string {
  const m = String(req.headers.cookie ?? "").match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
  return m ? m[1] : "";
}

const CSS = `
:root{--bg:#eef2ff;--card:#fff;--text:#1e1b4b;--muted:#6366f1;--line:#c7d2fe;--accent:#4f46e5;--on-accent:#fff;--late:#dc2626}
@media (prefers-color-scheme:dark){:root{--bg:#121027;--card:#1e1b3a;--text:#e0e7ff;--muted:#a5b4fc;--line:#312e81;--accent:#818cf8;--on-accent:#121027;--late:#f87171}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:16px/1.5 system-ui,-apple-system,"Segoe UI",Arial,sans-serif;text-align:right}
main{max-width:760px;margin:0 auto;padding:16px}
h1{font-size:24px;margin:0}
.muted{color:var(--muted);font-size:14px}
.tiles{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin:16px 0}
.tile{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:12px 8px;text-align:center}
.tile b{display:block;font-size:28px;line-height:1.1}
.tile.late b{color:var(--late)}
.tabs input{position:absolute;opacity:0;pointer-events:none}
.tabs label{display:inline-flex;align-items:center;min-height:44px;padding:0 16px;margin:0 0 10px 4px;border-radius:999px;background:var(--card);border:1px solid var(--line);font-weight:600;cursor:pointer}
.tabs input:checked+label{background:var(--accent);border-color:var(--accent);color:var(--on-accent)}
.tabs input:focus-visible+label{outline:2px solid var(--accent);outline-offset:2px}
.panel{display:none}
#tab-tasks:checked~.p-tasks,#tab-projects:checked~.p-projects,#tab-updates:checked~.p-updates{display:block}
.row{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:14px;margin-bottom:8px}
.row.late{border-right:6px solid var(--late)}
.row.late .t{color:var(--late)}
.t{font-weight:600}
.empty{color:var(--muted)}
form{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:20px;max-width:360px;margin:15vh auto 0}
input[type=password]{width:100%;font-size:18px;padding:10px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--text)}
button{margin-top:12px;width:100%;min-height:44px;font-size:18px;border:0;border-radius:8px;background:var(--accent);color:var(--on-accent)}
.err{color:var(--late)}
`;

const shell = (body: string) => `<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>המוח</title><style>${CSS}</style></head>
<body><main>${body}</main></body></html>`;

const loginPage = (error?: string) =>
  shell(`<form method="post"><h1>המוח</h1><p class="muted">הקלד את הסיסמה.</p>
${error ? `<p class="err">${esc(error)}</p>` : ""}
<input type="password" name="password" autofocus autocomplete="current-password" required>
<button type="submit">כניסה</button></form>`);

const addDays = (day: string, n: number) => new Date(Date.parse(day) + n * 86400000).toISOString().slice(0, 10);

function taskRow(t: Task, day: string): string {
  const late = isOverdue(t, day);
  const bits = [esc(t.project), t.due ? `יעד ${esc(t.due)}` : "בלי תאריך", t.postponed_count ? `נדחתה ${t.postponed_count}` : ""];
  return `<div class="row${late ? " late" : ""}"><div class="t">${esc(t.title)}</div><div class="muted">${bits.filter(Boolean).join(" · ")}</div></div>`;
}

export function renderDashboard(snap: Snapshot): string {
  const day = today();
  const weekEnd = addDays(day, 7);
  const open = listAllTasks(snap).filter((t) => t.status === "open");
  const overdue = open.filter((t) => isOverdue(t, day));
  const thisWeek = open.filter((t) => t.due && t.due >= day && t.due <= weekEnd);
  // Overdue first, then by due date, undated last (listAllTasks already sorts by due).
  const ordered = [...overdue, ...open.filter((t) => t.due && !isOverdue(t, day)), ...open.filter((t) => !t.due)];

  const tasksHtml = ordered.length ? ordered.map((t) => taskRow(t, day)).join("") : `<p class="empty">אין משימות פתוחות.</p>`;

  const projectsHtml = listProjects(snap)
    .map((p) => readStatus(snap, p))
    .sort((a, b) => b.updated.localeCompare(a.updated))
    .map(
      (s) => `<div class="row"><div class="t">${esc(s.project)}</div>
<div>${s.state ? esc(s.state) : `<span class="empty">עוד אין סטטוס</span>`}</div>
<div class="muted">הצעד הבא: ${s.next_step ? esc(s.next_step) : "עוד אין"}</div></div>`,
    )
    .join("");

  const updatesHtml = snap.recent.length
    ? snap.recent
        .map((c) => `<div class="row">${esc(c.message)}<div class="muted">${esc(new Date(c.date).toLocaleString("he-IL", { timeZone: "Asia/Jerusalem", dateStyle: "short", timeStyle: "short" }))}</div></div>`)
        .join("")
    : `<p class="empty">אין עדכונים.</p>`;

  return shell(`<h1>המוח</h1><div class="muted">${esc(day)}</div>
<div class="tiles"><div class="tile late"><b>${overdue.length}</b>באיחור</div><div class="tile"><b>${thisWeek.length}</b>השבוע</div><div class="tile"><b>${open.length}</b>פתוחות</div></div>
<div class="tabs">
<input type="radio" name="tab" id="tab-tasks" checked><label for="tab-tasks">משימות</label>
<input type="radio" name="tab" id="tab-projects"><label for="tab-projects">פרויקטים</label>
<input type="radio" name="tab" id="tab-updates"><label for="tab-updates">עדכונים</label>
<div class="panel p-tasks">${tasksHtml}</div>
<div class="panel p-projects">${projectsHtml}</div>
<div class="panel p-updates">${updatesHtml}</div>
</div>`);
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Frame-Options", "DENY");

  if (req.method === "POST") {
    const password = String((req.body as Record<string, unknown> | undefined)?.password ?? "");
    if (!checkPassword(password)) {
      await new Promise((r) => setTimeout(r, 1500)); // slow down guessing
      return res.status(401).send(loginPage("סיסמה שגויה."));
    }
    const token = await sign("session", {}, SESSION_DAYS * 24 * 60 * 60);
    const secure = String(req.headers["x-forwarded-proto"] ?? "https") === "https" ? "; Secure" : "";
    res.setHeader("Set-Cookie", `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure}`);
    return res.redirect(303, "/");
  }

  if (!(await verify("session", cookie(req)))) return res.send(loginPage());

  const dir = process.env.LOCAL_VAULT_DIR; // local testing only
  const store = dir ? new FsStore(dir) : GitHubStore.fromEnv();
  return res.send(renderDashboard(await store.snapshot()));
}
