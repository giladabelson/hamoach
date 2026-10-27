// Vault model: file layout, frontmatter and the read/write operations behind each tool.
import YAML from "yaml";
import type { FileChange, Snapshot, Store } from "./store.js";
import { writeWithRetry } from "./store.js";

export const DIR = {
  projects: "פרויקטים",
  tasks: "משימות",
  meetings: "פגישות",
  templates: "_templates",
};
const STATUS_FILE = "סטטוס.md";
const DECISIONS_FILE = "החלטות.md";
const CHATS_DIR = "שיחות";

// ---------- dates (Israel time) ----------

function israelParts(d = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jerusalem",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return { date: `${get("year")}-${get("month")}-${get("day")}`, time: `${get("hour").replace("24", "00")}:${get("minute")}` };
}
export const today = () => israelParts().date;
export const nowStamp = () => {
  const p = israelParts();
  return `${p.date}T${p.time}`;
};

export function checkDate(value: string, field: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || isNaN(Date.parse(value))) {
    throw new Error(`${field} חייב להיות תאריך בפורמט YYYY-MM-DD (קיבלתי: ${value})`);
  }
  return value;
}

// ---------- frontmatter ----------

export interface Doc {
  data: Record<string, any>;
  body: string;
}

export function parseDoc(text: string): Doc {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { data: {}, body: text };
  return { data: (YAML.parse(m[1]) as Record<string, any>) ?? {}, body: m[2] };
}

export function renderDoc(doc: Doc): string {
  const yaml = YAML.stringify(doc.data, { nullStr: "", lineWidth: 0 }).trimEnd();
  return `---\n${yaml}\n---\n${doc.body.replace(/^\n+/, "")}`;
}

const str = (v: unknown) => (v === null || v === undefined ? "" : String(v));

