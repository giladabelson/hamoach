// MCP tool definitions. Descriptions tell Claude WHEN to call each tool.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Store } from "./store.js";
import * as vault from "./vault.js";

const PROJECT_HINT =
  "Project name exactly as it appears in the Brain (e.g. 'LaBot 2.0', 'חיפוש עבודה'). If unsure, call get_overview first to see the list.";
const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD");

export function createServer(store: Store): McpServer {
  const server = new McpServer({ name: "hamoach", version: "1.0.0" });

  const run = async (fn: () => Promise<string>) => {
    try {
      return { content: [{ type: "text" as const, text: await fn() }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: `שגיאה: ${(e as Error).message}` }], isError: true };
    }
  };
  const read = (fn: (snap: Awaited<ReturnType<Store["snapshot"]>>) => string) =>
    run(async () => fn(await store.snapshot()));

  server.registerTool(
    "get_overview",
    {
      title: "Brain overview",
      description:
        "Read Gilad's whole picture from the Brain (his central knowledge base): every project's status and next step, overdue tasks, open tasks by project, and the latest updates. " +
        "Call this when Gilad asks what is open, what is urgent, what to work on, how things stand in general, or when you need the list of project names. Read-only.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    () => read((snap) => vault.overview(snap)),
  );

  server.registerTool(
    "get_project",
    {
      title: "Project context",
      description:
        "Read one project's context from the Brain: current status, next step, open tasks, recent decisions, recent chat summaries. " +
        "Call this at the START of every chat that belongs to a project, before answering, so you continue from where Gilad left off. Also call it when he asks about a specific project. Read-only.",
      inputSchema: { project: z.string().describe(PROJECT_HINT) },
      annotations: { readOnlyHint: true },
    },
    ({ project }) => read((snap) => vault.projectDetails(snap, project)),
  );

  server.registerTool(
    "update_status",
    {
      title: "Update project status",
      description:
        "Overwrite a project's current status and next step in the Brain. " +
        "Call this at the end of any reply in which real progress happened in the project (something was built, solved, sent, finished or changed direction). Write the full current state, not a diff. Write in Hebrew.",
      inputSchema: {
        project: z.string().describe(PROJECT_HINT),
        status: z.string().describe("Where the project stands now, 1-3 short sentences, Hebrew."),
        next_step: z.string().describe("The single concrete next step, Hebrew."),
      },
    },
    ({ project, status, next_step }) => run(() => vault.updateStatus(store, project, status, next_step)),
  );

  server.registerTool(
    "add_decision",
    {
      title: "Log a decision",
      description:
        "Append a dated decision to a project's decision log in the Brain. " +
        "Call this whenever Gilad decides something or approves a choice (tool, approach, scope, design, price, who to contact), so future chats do not reopen it. One call per decision. Hebrew.",
      inputSchema: {
        project: z.string().describe(PROJECT_HINT),
        decision: z.string().describe("What was decided, one sentence."),
        reason: z.string().describe("Why, one sentence."),
      },
    },
    ({ project, decision, reason }) => run(() => vault.addDecision(store, project, decision, reason)),
  );

  server.registerTool(
    "log_chat_summary",
    {
      title: "Save chat summary",
      description:
        "Save a summary of the current chat into the project's chat log, and in the same write add its decisions to the decision log and create its tasks. " +
        "Call this at the end of an important chat (real work done, decisions made, or tasks came up), or when Gilad says to save/summarize. Do not also call add_decision/add_task for the same items. Hebrew.",
      inputSchema: {
        project: z.string().describe(PROJECT_HINT),
        title: z.string().describe("Short title of the chat, Hebrew."),
        summary: z.string().describe("What was done and concluded, a few short lines."),
        decisions: z.array(z.string()).default([]).describe("Decisions made in this chat, one sentence each."),
        tasks: z
          .array(z.object({ title: z.string(), due: DATE.optional().describe("YYYY-MM-DD, only if a real date was given") }))
          .default([])
          .describe("New tasks that came up."),
      },
    },
    ({ project, title, summary, decisions, tasks }) =>
      run(() => vault.logChatSummary(store, project, title, summary, decisions, tasks)),
  );

  server.registerTool(
    "add_task",
    {
      title: "Add task",
      description:
        "Create one task in the Brain. " +
        "Call this when Gilad says he needs to / should / will do something, or asks to be reminded, or you agree on an action item. Give a due date only if he named a date or deadline; otherwise leave it empty (an open task, never overdue). Hebrew title.",
      inputSchema: {
        title: z.string().describe("Short action, Hebrew, e.g. 'לשלוח מייל למנחה'."),
        project: z.string().describe(PROJECT_HINT),
        due: DATE.optional().describe("YYYY-MM-DD. Omit if no date was given."),
      },
    },
    ({ title, project, due }) => run(() => vault.addTask(store, title, project, due)),
  );

  server.registerTool(
    "complete_task",
    {
      title: "Complete task",
      description:
        "Mark a task as done (it is kept, never deleted). " +
        "Call this when Gilad says he did / finished / sent something that matches an open task. Get the id from get_project or list_tasks first.",
      inputSchema: { id: z.string().describe("Task id, e.g. t261026-k3x") },
    },
    ({ id }) => run(() => vault.completeTask(store, id)),
  );

  server.registerTool(
    "postpone_task",
    {
      title: "Postpone task",
      description:
        "Move a task's due date and count the postponement. " +
        "Call this when Gilad says a task moves to another day, or he will not get to it by its date. Get the id from get_project or list_tasks first.",
      inputSchema: {
        id: z.string().describe("Task id, e.g. t261026-k3x"),
        new_due: DATE.describe("New due date, YYYY-MM-DD."),
      },
    },
    ({ id, new_due }) => run(() => vault.postponeTask(store, id, new_due)),
  );

  server.registerTool(
    "list_tasks",
    {
      title: "List tasks",
      description:
        "List tasks from the Brain with their ids. " +
        "Call this when Gilad asks what tasks he has, what is overdue, what he finished, or before complete_task / postpone_task when you need an id. Read-only.",
      inputSchema: {
        filter: z
          .enum(["open", "overdue", "done", "no_due", "all"])
          .default("open")
          .describe("open = not done; overdue = open with a past due date; done; no_due = open without a date; all."),
        project: z.string().optional().describe("Optional. Limit to one project."),
      },
      annotations: { readOnlyHint: true },
    },
    ({ filter, project }) => read((snap) => vault.tasksList(snap, filter, project)),
  );

  server.registerTool(
    "search",
    {
      title: "Search the Brain",
      description:
        "Full-text search across the whole Brain (statuses, decisions, chat summaries, tasks, meetings, people). " +
        "Call this when Gilad asks 'what did we decide about X', 'when did I talk about Y', or you need past context that get_project does not show. Read-only.",
      inputSchema: { query: z.string().describe("Word or phrase to find, Hebrew or English.") },
      annotations: { readOnlyHint: true },
    },
    ({ query }) => read((snap) => vault.searchVault(snap, query)),
  );

  server.registerTool(
    "save_meeting",
    {
      title: "Save meeting",
      description:
        "Save a meeting summary (and optional transcript) to the Brain's meetings folder, linked to a project and its participants. " +
        "Call this when Gilad shares notes, a summary or a transcript of a meeting or call and wants it kept.",
      inputSchema: {
        project: z.string().describe(PROJECT_HINT),
        title: z.string().describe("Meeting title, Hebrew."),
        people: z.array(z.string()).default([]).describe("Participants' names."),
        summary: z.string().describe("Summary of the meeting, Hebrew."),
        transcript: z.string().optional().describe("Full transcript, only if Gilad provided one."),
      },
    },
    ({ project, title, people, summary, transcript }) =>
      run(() => vault.saveMeeting(store, project, title, people, summary, transcript)),
  );

  return server;
}
