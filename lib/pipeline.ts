// Read-only view of the outreach pipeline ("כסף מהצד") from Supabase.
// Calls the public.pipeline_summary(days) function with the publishable key; never writes.

export const PIPELINE_PROJECT = "כסף מהצד";
const TIMEOUT_MS = 6000;

interface Count { count: number }
export interface PipelineData {
  generated_at: string;
  days: number;
  totals: { leads: number; sent: number; replied: number; replied_auto: number; agreed: number };
  by_status: (Count & { status: string })[];
  by_reply_class: (Count & { reply_class: string | null })[];
  by_channel: (Count & { channel: string | null })[];
  per_day: { day: string; sent: number; replied: number }[];
  by_niche: { niche: string; leads: number; sent: number; replied: number; agreed: number }[];
  replies: {
    id: string;
    company: string;
    niche: string;
    status: string;
    reply_class: string | null;
    reply_at: string;
    consent_at: string | null;
    next_action: string | null;
    next_action_at: string | null;
  }[];
  runs: { run_at: string; niche: string | null; sent_count: number | null; replies_found: number | null; summary: string | null }[];
}

export async function fetchPipeline(days = 7): Promise<PipelineData> {
  const { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_PUBLISHABLE_KEY) throw new Error("Missing SUPABASE_URL / SUPABASE_PUBLISHABLE_KEY");
  const res = await fetch(`${SUPABASE_URL.replace(/\/$/, "")}/rest/v1/rpc/pipeline_summary`, {
    method: "POST", // PostgREST calls functions with POST; the function itself only reads
    headers: { apikey: SUPABASE_PUBLISHABLE_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ days }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = (await res.json()) as PipelineData;
  if (!data?.totals) throw new Error("Unexpected pipeline response");
  return data;
}

// ---------- formatting ----------

const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 1000) / 10}%` : "0%");
const jdate = (iso: string) => new Date(iso).toLocaleDateString("en-CA", { timeZone: "Asia/Jerusalem" });
const label = (s: string | null) => (s ? s.replace(/_/g, " ") : "לא סווג");

function periodTotals(d: PipelineData) {
  return d.per_day.reduce((acc, x) => ({ sent: acc.sent + x.sent, replied: acc.replied + x.replied }), { sent: 0, replied: 0 });
}

export function formatPipeline(d: PipelineData): string {
  const t = d.totals;
  const period = periodTotals(d);
  const out = [
    `# צנרת הפניות (${PIPELINE_PROJECT})`,
    `נכון ל: ${new Date(d.generated_at).toLocaleString("he-IL", { timeZone: "Asia/Jerusalem", dateStyle: "short", timeStyle: "short" })}`,
    "",
    "## סיכום",
    `- לידים: ${t.leads}`,
    `- נשלחו: ${t.sent} (${pct(t.sent, t.leads)} מהלידים)`,
    `- ענו: ${t.replied} (${pct(t.replied, t.sent)} מהשליחות), מתוכם ${t.replied_auto} מענה אוטומטי`,
    `- הסכימו: ${t.agreed} (${pct(t.agreed, t.sent)} מהשליחות)`,
    "",
    "## משפך",
    `נשלחו ${t.sent} → ענו ${t.replied} → הסכימו ${t.agreed}`,
    "",
    "## סוגי תשובות",
    ...d.by_reply_class.map((r) => `- ${label(r.reply_class)}: ${r.count}`),
    "",
    "## לפי סטטוס",
    ...d.by_status.map((s) => `- ${label(s.status)}: ${s.count}`),
    "",
    "## לפי ערוץ שליחה",
    ...d.by_channel.map((c) => `- ${c.channel ?? "לא ידוע"}: ${c.count}`),
    "",
    `## פניות ב-${d.days} הימים האחרונים (נשלחו ${period.sent}, ענו ${period.replied})`,
    ...d.per_day.map((x) => `- ${x.day}: נשלחו ${x.sent}, ענו ${x.replied}`),
    "",
    `## מי ענה (${d.replies.length})`,
    ...d.replies.slice(0, 20).map((r) => {
      const next = r.next_action ? ` | הצעד הבא: ${r.next_action}${r.next_action_at ? ` (${r.next_action_at})` : ""}` : "";
      return `- ${r.id} · ${r.company} · ${r.niche} · ${label(r.reply_class)} · ${jdate(r.reply_at)}${next}`;
    }),
    ...(d.replies.length > 20 ? [`ועוד ${d.replies.length - 20} תשובות ישנות יותר.`] : []),
    "",
    "## לפי נישה",
    ...d.by_niche.map((n) => `- ${n.niche}: ${n.leads} לידים, נשלחו ${n.sent}, ענו ${n.replied}, הסכימו ${n.agreed}`),
    "",
    "## יומן ריצות",
    ...(d.runs.length
      ? d.runs.map((r) => `- ${jdate(r.run_at)} · ${r.niche ?? "-"} · נשלחו ${r.sent_count ?? 0} · תשובות ${r.replies_found ?? 0}${r.summary ? `\n  ${r.summary.replace(/\s+/g, " ").slice(0, 250)}` : ""}`)
      : ["אין ריצות."]),
  ];
  return out.join("\n");
}

export function formatPipelineBrief(d: PipelineData): string {
  const t = d.totals;
  const period = periodTotals(d);
  const last = d.runs[0];
  const latest = d.replies.slice(0, 3).map((r) => `${r.id} ${r.company} (${label(r.reply_class)})`).join(", ");
  return [
    "## מצב הצנרת",
    `- נשלחו ${t.sent} מתוך ${t.leads} לידים. ענו ${t.replied} (${t.replied_auto} אוטומטי). הסכימו ${t.agreed}.`,
    `- ב-${d.days} הימים האחרונים: נשלחו ${period.sent}, ענו ${period.replied}.`,
    ...(last ? [`- ריצה אחרונה: ${jdate(last.run_at)}, ${last.niche ?? "-"}, נשלחו ${last.sent_count ?? 0}, תשובות ${last.replies_found ?? 0}.`] : []),
    ...(latest ? [`- תשובות אחרונות: ${latest}.`] : []),
    "- לפירוט מלא: get_pipeline.",
  ].join("\n");
}

export const PIPELINE_UNAVAILABLE = "## מצב הצנרת\nנתוני הצנרת לא זמינים כרגע.";