// Replaces the content under "## heading" (up to the next "## "), or appends the section.
function setSection(body: string, heading: string, content: string): string {
  const lines = body.split("\n");
  const start = lines.findIndex((l) => l.trim() === `## ${heading}`);
  if (start === -1) return `${body.trimEnd()}\n\n## ${heading}\n${content}\n`;
  let end = lines.findIndex((l, i) => i > start && l.startsWith("## "));
  if (end === -1) end = lines.length;
  const before = lines.slice(0, start + 1);
  const after = lines.slice(end);
  return [...before, content, "", ...after].join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

function safeName(title: string): string {
  return title.replace(/[\\/:*?"<>|#^[\]]/g, " ").replace(/\s+/g, " ").trim().slice(0, 60) || "ללא שם";
}

// ---------- projects ----------

export function listProjects(snap: Snapshot): string[] {
  const names = new Set<string>();
  for (const p of snap.files.keys()) {
    const m = p.match(new RegExp(`^${DIR.projects}/([^/]+)/${STATUS_FILE}$`));
    if (m) names.add(m[1]);
  }
  return [...names].sort((a, b) => a.localeCompare(b, "he"));
}

const norm = (s: string) => s.normalize("NFC").trim().replace(/\s+/g, " ").toLowerCase();

export function resolveProject(snap: Snapshot, name: string): string {
  const all = listProjects(snap);
  const hit = all.find((p) => norm(p) === norm(name));
  if (hit) return hit;
  throw new Error(`לא מצאתי פרויקט בשם "${name}". הפרויקטים הקיימים: ${all.join(", ")}`);
}

const statusPath = (project: string) => `${DIR.projects}/${project}/${STATUS_FILE}`;
const decisionsPath = (project: string) => `${DIR.projects}/${project}/${DECISIONS_FILE}`;

export interface ProjectStatus {
  project: string;
  state: string;
  next_step: string;
  updated: string;
}

export function readStatus(snap: Snapshot, project: string): ProjectStatus {
  const { data } = parseDoc(snap.files.get(statusPath(project)) ?? "");
  return { project, state: str(data.state), next_step: str(data.next_step), updated: str(data.updated) };
}

// ---------- tasks ----------

export interface Task {
  path: string;
  id: string;
  title: string;
  project: string;
  status: string;
  due: string;
  created: string;
  completed: string;
  calendar_event_id: string;
  postponed_count: number;
}

export function listAllTasks(snap: Snapshot): Task[] {
  const tasks: Task[] = [];
  for (const [p, text] of snap.files) {
    if (!p.startsWith(`${DIR.tasks}/`)) continue;
    const { data } = parseDoc(text);
    if (data.type !== "task") continue;
    tasks.push({
      path: p,
      id: str(data.id),
      title: str(data.title),
      project: str(data.project),
      status: str(data.status) || "open",
      due: str(data.due),
      created: str(data.created),
      completed: str(data.completed),
      calendar_event_id: str(data.calendar_event_id),
      postponed_count: Number(data.postponed_count) || 0,
    });
  }
  return tasks.sort((a, b) => (a.due || "9999").localeCompare(b.due || "9999") || a.created.localeCompare(b.created));
}

export const isOverdue = (t: Task, day = today()) => t.status === "open" && !!t.due && t.due < day;

function newTaskId(snap: Snapshot): string {
  const d = today().replace(/-/g, "").slice(2);
  const taken = new Set(listAllTasks(snap).map((t) => t.id));
  for (;;) {
    const id = `t${d}-${Math.random().toString(36).slice(2, 5)}`;
    if (!taken.has(id)) return id;
  }
}

function taskFile(input: { title: string; project: string; due?: string }, id: string): FileChange {
  const stamp = nowStamp();
  const doc: Doc = {
    data: {
      type: "task",
      id,
      title: input.title,
      project: input.project,
      status: "open",
      due: input.due || null,
      created: today(),
      completed: null,
      calendar_event_id: null,
      postponed_count: 0,
      updated: stamp,
    },
    body: `# ${input.title}\n\nפרויקט: [[${statusPath(input.project).replace(/\.md$/, "")}|${input.project}]]\n`,
  };
  return { path: `${DIR.tasks}/${safeName(input.title)} (${id}).md`, content: renderDoc(doc) };
}

function findTask(snap: Snapshot, id: string): { path: string; doc: Doc } {
  const clean = id.trim();
  for (const [p, text] of snap.files) {
    if (!p.startsWith(`${DIR.tasks}/`)) continue;
    const doc = parseDoc(text);
    if (doc.data.type === "task" && str(doc.data.id) === clean) return { path: p, doc };
  }
  throw new Error(`לא מצאתי משימה עם המזהה ${clean}. אפשר למצוא מזהים עם list_tasks.`);
}

const taskLine = (t: Task) =>
  `- [${t.id}] ${t.title} | ${t.project}${t.due ? ` | יעד: ${t.due}` : ""}${t.status === "done" ? " | בוצע" : ""}${t.postponed_count ? ` | נדחתה ${t.postponed_count} פעמים` : ""}${t.calendar_event_id ? ` | יומן: ${t.calendar_event_id}` : ""}`;

// ---------- read operations ----------

export function overview(snap: Snapshot): string {
  const day = today();
  const tasks = listAllTasks(snap).filter((t) => t.status === "open");
  const overdue = tasks.filter((t) => isOverdue(t, day));
  const out: string[] = [`תאריך היום: ${day}`, "", "## מצב הפרויקטים"];
  for (const p of listProjects(snap)) {
    const s = readStatus(snap, p);
    const count = tasks.filter((t) => t.project === p).length;
    out.push(`- ${p}: ${s.state || "(אין סטטוס)"}${s.next_step ? ` | הצעד הבא: ${s.next_step}` : ""}${count ? ` | ${count} משימות פתוחות` : ""}${s.updated ? ` | עודכן ${s.updated}` : ""}`);
  }
  out.push("", "## משימות באיחור");
  out.push(...(overdue.length ? overdue.map(taskLine) : ["אין"]));
  out.push("", "## משימות פתוחות לפי פרויקט");
  const byProject = new Map<string, Task[]>();
  for (const t of tasks) byProject.set(t.project, [...(byProject.get(t.project) ?? []), t]);
  if (!byProject.size) out.push("אין");
  for (const [p, list] of byProject) out.push(`### ${p}`, ...list.map(taskLine));
  out.push("", "## עדכונים אחרונים");
  out.push(...(snap.recent.length ? snap.recent.map((c) => `- ${c.date.slice(0, 10)}: ${c.message}`) : ["אין"]));
  return out.join("\n");
}

export function projectDetails(snap: Snapshot, name: string): string {
  const project = resolveProject(snap, name);
  const s = readStatus(snap, project);
  const out = [`# ${project}`, "", `מצב נוכחי: ${s.state || "(ריק)"}`, `הצעד הבא: ${s.next_step || "(ריק)"}`, `עודכן: ${s.updated || "-"}`];

  const tasks = listAllTasks(snap).filter((t) => t.project === project && t.status === "open");
  out.push("", "## משימות פתוחות", ...(tasks.length ? tasks.map(taskLine) : ["אין"]));

  const decisions = parseDoc(snap.files.get(decisionsPath(project)) ?? "").body;
  const entries = decisions.split(/\n(?=### )/).filter((e) => e.startsWith("### "));
  out.push("", "## החלטות אחרונות", ...(entries.length ? entries.slice(-10).map((e) => e.trim()) : ["אין"]));

  const chatPrefix = `${DIR.projects}/${project}/${CHATS_DIR}/`;
  const chats = [...snap.files.entries()]
    .filter(([p]) => p.startsWith(chatPrefix))
    .map(([p, text]) => ({ p, doc: parseDoc(text) }))
    .sort((a, b) => str(b.doc.data.updated).localeCompare(str(a.doc.data.updated)))
    .slice(0, 5);
  out.push("", "## שיחות אחרונות");
  if (!chats.length) out.push("אין");
  for (const c of chats) {
    const summary = c.doc.body.match(/## סיכום\n([\s\S]*?)(\n## |$)/)?.[1].trim() ?? "";
    out.push(`- ${str(c.doc.data.date)} ${str(c.doc.data.title) || c.p.slice(chatPrefix.length, -3)}: ${summary.slice(0, 400)}`);
  }

  const meetings = [...snap.files.entries()]
    .filter(([p]) => p.startsWith(`${DIR.meetings}/`))
    .map(([p, text]) => ({ p, doc: parseDoc(text) }))
    .filter((m) => m.doc.data.project === project)
    .slice(-3);
  if (meetings.length) out.push("", "## פגישות אחרונות", ...meetings.map((m) => `- ${m.p.slice(DIR.meetings.length + 1, -3)}`));
  return out.join("\n");
}

export type TaskFilter = "open" | "overdue" | "done" | "no_due" | "all";

export function tasksList(snap: Snapshot, filter: TaskFilter, project?: string): string {
  const day = today();
  const proj = project ? resolveProject(snap, project) : undefined;
  const tasks = listAllTasks(snap).filter((t) => {
    if (proj && t.project !== proj) return false;
    switch (filter) {
      case "open": return t.status === "open";
      case "overdue": return isOverdue(t, day);
      case "done": return t.status === "done";
      case "no_due": return t.status === "open" && !t.due;
      default: return true;
    }
  });
  return tasks.length ? tasks.map(taskLine).join("\n") : "לא נמצאו משימות.";
}

export function searchVault(snap: Snapshot, query: string): string {
  const q = norm(query);
  if (!q) throw new Error("צריך מילת חיפוש");
  const hits: string[] = [];
  for (const [p, text] of snap.files) {
    if (p.startsWith(`${DIR.templates}/`)) continue;
    const lines = text.split("\n").filter((l) => norm(l).includes(q));
    const nameHit = norm(p).includes(q);
    if (!lines.length && !nameHit) continue;
    hits.push(`### ${p}`, ...lines.slice(0, 3).map((l) => `> ${l.trim().slice(0, 200)}`));
    if (hits.length > 120) break;
  }
  return hits.length ? hits.join("\n") : `לא נמצא דבר עבור "${query}".`;
}

// ---------- write operations ----------

export async function updateStatus(store: Store, name: string, state: string, nextStep: string): Promise<string> {
  return writeWithRetry(store, (snap) => {
    const project = resolveProject(snap, name);
    const doc = parseDoc(snap.files.get(statusPath(project))!);
    doc.data.state = state;
    doc.data.next_step = nextStep;
    doc.data.updated = nowStamp();
    doc.body = setSection(setSection(doc.body, "מצב נוכחי", state), "הצעד הבא", nextStep);
    return {
      changes: [{ path: statusPath(project), content: renderDoc(doc) }],
      message: `Update status: ${project}`,
      result: `הסטטוס של ${project} עודכן.`,
    };
  });
}

function decisionEntry(decision: string, reason: string): string {
  return `### ${today()}\n- **החלטה:** ${decision}\n- **סיבה:** ${reason}\n`;
}

function appendDecisions(snap: Snapshot, project: string, entries: string[]): FileChange {
  const doc = parseDoc(snap.files.get(decisionsPath(project)) ?? "");
  doc.data = { type: "decisions", project, ...doc.data, updated: nowStamp() };
  if (!doc.body.trim()) doc.body = `# החלטות: ${project}\n`;
  doc.body = `${doc.body.trimEnd()}\n\n${entries.join("\n")}`;
  return { path: decisionsPath(project), content: renderDoc(doc) };
}

export async function addDecision(store: Store, name: string, decision: string, reason: string): Promise<string> {
  return writeWithRetry(store, (snap) => {
    const project = resolveProject(snap, name);
    return {
      changes: [appendDecisions(snap, project, [decisionEntry(decision, reason)])],
      message: `Add decision: ${project}`,
      result: `ההחלטה נרשמה ביומן ההחלטות של ${project}.`,
    };
  });
}

export async function addTask(store: Store, title: string, name: string, due?: string): Promise<string> {
  if (due) checkDate(due, "due");
  return writeWithRetry(store, (snap) => {
    const project = resolveProject(snap, name);
    const id = newTaskId(snap);
    return {
      changes: [taskFile({ title, project, due }, id)],
      message: `Add task ${id}: ${project}`,
      result: `נוצרה משימה ${id}: ${title}${due ? ` (יעד ${due})` : " (בלי תאריך)"}.`,
    };
  });
}

function editTask(store: Store, id: string, edit: (doc: Doc) => { message: string; result: string }): Promise<string> {
  return writeWithRetry(store, (snap) => {
    const { path, doc } = findTask(snap, id);
    const { message, result } = edit(doc);
    doc.data.updated = nowStamp();
    return { changes: [{ path, content: renderDoc(doc) }], message, result };
  });
}

export async function completeTask(store: Store, id: string): Promise<string> {
  return editTask(store, id, (doc) => {
    doc.data.status = "done";
    doc.data.completed = today();
    return { message: `Complete task ${doc.data.id}`, result: `המשימה ${doc.data.id} (${doc.data.title}) סומנה כבוצעה.` };
  });
}

export async function setCalendarEventId(store: Store, id: string, eventId: string): Promise<string> {
  return editTask(store, id, (doc) => {
    doc.data.calendar_event_id = eventId.trim() || null;
    return {
      message: `Link task ${doc.data.id} to calendar event`,
      result: eventId.trim()
        ? `המשימה ${doc.data.id} קושרה לאירוע ביומן ${eventId.trim()}.`
        : `הקישור ליומן של המשימה ${doc.data.id} הוסר.`,
    };
  });
}

export async function postponeTask(store: Store, id: string, newDue: string): Promise<string> {
  checkDate(newDue, "new_due");
  return editTask(store, id, (doc) => {
    const old = str(doc.data.due);
    doc.data.due = newDue;
    doc.data.postponed_count = (Number(doc.data.postponed_count) || 0) + 1;
    return {
      message: `Postpone task ${doc.data.id} to ${newDue}`,
      result: `המשימה ${doc.data.id} נדחתה${old ? ` מ-${old}` : ""} ל-${newDue}. נדחתה ${doc.data.postponed_count} פעמים.`,
    };
  });
}

function uniquePath(snap: Snapshot, dir: string, base: string): string {
  let p = `${dir}/${base}.md`;
  for (let i = 2; snap.files.has(p); i++) p = `${dir}/${base} ${i}.md`;
  return p;
}

const bullets = (items: string[]) => (items.length ? items.map((i) => `- ${i}`).join("\n") : "- אין");

export async function logChatSummary(
  store: Store,
  name: string,
  title: string,
  summary: string,
  decisions: string[],
  tasks: { title: string; due?: string }[],
): Promise<string> {
  for (const t of tasks) if (t.due) checkDate(t.due, `due של "${t.title}"`);
  return writeWithRetry(store, (snap) => {
    const project = resolveProject(snap, name);
    const day = today();
    const chatPath = uniquePath(snap, `${DIR.projects}/${project}/${CHATS_DIR}`, `${day} ${safeName(title)}`);
    const chatLink = `[[${chatPath.replace(/\.md$/, "")}|${title}]]`;

    const changes: FileChange[] = [];
    const taskLinks: string[] = [];
    const work: Snapshot = { ...snap, files: new Map(snap.files) };
    for (const t of tasks) {
      const id = newTaskId(work);
      const file = taskFile({ title: t.title, project, due: t.due }, id);
      work.files.set(file.path, file.content!);
      changes.push(file);
      taskLinks.push(`[[${file.path.replace(/\.md$/, "")}|${t.title}]] (${id})${t.due ? ` יעד ${t.due}` : ""}`);
    }
    if (decisions.length) {
      changes.push(appendDecisions(snap, project, decisions.map((d) => decisionEntry(d, `מתוך השיחה ${chatLink}`))));
    }
    const doc: Doc = {
      data: { type: "chat", project, title, date: day, updated: nowStamp() },
      body: `# ${title}\n\n## סיכום\n${summary}\n\n## החלטות\n${bullets(decisions)}\n\n## משימות\n${bullets(taskLinks)}\n`,
    };
    changes.push({ path: chatPath, content: renderDoc(doc) });
    return {
      changes,
      message: `Log chat summary: ${project}`,
      result: `סיכום השיחה נשמר ב-${chatPath}. נוספו ${decisions.length} החלטות ו-${tasks.length} משימות.`,
    };
  });
}

export async function saveMeeting(
  store: Store,
  name: string,
  title: string,
  people: string[],
  summary: string,
  transcript?: string,
): Promise<string> {
  return writeWithRetry(store, (snap) => {
    const project = resolveProject(snap, name);
    const day = today();
    const p = uniquePath(snap, DIR.meetings, `${day} ${safeName(title)}`);
    const doc: Doc = {
      data: { type: "meeting", project, date: day, people, updated: nowStamp() },
      body:
        `# ${title}\n\nפרויקט: [[${statusPath(project).replace(/\.md$/, "")}|${project}]]\n\n` +
        `## משתתפים\n${bullets(people.map((x) => `[[${x}]]`))}\n\n## סיכום\n${summary}\n` +
        (transcript ? `\n## תמלול\n${transcript}\n` : ""),
    };
    return {
      changes: [{ path: p, content: renderDoc(doc) }],
      message: `Save meeting: ${project}`,
      result: `הפגישה נשמרה ב-${p}.`,
    };
  });
}
