// opencode-session-pro
//
// Give an OpenCode agent memory of past sessions: list, read, full-text search
// and inspect previous conversations.
//
// Why this plugin talks to the HTTP API
// -------------------------------------
// The OpenCode V2 plugin context intentionally does not expose session listing
// (`ctx.session` has get/context/create/...) so a plugin cannot enumerate or
// search past sessions through the plugin API alone. This plugin therefore
// reads the local service registration file that the background service writes
// on startup and calls the local server HTTP API directly.
//
// The plugin has no runtime dependencies and no build step.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// The server rejects `limit` > 200 on /session/{id}/message with a 400, so this
// is a hard ceiling rather than only a sanity cap.
const MAX_MESSAGES_PER_SESSION = 200;
const MAX_SEARCH_SESSIONS = 25;
const MAX_OUTPUT_CHARS = 40000;

// ---------------------------------------------------------------------------
// OpenCode service access
// ---------------------------------------------------------------------------

function registrationFile() {
  const base = process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state");
  return join(base, "opencode", "service.json");
}

function readService() {
  const info = JSON.parse(readFileSync(registrationFile(), "utf8"));
  if (!info?.url || !info?.password) {
    throw new Error("No url/password found in service.json");
  }
  return info;
}

async function api(path, params = {}, signal) {
  const info = readService();
  const url = new URL(path, info.url);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }
  const auth = Buffer.from(`opencode:${info.password}`).toString("base64");
  const res = await fetch(url, {
    headers: { Authorization: `Basic ${auth}` },
    signal,
  });
  if (!res.ok) throw new Error(`OpenCode API ${res.status} on ${path}`);
  return res.json();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseDay(text, endOfDay) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(text ?? "").trim());
  if (!m) return undefined;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const d = endOfDay
    ? new Date(year, month - 1, day, 23, 59, 59, 999)
    : new Date(year, month - 1, day, 0, 0, 0, 0);
  const time = d.getTime();
  return Number.isNaN(time) ? undefined : time;
}

function formatTime(ms) {
  if (typeof ms !== "number") return "";
  try {
    return new Date(ms).toLocaleString();
  } catch {
    return String(ms);
  }
}

function truncate(text, max = MAX_OUTPUT_CHARS) {
  if (text.length <= max) return text;
  return text.slice(0, max) + `\n\n[... output truncated at ${max} characters]`;
}

/** Text carried by one content part of an assistant message. */
function partText(part) {
  if (!part) return "";
  if (typeof part.text === "string" && part.type !== "tool") return part.text;
  if (part.type === "tool") {
    const state = part.state ?? {};
    const lines = [`(tool: ${part.name ?? "unknown"} -> ${state.status ?? "?"})`];
    const input = state.input ?? {};
    if (typeof input.command === "string") lines.push("$ " + input.command);
    else if (Object.keys(input).length > 0) lines.push(JSON.stringify(input));
    const out = toolOutput(state);
    if (out) lines.push(out);
    return lines.join("\n");
  }
  return typeof part.text === "string" ? part.text : "";
}

function toolOutput(state) {
  const content = state.content ?? state.output;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (typeof c === "string" ? c : (c?.text ?? "")))
      .filter(Boolean)
      .join("\n");
  }
  if (Array.isArray(content?.content)) return toolOutput({ content: content.content });
  return "";
}

/** All human-readable text of a message (user text, assistant parts, ...). */
function messageText(msg) {
  const out = [];
  if (typeof msg.text === "string") out.push(msg.text);
  if (typeof msg.content === "string") out.push(msg.content);
  if (Array.isArray(msg.content)) {
    for (const part of msg.content) {
      const text = partText(part);
      if (text) out.push(text);
    }
  }
  return out.join("\n");
}

function roleOf(msg) {
  return String(msg.type ?? msg.role ?? "unknown");
}

/**
 * Fetch up to `limit` messages, following the cursor.
 *
 * The server rejects `limit` above 200 (400) and documents that `order` must
 * NOT be combined with `cursor`; only the first page carries `order`.
 */
async function collectMessages(sessionID, { limit = 100, order = "asc", type } = {}, signal) {
  const wanted = Math.min(Number(limit) || 100, MAX_MESSAGES_PER_SESSION);
  const all = [];
  let cursor;
  for (let page = 0; page < 20 && all.length < wanted; page++) {
    const params = cursor
      ? { cursor, limit: wanted - all.length, type }
      : { limit: wanted, order, type };
    const res = await api(`/api/session/${encodeURIComponent(sessionID)}/message`, params, signal);
    const batch = res.data ?? [];
    all.push(...batch);
    const next = res.cursor?.next;
    if (!next || batch.length === 0) break;
    cursor = next;
  }
  return all;
}

