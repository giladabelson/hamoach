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
:root{--bg:#f5f5f4;--card:#fff;--text:#1c1917;--muted:#78716c;--line:#e7e5e4;--accent:#2563eb;--late:#b91c1c;--late-bg:#fef2f2}
@media (prefers-color-scheme:dark){:root{--bg:#1c1917;--card:#292524;--text:#f5f5f4;--muted:#a8a29e;--line:#44403c;--accent:#60a5fa;--late:#fca5a5;--late-bg:#3f1d1d}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:16px/1.5 system-ui,-apple-system,"Segoe UI",Arial,sans-serif;text-align:right}
main{max-width:760px;margin:0 auto;padding:16px}
h1{font-size:24px;margin:0}
.date{color:var(--muted);font-size:14px;margin:2px 0 16px}
h2{font-size:18px;margin:24px 0 8px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px 14px;margin-bottom:8px}
.late{background:var(--late-bg);border-color:var(--late)}
.late .title{color:var(--late)}
.title{font-weight:600}
.meta{color:var(--muted);font-size:14px}
.row{display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap}
.label{color:var(--muted);font-size:14px}
.empty{color:var(--muted)}
.group{font-weight:600;margin:12px 0 4px}
ul{margin:0;padding:0;list-style:none}
li{padding:8px 0;border-bottom:1px solid var(--line)}
li:last-child{border-bottom:0}
form{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:20px;max-width:360px;margin:15vh auto 0}
input{width:100%;font-size:18px;padding:10px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--text)}
button{margin-top:12px;width:100%;font-size:18px;padding:10px;border:0;border-radius:8px;background:var(--accent);color:#fff}
.err{color:var(--late)}
`;

const shell = (body: string) => `<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>המוח</title><style>${CSS}</style></head>
<body><main>${body}</main></body></html>`;

const loginPage = (error?: string) =>
  shell(`<form method="post"><h1>המוח</h1><p class="meta">הקלד את הסיסמה.</p>
${error ? `<p class="err">${esc(error)}</p>` : ""}
<input type="password" name="password" autofocus autocomplete="current-password" required>
<button type="submit">כניסה</button></form>`);

function taskItem(t: Task, showProject: boolean): string {
  const bits = [showProject ? esc(t.project) : "", t.due ? `יעד ${esc(t.due)}` : "", t.postponed_count ? `נדחתה ${t.postponed_count}` : ""];
  return `<li><div class="title">${esc(t.title)}</div><div class="meta">${bits.filter(Boolean).join(" · ")}</div></li>`;
}

export function renderDashboard(snap: Snapshot): string {
  const day = today();
  const open = listAllTasks(snap).filter((t) => t.status === "open");
  const overdue = open.filter((t) => isOverdue(t, day));

  const lateHtml = overdue.length
    ? `<div class="card late"><ul>${overdue.map((t) => taskItem(t, true)).join("")}</ul></div>`
    : `<p class="empty">אין משימות באיחור.</p>`;

  const groups = new Map<string, Task[]>();
  for (const t of open) groups.set(t.project, [...(groups.get(t.project) ?? []), t]);
  const openHtml = groups.size
    ? [...groups]
        .map(([p, list]) => `<div class="card"><div class="group">${esc(p)} (${list.length})</div><ul>${list.map((t) => taskItem(t, false)).join("")}</ul></div>`)
        .join("")
    : `<p class="empty">אין משימות פתוחות.</p>`;

  const projects = listProjects(snap)
    .map((p) => readStatus(snap, p))
    .sort((a, b) => b.updated.localeCompare(a.updated));
  const projectsHtml = projects
    .map(
      (s) => `<div class="card"><div class="row"><span class="title">${esc(s.project)}</span><span class="meta">${esc(s.updated.replace("T", " "))}</span></div>
<div><span class="label">מצב: </span>${s.state ? esc(s.state) : `<span class="empty">עוד אין</span>`}</div>
<div><span class="label">הצעד הבא: </span>${s.next_step ? esc(s.next_step) : `<span class="empty">עוד אין</span>`}</div></div>`,
    )
    .join("");

  const recentHtml = snap.recent.length
    ? `<div class="card"><ul>${snap.recent
        .map((c) => `<li><div>${esc(c.message)}</div><div class="meta">${esc(new Date(c.date).toLocaleString("he-IL", { timeZone: "Asia/Jerusalem", dateStyle: "short", timeStyle: "short" }))}</div></li>`)
        .join("")}</ul></div>`
    : `<p class="empty">אין עדכונים.</p>`;

  return shell(`<h1>המוח</h1><p class="date">${esc(day)}</p>
<h2>באיחור (${overdue.length})</h2>${lateHtml}
<h2>משימות פתוחות (${open.length})</h2>${openHtml}
<h2>פרויקטים</h2>${projectsHtml}
<h2>עדכונים אחרונים</h2>${recentHtml}`);
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