function describeSession(s) {
  const model = s.model ? `${s.model.providerID}/${s.model.id}` : "";
  return [
    `id: ${s.id}`,
    `title: ${s.title ?? "(untitled)"}`,
    `directory: ${s.location?.directory ?? ""}`,
    `agent: ${s.agent ?? ""}  model: ${model}`,
    `created: ${formatTime(s.time?.created)}  updated: ${formatTime(s.time?.updated)}`,
    `outcome: ${s.outcome ?? ""}`,
    `tokens: in=${s.tokens?.input ?? 0} out=${s.tokens?.output ?? 0}`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Query building shared by session_list / session_search
// ---------------------------------------------------------------------------

async function querySessions(input, signal) {
  const limit = Math.min(Number(input.limit) || 20, 100);
  const params = {
    limit: input.from_date || input.to_date ? limit * 3 : limit,
    order: input.order === "asc" ? "asc" : "desc",
    search: input.search || undefined,
  };
  if (!input.all_scopes) params.directory = input.project_path || input.directory;
  const res = await api("/api/session", params, signal);
  let sessions = res.data ?? [];

  const from = parseDay(input.from_date, false);
  const to = parseDay(input.to_date, true);
  if (from !== undefined) sessions = sessions.filter((s) => (s.time?.created ?? 0) >= from);
  if (to !== undefined) sessions = sessions.filter((s) => (s.time?.created ?? 0) <= to);
  return sessions.slice(0, limit);
}

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

async function sessionList(input, context) {
  const sessions = await querySessions(input, context.signal);
  if (sessions.length === 0) {
    return "No sessions matched those filters.";
  }
  const header =
    "| # | Session ID | Title | Agent | Created | Updated | Outcome |\n" +
    "|---|------------|-------|-------|---------|---------|---------|";
  const rows = sessions.map(
    (s, i) =>
      `| ${i + 1} | ${s.id} | ${String(s.title ?? "(untitled)").replace(/\|/g, "\\|")} | ${
        s.agent ?? ""
      } | ${formatTime(s.time?.created)} | ${formatTime(s.time?.updated)} | ${s.outcome ?? ""} |`,
  );
  const scope = input.all_scopes
    ? "all directories"
    : `directory: ${input.project_path ?? input.directory ?? "current"}`;
  return truncate(
    `Sessions (${sessions.length}) - ${scope}${
      input.search ? ` - title contains "${input.search}"` : ""
    }:\n\n${header}\n${rows.join("\n")}\n\nUse session_read with a Session ID to view its messages.`,
  );
}

async function sessionRead(input, context) {
  const sessionID = input.session_id;
  if (!sessionID) return "Error: session_id is required.";
  const meta = await api(`/api/session/${encodeURIComponent(sessionID)}`, {}, context.signal);
  const info = meta.data ?? meta;
  const messages = await collectMessages(
    sessionID,
    {
      limit: Number(input.limit) || 100,
      order: input.order === "desc" ? "desc" : "asc",
      type: input.type || undefined,
    },
    context.signal,
  );
  if (messages.length === 0) return `Session ${sessionID} has no messages (or is not visible).`;

  const blocks = messages.map((msg, i) => {
    const role = roleOf(msg).toUpperCase();
    const bits = [];
    if (role === "ASSISTANT") {
      if (msg.agent) bits.push(`agent ${msg.agent}`);
      if (msg.model) bits.push(`${msg.model.providerID}/${msg.model.id}`);
    }
    if (msg.time?.created) bits.push(formatTime(msg.time.created));
    const text = messageText(msg).trim();
    return `[${i + 1}] ${role}${bits.length ? " - " + bits.join(" - ") : ""}\n${text || "(no text)"}`;
  });

  const orderNote = input.order === "desc" ? "desc (newest first)" : "asc (chronological)";
  return truncate(
    `Session ${info.id}\nTitle: ${info.title ?? "(untitled)"}\nDirectory: ${
      info.location?.directory ?? ""
    }\nMessages shown: ${messages.length} - order ${orderNote}\n\n${blocks.join("\n\n")}`,
  );
}

async function sessionSearch(input, context) {
  const query = String(input.query ?? "").trim();
  if (!query) return "Error: query is required.";
  const rx = new RegExp(escapeRegExp(query), input.case_sensitive ? "" : "i");

  // Single-session search: scan that session only.
  if (input.session_id) {
    const matches = await searchInSession(
      input.session_id,
      rx,
      Number(input.limit) || 20,
      context.signal,
    );
    return matches.length
      ? truncate(renderMatches(matches, query, { id: input.session_id, title: null, location: null }))
      : `No matches for "${query}" in ${input.session_id}.`;
  }

  // Cross-session search. The API ?search= only matches titles, so we scan messages.
  const sessions = await querySessions(
    {
      ...input,
      limit: Math.min(Number(input.max_sessions) || MAX_SEARCH_SESSIONS, MAX_SEARCH_SESSIONS),
    },
    context.signal,
  );
  const results = [];
  let scanned = 0;
  let budget = Number(input.limit) || 20;
  for (const session of sessions) {
    if (budget <= 0) break;
    scanned++;
    try {
      const found = await searchInSession(session.id, rx, budget, context.signal);
      if (found.length) {
        budget -= found.length;
        results.push({ session, found });
      }
    } catch {
      // A session that cannot be read is skipped rather than failing the search.
    }
  }

  if (results.length === 0) {
    return `No matches for "${query}" in the ${scanned} sessions scanned.`;
  }
  const note =
    sessions.length >= MAX_SEARCH_SESSIONS
      ? `\n\n[Note: scanned ${scanned} of ${sessions.length} candidate sessions. Narrow it down with project_path, dates or session_id.]`
      : `\n\n[Sessions scanned: ${scanned}]`;
  return truncate(
    results.map((r) => renderMatches(r.found, query, r.session)).join("\n\n---\n\n") + note,
  );
}

async function searchInSession(sessionID, rx, maxMatches, signal) {
  const messages = await collectMessages(
    sessionID,
    { limit: MAX_MESSAGES_PER_SESSION, order: "asc" },
    signal,
  );
  const matches = [];
  for (let i = 0; i < messages.length && matches.length < maxMatches; i++) {
    const text = messageText(messages[i]);
    if (!text) continue;
    const m = rx.exec(text);
    if (!m) continue;
    const start = Math.max(0, m.index - 120);
    const end = Math.min(text.length, m.index + m[0].length + 160);
    const snippet = text.slice(start, end).replace(/\s+/g, " ").trim();
    matches.push({
      index: i + 1,
      role: roleOf(messages[i]),
      created: messages[i].time?.created,
      snippet: `${start > 0 ? "..." : ""}${snippet}${end < text.length ? "..." : ""}`,
    });
  }
  if (matches.length >= maxMatches) {
    matches.push({ index: -1, role: "note", created: null, snippet: "(match limit reached)" });
  }
  return matches;
}

function renderMatches(matches, query, session) {
  const head = session
    ? `Session ${session.id}\nTitle: ${session.title ?? "(untitled)"}\nDirectory: ${
        session.location?.directory ?? ""
      }`
    : `Results for "${query}"`;
  const lines = matches.map((m) =>
    m.index === -1
      ? `  ${m.snippet}`
      : `  [msg ${m.index}] ${m.role.toUpperCase()}${m.created ? " - " + formatTime(m.created) : ""}\n    ${m.snippet}`,
  );
  return `${head}\n${lines.join("\n")}`;
}

async function sessionInfo(input, context) {
  const sessionID = input.session_id;
  if (!sessionID) return "Error: session_id is required.";
  const meta = await api(`/api/session/${encodeURIComponent(sessionID)}`, {}, context.signal);
  const info = meta.data ?? meta;

  let messages = [];
  let truncated = false;
  let readError = null;
  try {
    messages = await collectMessages(
      sessionID,
      { limit: MAX_MESSAGES_PER_SESSION, order: "asc" },
      context.signal,
    );
    truncated = messages.length >= MAX_MESSAGES_PER_SESSION;
  } catch (e) {
    readError = e?.message ?? String(e);
  }

  const byType = {};
  const agents = new Set();
  const models = new Set();
  for (const m of messages) {
    const role = roleOf(m);
    byType[role] = (byType[role] ?? 0) + 1;
    if (m.agent) agents.add(m.agent);
    if (m.model) models.add(`${m.model.providerID}/${m.model.id}`);
  }

  const durationMs = (info.time?.updated ?? 0) - (info.time?.created ?? 0);
  const lines = [
    describeSession(info),
    `messages: ${messages.length}${truncated ? " (maximum reached)" : ""}${
      messages.length
        ? ` - ${Object.entries(byType)
            .map(([k, v]) => `${k}=${v}`)
            .join(", ")}`
        : ""
    }`,
  ];
  if (readError) lines.push(`note: could not read messages (${readError})`);
  lines.push(
    `duration: ${Math.round(durationMs / 60000)} min`,
    `agents used: ${agents.size ? [...agents].join(", ") : "-"}`,
    `models used: ${models.size ? [...models].join(", ") : "-"}`,
    `cost USD: ${info.cost ?? 0}`,
  );
  if (messages.length) {
    lines.push(
      `first activity: ${formatTime(messages[0].time?.created)}`,
      `last activity: ${formatTime(messages[messages.length - 1].time?.created ?? info.time?.updated)}`,
    );
  }
  return truncate(lines.join("\n"));
}

// ---------------------------------------------------------------------------
// Plugin definition (OpenCode V2 shape)
// ---------------------------------------------------------------------------

const sessionInput = {
  type: "object",
  properties: {
    limit: { type: "number", description: "Maximum number of results (default 20 for list, 100 for read)" },
    order: { type: "string", enum: ["asc", "desc"], description: "Sort order by creation time (default desc for list, asc for read)" },
    search: { type: "string", description: "Filter by session TITLE substring (not message content)" },
    project_path: { type: "string", description: "Override project directory for scoping (defaults to the current directory)" },
    all_scopes: { type: "boolean", description: "Search across all directories instead of the current one" },
    from_date: { type: "string", description: "Only sessions created from this date (YYYY-MM-DD, inclusive, local time)" },
    to_date: { type: "string", description: "Only sessions created until this date (YYYY-MM-DD, inclusive end of day)" },
  },
  additionalProperties: false,
};

export default {
  id: "opencode-session-pro",
  async setup(ctx) {
    const location = ctx.location;

    await ctx.tool.transform((editor) => {
      editor.add({
        name: "session_list",
        description:
          "List recent OpenCode sessions (ID, title, agent, timestamps, outcome). Supports title filtering and date ranges. Use this first to discover session IDs before session_read / session_search / session_info.",
        input: sessionInput,
        async execute(input, context) {
          try {
            return {
              content: await sessionList({ ...input, directory: input.project_path ?? location.directory }, context),
            };
          } catch (e) {
            return { content: `Error listing sessions: ${e?.message ?? e}` };
          }
        },
      });

      editor.add({
        name: "session_read",
        description:
          "Read the messages of one OpenCode session in chronological order, rendered as text (user prompts, assistant replies, tool calls).",
        input: {
          type: "object",
          properties: {
            session_id: { type: "string", description: "Session ID to read (ses_...)" },
            limit: { type: "number", description: "Maximum messages to read (default 100, max 200)" },
            order: { type: "string", enum: ["asc", "desc"], description: "Chronological order (default asc)" },
            type: { type: "string", description: "Only messages of this type, e.g. user or assistant" },
          },
          required: ["session_id"],
          additionalProperties: false,
        },
        async execute(input, context) {
          try {
            return { content: await sessionRead(input, context) };
          } catch (e) {
            return { content: `Error reading session: ${e?.message ?? e}` };
          }
        },
      });

      editor.add({
        name: "session_search",
        description:
          "Full-text search across OpenCode session MESSAGES (the API title search is not enough). Returns matched snippets with session ID, message index and timestamp.",
        input: {
          type: "object",
          properties: {
            query: { type: "string", description: "Text to search for (case-insensitive by default)" },
            session_id: { type: "string", description: "Restrict the search to a single session" },
            case_sensitive: { type: "boolean", description: "Match case sensitively (default false)" },
            limit: { type: "number", description: "Maximum matches to return (default 20)" },
            max_sessions: { type: "number", description: "Maximum sessions to scan (default 25)" },
            project_path: { type: "string", description: "Override project directory for scoping" },
            all_scopes: { type: "boolean", description: "Search across all directories" },
            from_date: { type: "string", description: "Only sessions created from this date (YYYY-MM-DD)" },
            to_date: { type: "string", description: "Only sessions created until this date (YYYY-MM-DD)" },
          },
          required: ["query"],
          additionalProperties: false,
        },
        async execute(input, context) {
          try {
            return {
              content: await sessionSearch({ ...input, directory: input.project_path ?? location.directory }, context),
            };
          } catch (e) {
            return { content: `Error searching: ${e?.message ?? e}` };
          }
        },
      });

      editor.add({
        name: "session_info",
        description:
          "Metadata and statistics for one OpenCode session: title, directory, agent, model, message counts, date range, duration, agents/models used and cost.",
        input: {
          type: "object",
          properties: {
            session_id: { type: "string", description: "Session ID to inspect (ses_...)" },
          },
          required: ["session_id"],
          additionalProperties: false,
        },
        async execute(input, context) {
          try {
            return { content: await sessionInfo(input, context) };
          } catch (e) {
            return { content: `Error getting info: ${e?.message ?? e}` };
          }
        },
      });
    });

    try {
      console.log(`[opencode-session-pro] ready - API ${readService().url}`);
    } catch {
      // The service registration file is read lazily by each tool call, so a
      // missing file here must not prevent the plugin from loading.
    }
  },
};
