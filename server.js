require("dotenv").config({ path: require("path").resolve(__dirname, "../../.env") });
const dns = require("dns");
dns.setDefaultResultOrder("ipv4first");
const { Agent: UndiciAgent, setGlobalDispatcher } = require("undici");
setGlobalDispatcher(new UndiciAgent({
  connect: {
    autoSelectFamily: true,
    autoSelectFamilyAttemptTimeout: 2500,
  },
  keepAliveTimeout: 60_000,
  keepAliveMaxTimeout: 120_000,
  pipelining: 1,
}));
const express = require("express");
const cron = require("node-cron");
const { WebSocketServer } = require("ws");
const { spawn } = require("child_process");
const http = require("http");
const path = require("path");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");
const { marked } = require("marked");

const PORT = process.env.PORT || 3111;
const CONTEXT_TIMEZONE = process.env.TZ || "Europe/London";
const AGENT_WEB_PASSWORD = process.env.AGENT_WEB_PASSWORD || null;
const CHANGELOG_SECRET = (process.env.CHANGELOG_SECRET || "").trim() || null;
const SCHEDULED_JOBS_PATH = path.join(__dirname, "data", "scheduled-jobs.json");
const TELEGRAM_CHAT_STATE_PATH = path.join(__dirname, "data", "telegram-chat-state.json");
const CHANGELOGS_DIR = path.join(__dirname, "data", "changelogs");
const AUTH_COOKIE_NAME = "agent_web_auth";
const AUTH_COOKIE_MAX_AGE = 7 * 24 * 60 * 60; // 7 days
const CONVERSATIONS_DIR = path.join(__dirname, "data", "conversations");
const OUTPUTS_DIR = path.join(__dirname, "data", "outputs");
const WORKSPACE = process.env.WORKSPACE || path.resolve(__dirname, "../..");
const REPORTS_DIR = path.join(WORKSPACE, ".tmp");
const DEBUG = process.env.DEBUG === "1";

const CLI_PROFILES = {
  agent: {
    bin: process.env.AGENT_BIN || "agent",
    label: "Cursor Agent",
    buildArgs(prompt, sessionId, model, mode, _geminiSessionId) {
      const args = ["--print", "--output-format", "stream-json", "--stream-partial-output"];
      args.push("--workspace", WORKSPACE);
      args.push("--trust", "--approve-mcps", "--force");
      args.push("--model", model === "auto" || !model ? "auto" : model);
      if (mode) args.push("--mode", mode);
      if (sessionId && sessions.has(sessionId)) args.push("--resume", sessionId);
      args.push(prompt);
      return args;
    },
    modelsCmd: ["models"],
  },
  claude: {
    bin: process.env.CLAUDE_BIN || "claude",
    label: "Claude Code",
    buildArgs(prompt, sessionId, model, mode, _geminiSessionId) {
      const args = ["--print", "--output-format", "stream-json", "--include-partial-messages"];
      args.push("--dangerously-skip-permissions");
      args.push("--model", model === "auto" || !model ? "sonnet" : model);
      if (mode) args.push("--mode", mode);
      if (sessionId && sessions.has(sessionId)) args.push("--resume", sessionId);
      args.push(prompt);
      return args;
    },
    modelsCmd: null,
  },
  gemini: {
    bin: process.env.GEMINI_BIN || "gemini",
    label: "Gemini CLI",
    // Gemini CLI headless mode: use plain text output so the
    // web UI treats each line as raw text (agent-raw) without
    // requiring a custom event protocol.
    buildArgs(prompt, sessionId, model /* unused */, mode /* unused */, geminiSessionId) {
      const args = [];
      // Headless (-p) has no TTY: run_shell_command and other tools would wait
      // forever for approval. -y (--yolo) auto-approves. Disable with GEMINI_YOLO=0.
      const yoloOff = ["0", "false", "off", "no"].includes(
        String(process.env.GEMINI_YOLO || "").toLowerCase()
      );
      if (!yoloOff) args.push("-y");
      const sid = (geminiSessionId && String(geminiSessionId).trim()) || "";
      if (sid.length >= 8) args.push("--resume", sid);
      args.push("-p", prompt);
      args.push("--output-format", "stream-json");
      if (model && model !== "auto") {
        args.push("--model", model);
      }
      return args;
    },
    // Gemini CLI does not currently expose a simple "models" command
    // that mirrors Cursor/Claude, so skip model listing for now.
    modelsCmd: null,
  },
};
let currentCli = (process.env.AGENT_CLI || "agent").toLowerCase();
if (!CLI_PROFILES[currentCli]) currentCli = "agent";
const TELEGRAM_BOT_TOKEN = (process.env.TELEGRAM_BOT_TOKEN || "").trim() || null;
const TELEGRAM_ENABLED = process.env.TELEGRAM_ENABLED !== "0" && process.env.TELEGRAM_ENABLED !== "false" && process.env.TELEGRAM_ENABLED !== "off";
// Optional: comma-separated Telegram user IDs. If set, only these users can use the bot.
const TELEGRAM_ALLOWED_IDS = (process.env.TELEGRAM_ALLOWED_USER_IDS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const TELEGRAM_MAX_MESSAGE_LENGTH = 4096;
// Chat ID to send reminder messages to (scheduled jobs with telegramReminder: true). If unset, uses first TELEGRAM_ALLOWED_USER_IDS.
const TELEGRAM_REMINDER_CHAT_ID = (process.env.TELEGRAM_REMINDER_CHAT_ID || "").trim()
  || (TELEGRAM_ALLOWED_IDS.length > 0 ? TELEGRAM_ALLOWED_IDS[0] : null);

function authCookieValue() {
  if (!AGENT_WEB_PASSWORD) return null;
  return crypto.createHmac("sha256", AGENT_WEB_PASSWORD).update("agent-web-auth").digest("hex");
}

function parseAuthCookie(req) {
  const raw = req.headers.cookie;
  if (!raw) return null;
  const m = raw.split(";").map((s) => s.trim()).find((s) => s.startsWith(AUTH_COOKIE_NAME + "="));
  return m ? decodeURIComponent(m.slice(AUTH_COOKIE_NAME.length + 1)) : null;
}

function isAuthValid(req) {
  const expected = authCookieValue();
  if (!expected) return true;
  const got = parseAuthCookie(req);
  if (!got || got.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(got, "hex"), Buffer.from(expected, "hex"));
}

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

app.use(express.urlencoded({ extended: true, limit: "1mb" }));
app.use(express.json({ limit: "1mb" }));

function getChangelogSecretReq(req) {
  const auth = req.headers.authorization;
  if (auth && auth.startsWith("Bearer ")) return auth.slice(7).trim();
  return (req.headers["x-changelog-secret"] || "").trim();
}

app.use((req, res, next) => {
  if (!AGENT_WEB_PASSWORD) return next();
  if (isAuthValid(req)) return next();
  if (req.path === "/login" && req.method === "GET") return next();
  if (req.path === "/login" && req.method === "POST") return next();
  if (req.path === "/login") return res.redirect(302, "/login");
  if (req.path === "/api/changelogs" && req.method === "POST" && getChangelogSecretReq(req)) return next();
  if (req.path === "/api/openapi.json" && req.method === "GET") return next();
  const outputSecret = (req.headers["x-output-secret"] || (req.headers.authorization && req.headers.authorization.startsWith("Bearer ") ? req.headers.authorization.slice(7).trim() : "") || "").trim();
  if (req.path === "/api/outputs" && req.method === "POST" && process.env.AGENT_WEB_OUTPUT_SECRET && outputSecret === process.env.AGENT_WEB_OUTPUT_SECRET) return next();
  if (req.method === "GET" && (req.path.startsWith("/output/") || req.path.startsWith("/reports/"))) return next();
  if (req.method !== "GET" || !req.accepts("html")) return res.status(401).json({ error: "Unauthorized" });
  return res.redirect(302, "/login?redirect=" + encodeURIComponent(req.originalUrl || "/"));
});

app.use(express.static(path.join(__dirname, "public")));

app.get("/login", (req, res) => {
  if (AGENT_WEB_PASSWORD && isAuthValid(req)) return res.redirect(302, req.query.redirect || "/");
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(`<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Login — Agent</title>
<style>body{font-family:system-ui,sans-serif;background:#1a1a2e;color:#e0e0e0;margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;}
form{background:#16213e;padding:24px;border-radius:8px;border:1px solid #2a2a4a;width:100%;max-width:320px;}
input[type=password]{width:100%;padding:12px;margin:8px 0 16px;background:#0f1729;border:1px solid #2a2a4a;border-radius:6px;color:#e0e0e0;font-size:16px;box-sizing:border-box;}
button{width:100%;padding:12px;background:#64ffda;color:#1a1a2e;border:none;border-radius:6px;font-weight:600;cursor:pointer;font-size:14px;}
button:hover{background:#52e0c4;} h1{font-size:18px;margin:0 0 16px;color:#64ffda;}</style></head>
<body><form method="post" action="/login"><h1>Agent Web UI</h1><label for="pw">Password</label><input id="pw" name="password" type="password" autocomplete="current-password" required autofocus><button type="submit">Log in</button></form></body></html>`);
});

app.post("/login", (req, res) => {
  const redirect = (req.query.redirect && req.query.redirect.startsWith("/") && !req.query.redirect.startsWith("//")) ? req.query.redirect : "/";
  if (!AGENT_WEB_PASSWORD) return res.redirect(302, redirect);
  const expected = crypto.createHmac("sha256", "agent-web-login").update(AGENT_WEB_PASSWORD).digest();
  const got = crypto.createHmac("sha256", "agent-web-login").update(req.body.password || "").digest();
  if (expected.length !== got.length || !crypto.timingSafeEqual(expected, got)) return res.status(401).setHeader("Content-Type", "text/html; charset=utf-8").send(`<!DOCTYPE html><html><body><p>Invalid password.</p><a href="/login">Try again</a></body></html>`);
  const val = authCookieValue();
  res.cookie(AUTH_COOKIE_NAME, val, { httpOnly: true, maxAge: AUTH_COOKIE_MAX_AGE * 1000, sameSite: "lax", path: "/" });
  res.redirect(302, redirect);
});

server.on("upgrade", (request, socket, head) => {
  if (AGENT_WEB_PASSWORD && !isAuthValid(request)) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }
  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit("connection", ws, request);
  });
});

const sessions = new Map();
const telegramChatState = new Map(); // chatId (string) -> { sessionId, sessionIds, model, cli, voiceReply }
let telegramOffset = 0;
let telegramPolling = false;
let telegramPollAbort = null;

function loadTelegramChatState() {
  try {
    if (!fs.existsSync(TELEGRAM_CHAT_STATE_PATH)) return;
    const raw = fs.readFileSync(TELEGRAM_CHAT_STATE_PATH, "utf8");
    const obj = JSON.parse(raw);
    const defaults = {
      sessionId: null,
      sessionIds: [],
      geminiSessionId: null,
      model: "auto",
      cli: currentCli,
      voiceReply: false,
    };
    for (const [key, val] of Object.entries(obj)) {
      const sessionIds = Array.isArray(val.sessionIds) ? val.sessionIds : [];
      const sessionId = val.sessionId || null;
      if (sessionId && !sessionIds.includes(sessionId)) sessionIds.unshift(sessionId);
      telegramChatState.set(key, { ...defaults, ...val, sessionId, sessionIds: sessionIds.slice(0, 50) });
    }
  } catch (e) {
    if (DEBUG) console.log("[telegram] load chat state:", e.message);
  }
}

function saveTelegramChatState() {
  try {
    const dir = path.dirname(TELEGRAM_CHAT_STATE_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const obj = Object.fromEntries(telegramChatState.entries());
    fs.writeFileSync(TELEGRAM_CHAT_STATE_PATH, JSON.stringify(obj, null, 2), "utf8");
  } catch (e) {
    if (DEBUG) console.log("[telegram] save chat state:", e.message);
  }
}

function getChatState(chatId) {
  const key = String(chatId);
  if (!telegramChatState.has(key)) {
    telegramChatState.set(key, {
      sessionId: null,
      sessionIds: [],
      geminiSessionId: null,
      model: "auto",
      cli: currentCli,
      voiceReply: false,
    });
    saveTelegramChatState();
  }
  return telegramChatState.get(key);
}

/** Get conversation threads for a Telegram chat, sorted by updatedAt desc (for /convos and /convo). */
function getTelegramChatThreads(chatId, limit = 50) {
  const state = getChatState(chatId);
  const ids = state.sessionIds || [];
  if (state.sessionId && !ids.includes(state.sessionId)) ids.unshift(state.sessionId);
  const byId = new Map();
  const chatIdStr = String(chatId);
  for (const id of ids) {
    const data = loadConversation(id);
    if (!data) continue;
    if (data.telegramChatId !== chatIdStr) {
      data.telegramChatId = chatIdStr;
      try {
        fs.writeFileSync(conversationPath(id), JSON.stringify(data, null, 2), "utf8");
      } catch (e) {
        if (DEBUG) console.log("[conversations] backfill telegramChatId:", e.message);
      }
    }
    const preview = (data.messages?.find((m) => m.role === "user")?.content || "").slice(0, 50);
    byId.set(id, {
      id,
      updatedAt: data.updatedAt || data.startedAt || "",
      messageCount: data.messages?.length || 0,
      preview,
    });
  }
  // Include all conversations from disk that belong to this Telegram chat (so we show full history even if state had only one id)
  const fromDisk = listConversations({ telegramChatId: chatIdStr });
  for (const c of fromDisk) {
    if (c.id && !byId.has(c.id)) {
      byId.set(c.id, {
        id: c.id,
        updatedAt: c.updatedAt || c.startedAt || "",
        messageCount: c.messageCount || 0,
        preview: (c.preview || "").slice(0, 50),
      });
    }
  }
  const threads = Array.from(byId.values());
  threads.sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
  return threads.slice(0, limit);
}

try {
  fs.mkdirSync(CONVERSATIONS_DIR, { recursive: true });
  fs.mkdirSync(OUTPUTS_DIR, { recursive: true });
} catch (e) {
  if (DEBUG) console.log("[conversations/outputs] mkdir:", e.message);
}
loadTelegramChatState();

function getLocalIP() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family === "IPv4" && !iface.internal) return iface.address;
    }
  }
  return "127.0.0.1";
}

function buildPromptContext() {
  const now = new Date();
  const dateTime = now.toLocaleString("en-GB", { timeZone: CONTEXT_TIMEZONE, dateStyle: "full", timeStyle: "short" });
  const iso = now.toISOString();
  const localIP = getLocalIP();
  return `[Context — Server: Date/time ${dateTime} (${iso}). Local IP: ${localIP}. Use this IP when telling the user where to access local servers (e.g. http://${localIP}:${PORT}).]\n\n`;
}

function conversationPath(sessionId) {
  const safe = sessionId.replace(/[^a-zA-Z0-9-_]/g, "_");
  return path.join(CONVERSATIONS_DIR, `${safe}.json`);
}

function loadConversation(sessionId) {
  try {
    const raw = fs.readFileSync(conversationPath(sessionId), "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function saveConversationTurn(sessionId, model, startedAt, userContent, assistantContent, opts = {}) {
  const filePath = conversationPath(sessionId);
  let data = loadConversation(sessionId);
  if (!data) {
    data = { sessionId, model, startedAt, updatedAt: startedAt, messages: [] };
  }
  data.updatedAt = new Date().toISOString();
  data.messages.push({ role: "user", content: userContent });
  data.messages.push({ role: "assistant", content: assistantContent });
  if (opts.telegramChatId != null) data.telegramChatId = String(opts.telegramChatId);
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
  } catch (e) {
    if (DEBUG) console.log("[conversations] write error:", e.message);
  }
}

function listConversations(opts = {}) {
  try {
    const files = fs.readdirSync(CONVERSATIONS_DIR).filter((f) => f.endsWith(".json"));
    const out = [];
    const wantTelegramChatId = opts.telegramChatId != null ? String(opts.telegramChatId) : null;
    for (const f of files) {
      try {
        const raw = fs.readFileSync(path.join(CONVERSATIONS_DIR, f), "utf8");
        const data = JSON.parse(raw);
        if (wantTelegramChatId != null && data.telegramChatId !== wantTelegramChatId) continue;
        const preview = data.messages?.find((m) => m.role === "user")?.content?.slice(0, 80) || "";
        out.push({
          id: data.sessionId,
          model: data.model,
          startedAt: data.startedAt,
          updatedAt: data.updatedAt,
          messageCount: data.messages?.length || 0,
          preview,
        });
      } catch {
        // skip corrupt files
      }
    }
    out.sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
    return out;
  } catch {
    return [];
  }
}

function listSessions() {
  return Array.from(sessions.values()).map((s) => ({
    id: s.id,
    model: s.model,
    startedAt: s.startedAt,
    messageCount: s.messages.length,
    preview: s.messages.find((m) => m.role === "user")?.content?.slice(0, 80) || "",
    active: s.process !== null && !s.process.killed,
  }));
}

// ---------- Scheduled tasks: run a prompt headless (no WebSocket) ----------
function substitutePromptPlaceholders(prompt) {
  if (!prompt || typeof prompt !== "string") return prompt || "";
  const now = new Date();
  const dateStr = now.toLocaleDateString("en-CA", { timeZone: CONTEXT_TIMEZONE }); // YYYY-MM-DD
  return prompt.replace(/\{\{DATE\}\}/g, dateStr);
}

function runAgentHeadless(prompt, opts = {}) {
  const substituted = substitutePromptPlaceholders(prompt);
  const promptWithContext = buildPromptContext() + (substituted || "");
  const profile = CLI_PROFILES[opts.cli || currentCli] || CLI_PROFILES.agent;
  const args = profile.buildArgs(promptWithContext, null, opts.model || "auto", opts.mode, null);

  if (DEBUG) console.log(`[scheduled] spawn (${opts.cli || currentCli}): ${profile.bin} ... "<prompt>" (${(prompt || "").slice(0, 50)}...)`);

  const proc = spawn(profile.bin, args, {
    env: { ...process.env },
    cwd: WORKSPACE,
  });

  let buffer = "";
  let assistantText = "";

  proc.stdout.on("data", (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        if (event.type === "assistant") {
          const text = event.message?.content?.[0]?.text || "";
          if (text && event.timestamp_ms) assistantText += text;
        }
      } catch {
        // ignore parse errors
      }
    }
  });

  proc.on("close", (code) => {
    if (buffer.trim()) {
      try {
        const event = JSON.parse(buffer);
        if (event.type === "assistant") {
          const text = event.message?.content?.[0]?.text || "";
          if (text && event.timestamp_ms) assistantText += text;
        }
      } catch {
        // ignore
      }
    }
    if (DEBUG) console.log(`[scheduled] process exited with code ${code}, output length ${assistantText.length}`);
    if (typeof opts.onDone === "function") opts.onDone(code, assistantText.trim());
  });

  proc.on("error", (err) => {
    if (DEBUG) console.log("[scheduled] spawn error:", err.message);
    if (typeof opts.onDone === "function") opts.onDone(-1, null);
  });

  return proc;
}

// ---------- Scheduled jobs (cron + webhook) ----------

function isPathWithinWorkspace(p) {
  const resolved = path.resolve(p);
  const ws = path.resolve(WORKSPACE);
  return resolved === ws || resolved.startsWith(ws + path.sep);
}

try {
  fs.mkdirSync(path.dirname(SCHEDULED_JOBS_PATH), { recursive: true });
} catch (e) {
  if (DEBUG) console.log("[scheduled] mkdir:", e.message);
}

function loadScheduledJobs() {
  try {
    const raw = fs.readFileSync(SCHEDULED_JOBS_PATH, "utf8");
    const data = JSON.parse(raw);
    return Array.isArray(data.jobs) ? data.jobs : [];
  } catch {
    return [];
  }
}

function saveScheduledJobs(jobs) {
  try {
    fs.writeFileSync(SCHEDULED_JOBS_PATH, JSON.stringify({ jobs }, null, 2), "utf8");
  } catch (e) {
    if (DEBUG) console.log("[scheduled] save error:", e.message);
  }
}

const scheduledCronTasks = new Map();

function startScheduledJobs() {
  const jobs = loadScheduledJobs().filter((j) => j.enabled !== false && j.cron);
  for (const job of jobs) {
    if (scheduledCronTasks.has(job.id)) {
      scheduledCronTasks.get(job.id).stop();
      scheduledCronTasks.delete(job.id);
    }
    try {
      const task = cron.schedule(job.cron, () => {
        if (DEBUG) console.log(`[scheduled] cron firing: ${job.id} (${job.name || job.id})`);
        runAgentHeadless(job.prompt, { model: job.model, onDone: async (code, out) => {
          if (job.logOutput && out && path.isAbsolute(job.logOutput) && isPathWithinWorkspace(job.logOutput)) {
            try {
              fs.appendFileSync(job.logOutput, `\n--- ${new Date().toISOString()} (exit ${code}) ---\n${out}\n`, "utf8");
            } catch (e) {
              if (DEBUG) console.log("[scheduled] log write error:", e.message);
            }
          }
          if (job.telegramReminder && TELEGRAM_REMINDER_CHAT_ID && TELEGRAM_BOT_TOKEN && out && out.trim()) {
            try {
              const title = job.name || job.id;
              await sendTelegramMessage(TELEGRAM_REMINDER_CHAT_ID, `📋 ${title}\n\n${out.trim()}`);
            } catch (e) {
              if (DEBUG) console.log("[scheduled] telegram reminder error:", e.message);
            }
          }
        } });
      }, { scheduled: true, timezone: CONTEXT_TIMEZONE });
      scheduledCronTasks.set(job.id, task);
    } catch (e) {
      if (DEBUG) console.log(`[scheduled] invalid cron for ${job.id}:`, e.message);
    }
  }
}

// ---------- Changelogs (external status updates) ----------
try {
  fs.mkdirSync(CHANGELOGS_DIR, { recursive: true });
} catch (e) {
  if (DEBUG) console.log("[changelogs] mkdir:", e.message);
}

function appendChangelogToDailyLog(dateStr, source, content) {
  const logPath = path.join(WORKSPACE, "memory", "logs", `${dateStr}.md`);
  const block = `**${source}** (${new Date().toISOString()})\n\n${content.trim()}\n\n`;
  try {
    if (fs.existsSync(logPath)) {
      const raw = fs.readFileSync(logPath, "utf8");
      const hasSection = raw.includes("## External updates");
      const toAppend = hasSection ? `\n${block}` : `\n\n## External updates\n\n${block}`;
      fs.appendFileSync(logPath, toAppend, "utf8");
    } else {
      const initial = `# Daily Log: ${dateStr}\n\n> External update\n\n---\n\n## External updates\n\n${block}`;
      fs.writeFileSync(logPath, initial, "utf8");
    }
  } catch (e) {
    if (DEBUG) console.log("[changelogs] append to log error:", e.message);
  }
}

wss.on("connection", (ws) => {
  let currentSession = null;

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    switch (msg.type) {
      case "list-sessions":
        ws.send(JSON.stringify({ type: "sessions", sessions: listSessions() }));
        break;

      case "list-models":
        spawnModels(ws, msg.cli);
        break;

      case "list-agents":
        ws.send(JSON.stringify({
          type: "agents",
          current: currentCli,
          agents: Object.entries(CLI_PROFILES).map(([id, p]) => ({ id, label: p.label })),
        }));
        break;

      case "set-agent":
        if (msg.cli && CLI_PROFILES[msg.cli]) {
          currentCli = msg.cli;
          ws.send(JSON.stringify({ type: "agent-set", cli: currentCli, label: CLI_PROFILES[currentCli].label }));
        }
        break;

      case "prompt":
        currentSession = handlePrompt(ws, msg, currentSession);
        break;

      case "cancel":
        if (currentSession?.process) {
          currentSession.process.kill("SIGTERM");
          ws.send(JSON.stringify({ type: "cancelled" }));
        }
        break;
    }
  });

  ws.on("close", () => {
    // Don't kill the agent process on disconnect — it can be resumed
  });
});

function spawnModels(ws, cli) {
  const profile = CLI_PROFILES[cli || currentCli] || CLI_PROFILES.agent;
  if (!profile.modelsCmd) {
    ws.send(JSON.stringify({ type: "models", models: [], note: `${profile.label} does not support listing models` }));
    return;
  }
  const proc = spawn(profile.bin, profile.modelsCmd, { env: { ...process.env } });
  let out = "";
  proc.stdout.on("data", (d) => (out += d.toString()));
  proc.on("close", () => {
    const models = [];
    for (const line of out.split("\n")) {
      const match = line.match(/^(\S+)\s+-\s+(.+?)(?:\s+\((current|default)\))?$/);
      if (match) {
        models.push({ id: match[1], name: match[2].trim(), tag: match[3] || null });
      }
    }
    ws.send(JSON.stringify({ type: "models", models }));
  });
}

/**
 * One line of stdout from Cursor/Claude stream-json or Gemini stream-json.
 * Returns false if line is not valid JSON (caller may treat as raw text).
 */
function forwardWebAgentStdoutLine(line, session, ws) {
  try {
    const event = JSON.parse(line);

    if (event.type === "init" && event.session_id) {
      if (!session.id) {
        session.id = event.session_id;
        sessions.set(session.id, session);
      }
      ws.send(
        JSON.stringify({
          type: "agent-event",
          event: { type: "system", session_id: event.session_id, model: event.model },
        })
      );
      return true;
    }

    if (event.type === "message" && event.role === "assistant" && typeof event.content === "string") {
      session.assistantTextBuffer += event.content;
      ws.send(
        JSON.stringify({
          type: "agent-event",
          event: {
            type: "assistant",
            message: { content: [{ text: event.content }] },
            timestamp_ms: Date.now(),
          },
        })
      );
      return true;
    }

    if (event.type === "tool_use" && event.tool_id) {
      ws.send(
        JSON.stringify({
          type: "agent-event",
          event: {
            type: "tool_use",
            tool_use_id: event.tool_id,
            tool_name: event.tool_name || "tool",
            tool_input: event.parameters || event.tool_input || {},
          },
        })
      );
      return true;
    }

    if (event.type === "tool_result" && event.tool_id) {
      ws.send(
        JSON.stringify({
          type: "agent-event",
          event: { type: "tool_result", tool_use_id: event.tool_id },
        })
      );
      return true;
    }

    if (event.type === "result" && event.stats) {
      ws.send(
        JSON.stringify({
          type: "agent-event",
          event: {
            type: "result",
            usage: {
              inputTokens: event.stats.input_tokens,
              outputTokens: event.stats.output_tokens,
            },
            duration_ms: event.stats.duration_ms,
          },
        })
      );
      return true;
    }

    if (event.session_id && !session.id) {
      session.id = event.session_id;
      sessions.set(session.id, session);
    }
    if (event.type === "assistant") {
      const text = event.message?.content?.[0]?.text || "";
      if (text && event.timestamp_ms) session.assistantTextBuffer += text;
    }

    if (DEBUG) {
      let preview = "";
      switch (event.type) {
        case "assistant":
          preview = `text=${JSON.stringify((event.message?.content?.[0]?.text || "").slice(0, 60))} ts=${event.timestamp_ms ? "delta" : "final"}`;
          break;
        case "thinking":
          preview = `${event.subtype} text=${JSON.stringify((event.text || "").slice(0, 40))}`;
          break;
        case "tool_use":
          preview = `tool=${event.tool_name || event.name} id=${event.tool_use_id}`;
          break;
        case "tool_result":
          preview = `id=${event.tool_use_id}`;
          break;
        case "result":
          preview = `tokens_in=${event.usage?.inputTokens} tokens_out=${event.usage?.outputTokens}`;
          break;
        default:
          preview = event.subtype || String(event.type || "");
      }
      console.log(`[agent] event: ${event.type} ${preview}`);
    }

    ws.send(JSON.stringify({ type: "agent-event", event }));
    return true;
  } catch {
    return false;
  }
}

function handlePrompt(ws, msg, existingSession) {
  const { prompt, model, sessionId, mode, cli, geminiSessionId } = msg;
  if (!prompt?.trim()) return existingSession;

  const profile = CLI_PROFILES[cli || currentCli] || CLI_PROFILES.agent;
  const promptWithContext = buildPromptContext() + prompt;
  const args = profile.buildArgs(
    promptWithContext,
    sessionId,
    model,
    mode,
    geminiSessionId || null
  );

  if (DEBUG) console.log(`[agent] spawn (${cli || currentCli}): ${profile.bin} ${args.slice(0, -1).join(" ")} "<prompt>"`);

  const proc = spawn(profile.bin, args, {
    env: { ...process.env },
    cwd: WORKSPACE,
  });

  const session = {
    id: null,
    model: model === "auto" || !model ? "auto" : model,
    startedAt: new Date().toISOString(),
    currentPrompt: prompt,
    assistantTextBuffer: "",
    messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
    process: proc,
  };

  let buffer = "";

  proc.stdout.on("data", (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop();

    for (const line of lines) {
      if (!line.trim()) continue;
      if (!forwardWebAgentStdoutLine(line, session, ws)) {
        if (DEBUG) console.log(`[agent] raw: ${line.slice(0, 80)}`);
        ws.send(JSON.stringify({ type: "agent-raw", text: line }));
      }
    }
  });

  proc.stderr.on("data", (chunk) => {
    const text = chunk.toString();
    if (text.trim()) {
      if (DEBUG) console.log(`[agent] stderr: ${text.slice(0, 100)}`);
      ws.send(JSON.stringify({ type: "agent-stderr", text }));
    }
  });

  proc.on("close", (code) => {
    if (DEBUG) console.log(`[agent] process exited with code ${code}`);
    if (buffer.trim()) {
      if (!forwardWebAgentStdoutLine(buffer.trim(), session, ws)) {
        ws.send(JSON.stringify({ type: "agent-raw", text: buffer }));
      }
    }

    if (session.process) session.process = null;
    if (session.id && code === 0 && session.assistantTextBuffer !== undefined) {
      saveConversationTurn(
        session.id,
        session.model,
        session.startedAt,
        session.currentPrompt,
        session.assistantTextBuffer.trim()
      );
    }
    ws.send(JSON.stringify({ type: "agent-done", code, sessionId: session.id }));
  });

  proc.on("error", (err) => {
    ws.send(JSON.stringify({ type: "agent-error", error: err.message }));
  });

  return session;
}

// ---------- API: persisted conversations ----------
app.get("/api/conversations", (req, res) => {
  const live = listSessions();
  const saved = listConversations();
  const byId = new Map(saved.map((c) => [c.id, c]));
  for (const s of live) {
    if (s.id && !byId.has(s.id)) byId.set(s.id, { ...s, updatedAt: s.startedAt });
  }
  const merged = Array.from(byId.values()).sort((a, b) =>
    (b.updatedAt || b.startedAt || "").localeCompare(a.updatedAt || a.startedAt || "")
  );
  res.json({ conversations: merged });
});

app.get("/api/conversations/:id", (req, res) => {
  const data = loadConversation(req.params.id);
  if (!data) return res.status(404).json({ error: "Not found" });
  res.json(data);
});

// ---------- CLI agents API ----------
app.get("/api/agents", (req, res) => {
  res.json({
    current: currentCli,
    agents: Object.entries(CLI_PROFILES).map(([id, p]) => ({ id, label: p.label })),
  });
});

app.post("/api/agents", (req, res) => {
  const { cli } = req.body || {};
  if (!cli || !CLI_PROFILES[cli]) {
    return res.status(400).json({ error: `Unknown agent: "${cli}". Available: ${Object.keys(CLI_PROFILES).join(", ")}` });
  }
  currentCli = cli;
  console.log(`[api] default CLI switched to: ${cli} (${CLI_PROFILES[cli].label})`);
  res.json({ ok: true, current: currentCli, label: CLI_PROFILES[cli].label });
});

// ---------- Scheduled tasks API ----------
app.get("/api/scheduled", (req, res) => {
  const jobs = loadScheduledJobs();
  res.json({
    jobs: jobs.map((j) => ({
      id: j.id,
      name: j.name,
      prompt: j.prompt,
      cron: j.cron || "",
      enabled: j.enabled !== false,
      model: j.model || "auto",
      logOutput: j.logOutput || "",
      webhookSecret: j.webhookSecret ? "***" : "",
      telegramReminder: j.telegramReminder === true,
    })),
  });
});

function handleSaveScheduledJobs(req, res) {
  const { jobs: raw } = req.body || {};
  if (!Array.isArray(raw)) return res.status(400).json({ error: "Missing or invalid 'jobs' array" });
  const existing = loadScheduledJobs();
  const byId = new Map(existing.map((j) => [j.id, j]));
  const jobs = raw.map((j) => {
    const id = (j.id || "").trim().replace(/[^a-zA-Z0-9_-]/g, "_") || "job";
    const prev = byId.get(id);
    const webhookSecret = j.webhookSecret === "***" && prev?.webhookSecret ? prev.webhookSecret : (j.webhookSecret || "");
    return {
      id,
      name: (j.name || id).trim(),
      prompt: (j.prompt || "").trim(),
      cron: (j.cron || "").trim(),
      enabled: j.enabled !== false,
      model: (j.model || "auto").trim(),
      logOutput: (j.logOutput || "").trim(),
      webhookSecret: webhookSecret.trim(),
      telegramReminder: j.telegramReminder === true,
    };
  });
  saveScheduledJobs(jobs);
  startScheduledJobs();
  res.json({ ok: true, jobs: jobs.length });
}

app.put("/api/scheduled", handleSaveScheduledJobs);
app.post("/api/scheduled/save", handleSaveScheduledJobs);

app.post("/api/scheduled/trigger", (req, res) => {
  const { id, secret } = req.body || {};
  const jobs = loadScheduledJobs();
  const job = jobs.find((j) => j.id === id);
  if (!job) return res.status(404).json({ error: "Job not found" });
  const expectedSecret = job.webhookSecret || process.env.SCHEDULED_WEBHOOK_SECRET || "";
  if (expectedSecret && (secret || req.query.secret) !== expectedSecret) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  runAgentHeadless(job.prompt, { model: job.model, onDone: async (code, out) => {
    if (job.logOutput && out && path.isAbsolute(job.logOutput) && isPathWithinWorkspace(job.logOutput)) {
      try {
        fs.appendFileSync(job.logOutput, `\n--- ${new Date().toISOString()} (exit ${code}) ---\n${out}\n`, "utf8");
      } catch (e) {
        if (DEBUG) console.log("[scheduled] log write error:", e.message);
      }
    }
    if (job.telegramReminder && TELEGRAM_REMINDER_CHAT_ID && TELEGRAM_BOT_TOKEN && out && out.trim()) {
      try {
        const title = job.name || job.id;
        await sendTelegramMessage(TELEGRAM_REMINDER_CHAT_ID, `📋 ${title}\n\n${out.trim()}`);
      } catch (e) {
        if (DEBUG) console.log("[scheduled] telegram reminder error:", e.message);
      }
    }
  } });
  res.json({ ok: true, id: job.id, message: "Job triggered" });
});

// ---------- External changelogs API (e.g. other laptop sending daily status) ----------
app.post("/api/changelogs", (req, res) => {
  const hasSecret = getChangelogSecretReq(req) === CHANGELOG_SECRET;
  const hasCookie = isAuthValid(req);
  if (CHANGELOG_SECRET && !hasSecret && !hasCookie) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const { date, source, content } = req.body || {};
  if (!content || typeof content !== "string") {
    return res.status(400).json({ error: "Missing or invalid 'content'" });
  }
  const now = new Date();
  const dateStr = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : now.toISOString().slice(0, 10);
  const sourceLabel = (source && String(source).trim()) || "external";
  const safeSource = sourceLabel.replace(/[^a-zA-Z0-9_-]/g, "_");
  const filePath = path.join(CHANGELOGS_DIR, `${dateStr}-${safeSource}.json`);
  const entry = { date: dateStr, source: sourceLabel, content: content.trim(), receivedAt: now.toISOString() };
  try {
    let list = [];
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, "utf8");
      try {
        list = JSON.parse(raw);
      } catch {
        list = [];
      }
    }
    list.push(entry);
    fs.writeFileSync(filePath, JSON.stringify(list, null, 2), "utf8");
    appendChangelogToDailyLog(dateStr, sourceLabel, content.trim());
  } catch (e) {
    if (DEBUG) console.log("[changelogs] write error:", e.message);
    return res.status(500).json({ error: "Failed to save changelog" });
  }
  res.status(201).json({ ok: true, date: dateStr, source: sourceLabel });
});

app.get("/api/changelogs", (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 30, 100);
  try {
    const files = fs.readdirSync(CHANGELOGS_DIR).filter((f) => f.endsWith(".json"));
    const entries = [];
    for (const f of files.sort().reverse().slice(0, limit * 2)) {
      const raw = fs.readFileSync(path.join(CHANGELOGS_DIR, f), "utf8");
      try {
        const list = JSON.parse(raw);
        for (const e of list) entries.push(e);
      } catch {
        // skip
      }
    }
    entries.sort((a, b) => (b.receivedAt || "").localeCompare(a.receivedAt || ""));
    res.json({ changelogs: entries.slice(0, limit) });
  } catch (e) {
    if (DEBUG) console.log("[changelogs] list error:", e.message);
    res.json({ changelogs: [] });
  }
});

// ---------- Outputs: save HTML (or markdown) reports for viewing / sharing (e.g. send link via Telegram) ----------
function outputMetaPath(id) {
  return path.join(OUTPUTS_DIR, `${id}.meta.json`);
}
function outputHtmlPath(id) {
  return path.join(OUTPUTS_DIR, `${id}.html`);
}
function safeOutputId(s) {
  return s.replace(/[^a-zA-Z0-9_-]/g, "-").replace(/-+/g, "-").slice(0, 120) || "output";
}

app.post("/api/outputs", (req, res) => {
  const { title, html, markdown } = req.body || {};
  const rawTitle = (title && String(title).trim()) || "Report";
  const id = safeOutputId(rawTitle) + "-" + Date.now();
  let htmlContent = html && String(html).trim();
  if (!htmlContent && markdown && String(markdown).trim()) {
    try {
      htmlContent = marked.parse(markdown.trim(), { async: false });
    } catch (e) {
      return res.status(400).json({ error: "Markdown parse error" });
    }
  }
  if (!htmlContent) return res.status(400).json({ error: "Missing 'html' or 'markdown'" });
  const fullHtml = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${rawTitle.replace(/</g, "&lt;")}</title><style>body{font-family:system-ui,sans-serif;background:#1a1a2e;color:#e0e0e0;margin:0;padding:16px;max-width:900px;margin:0 auto;line-height:1.6;} a{color:#64ffda;} table{border-collapse:collapse;width:100%;} th,td{border:1px solid #2a2a4a;padding:8px 12px;text-align:left;} th{background:#16213e;} pre{background:#0f1729;padding:12px;border-radius:8px;overflow-x:auto;} code{background:#0f1729;padding:2px 6px;border-radius:4px;}</style></head><body>${htmlContent}</body></html>`;
  try {
    fs.writeFileSync(outputHtmlPath(id), fullHtml, "utf8");
    const meta = { id, title: rawTitle, createdAt: new Date().toISOString() };
    fs.writeFileSync(outputMetaPath(id), JSON.stringify(meta, null, 2), "utf8");
  } catch (e) {
    if (DEBUG) console.log("[outputs] write error:", e.message);
    return res.status(500).json({ error: "Failed to save output" });
  }
  const baseUrl = `${req.protocol}://${req.get("host") || `localhost:${PORT}`}`;
  res.status(201).json({ id, title: rawTitle, url: `${baseUrl}/output/${id}` });
});

app.get("/api/outputs", (req, res) => {
  try {
    const files = fs.readdirSync(OUTPUTS_DIR).filter((f) => f.endsWith(".meta.json"));
    const outputs = [];
    for (const f of files) {
      const id = f.replace(/\.meta\.json$/, "");
      try {
        const raw = fs.readFileSync(outputMetaPath(id), "utf8");
        const meta = JSON.parse(raw);
        outputs.push({ id: meta.id || id, title: meta.title || id, createdAt: meta.createdAt, url: `/output/${id}` });
      } catch {
        outputs.push({ id, title: id, createdAt: null, url: `/output/${id}` });
      }
    }
    outputs.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
    res.json({ outputs });
  } catch (e) {
    if (DEBUG) console.log("[outputs] list error:", e.message);
    res.json({ outputs: [] });
  }
});

app.get("/output/:id", (req, res) => {
  // Preserve multiple dashes so stored ids like "Title--timestamp" resolve (safeOutputId collapses "--" to "-")
  const id = (req.params.id || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 150);
  if (!id) return res.status(400).send("Invalid id");
  const htmlPath = outputHtmlPath(id);
  if (!fs.existsSync(htmlPath)) return res.status(404).send("Output not found");
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Content-Security-Policy", "script-src 'none'; frame-ancestors 'self'");
  res.send(fs.readFileSync(htmlPath, "utf8"));
});

// ---------- Assets: list outputs + report files (e.g. .tmp) for browsing / opening ----------
app.get("/api/assets", (req, res) => {
  const outputs = [];
  const reports = [];
  try {
    const outFiles = fs.readdirSync(OUTPUTS_DIR).filter((f) => f.endsWith(".meta.json"));
    for (const f of outFiles) {
      const id = f.replace(/\.meta\.json$/, "");
      try {
        const raw = fs.readFileSync(outputMetaPath(id), "utf8");
        const meta = JSON.parse(raw);
        outputs.push({ id: meta.id || id, title: meta.title || id, createdAt: meta.createdAt, url: `/output/${id}` });
      } catch {
        outputs.push({ id, title: id, createdAt: null, url: `/output/${id}` });
      }
    }
    outputs.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
  } catch {
    // ignore
  }
  try {
    if (fs.existsSync(REPORTS_DIR)) {
      const names = fs.readdirSync(REPORTS_DIR).filter((f) => {
        const p = path.join(REPORTS_DIR, f);
        return fs.statSync(p).isFile() && !f.startsWith(".");
      });
      for (const name of names.sort()) {
        reports.push({ name, url: `/reports/${encodeURIComponent(name)}` });
      }
    }
  } catch {
    // ignore
  }
  res.json({ outputs, reports });
});

app.get("/reports/:filename", (req, res) => {
  const raw = req.params.filename;
  const name = path.basename(raw);
  if (!name || name !== raw) return res.status(400).send("Invalid filename");
  const filePath = path.join(REPORTS_DIR, name);
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return res.status(404).send("Not found");
  const ext = path.extname(name).toLowerCase();
  const ct = ext === ".html" ? "text/html" : ext === ".md" ? "text/markdown" : "application/octet-stream";
  res.setHeader("Content-Type", ct);
  res.send(fs.readFileSync(filePath, "utf8"));
});

// ---------- .env editor (read/write the project .env file from the web UI) ----------
const ENV_FILE_PATH = path.join(WORKSPACE, ".env");
const ENV_EXAMPLE_PATH = path.join(WORKSPACE, ".env.example");

function parseEnvFile(content) {
  const lines = content.split("\n");
  const entries = [];
  for (const line of lines) {
    const trimmed = line.trimEnd();
    if (trimmed === "" || trimmed.startsWith("#")) {
      entries.push({ type: "comment", raw: trimmed });
    } else {
      const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)/);
      if (match) {
        entries.push({ type: "var", key: match[1], value: match[2], raw: trimmed });
      } else {
        entries.push({ type: "comment", raw: trimmed });
      }
    }
  }
  return entries;
}

function entriesToEnvString(entries) {
  return entries.map((e) => e.raw).join("\n");
}

app.get("/api/env", (req, res) => {
  try {
    const content = fs.existsSync(ENV_FILE_PATH) ? fs.readFileSync(ENV_FILE_PATH, "utf8") : "";
    const exampleContent = fs.existsSync(ENV_EXAMPLE_PATH) ? fs.readFileSync(ENV_EXAMPLE_PATH, "utf8") : "";
    const entries = parseEnvFile(content);
    const vars = entries.filter((e) => e.type === "var").map((e) => ({ key: e.key, value: e.value }));
    const exampleEntries = parseEnvFile(exampleContent);
    const exampleVars = exampleEntries.filter((e) => e.type === "var").map((e) => ({ key: e.key, value: e.value }));
    res.json({ vars, exampleVars, raw: content });
  } catch (e) {
    if (DEBUG) console.log("[env] read error:", e.message);
    res.status(500).json({ error: "Failed to read .env file" });
  }
});

app.put("/api/env", (req, res) => {
  const { raw } = req.body || {};
  if (typeof raw !== "string") return res.status(400).json({ error: "Missing 'raw' string (full .env content)" });
  if (raw.length > 100_000) return res.status(400).json({ error: ".env content too large (max 100KB)" });
  try {
    const backup = ENV_FILE_PATH + ".bak";
    if (fs.existsSync(ENV_FILE_PATH)) {
      fs.copyFileSync(ENV_FILE_PATH, backup);
    }
    fs.writeFileSync(ENV_FILE_PATH, raw, "utf8");
    if (DEBUG) console.log(`[env] .env updated (${raw.length} chars), backup at .env.bak`);
    res.json({ ok: true, note: "Changes saved. Restart the server for env var changes to take effect." });
  } catch (e) {
    if (DEBUG) console.log("[env] write error:", e.message);
    res.status(500).json({ error: "Failed to write .env file: " + e.message });
  }
});

// ---------- STT/TTS scripts (voice notes + reply-with-audio) ----------
const TTS_SCRIPT = path.join(WORKSPACE, ".claude", "skills", "telegram", "scripts", "audio_stt_tts.py");
const PYTHON_BIN = (() => {
  const venvPy = path.join(__dirname, ".venv", "bin", "python3");
  if (fs.existsSync(venvPy)) return venvPy;
  return "python3";
})();
app.post("/api/tts", (req, res) => {
  if (!req.body || typeof req.body.text !== "string") {
    return res.status(400).json({ error: "Missing or invalid body: { text: string }" });
  }
  const raw = String(req.body.text).slice(0, 4096).trim();
  if (!raw) return res.status(400).json({ error: "Text is empty" });
  const tmpDir = os.tmpdir();
  const outPath = path.join(tmpDir, `tts_${Date.now()}_${Math.random().toString(36).slice(2)}.mp3`);
  if (!fs.existsSync(TTS_SCRIPT)) {
    return res.status(503).json({ error: "TTS script not found. Set OPENAI_API_KEY in .env for TTS." });
  }
  const ttsArgs = [TTS_SCRIPT, "tts", raw, "--output", outPath];
  if (req.body.voice) ttsArgs.push("--voice", String(req.body.voice));
  if (req.body.speed) ttsArgs.push("--speed", String(req.body.speed));
  if (req.body.language) ttsArgs.push("--language", String(req.body.language));
  const proc = spawn(PYTHON_BIN, ttsArgs, {
    cwd: path.dirname(TTS_SCRIPT),
    env: { ...process.env, PYTHONPATH: path.dirname(TTS_SCRIPT) },
  });
  let stderr = "";
  proc.stderr && proc.stderr.on("data", (d) => { stderr += d; });
  proc.on("close", (code) => {
    if (code !== 0) {
      try { fs.unlinkSync(outPath); } catch (e) {}
      return res.status(500).json({ error: "TTS failed", detail: stderr.slice(0, 200) });
    }
    if (!fs.existsSync(outPath)) {
      return res.status(500).json({ error: "TTS produced no file" });
    }
    res.setHeader("Content-Type", "audio/mpeg");
    res.sendFile(outPath, (err) => {
      try { fs.unlinkSync(outPath); } catch (e) {}
      if (err && !res.headersSent) res.status(500).json({ error: "Failed to send audio" });
    });
  });
  proc.on("error", (err) => {
    try { fs.unlinkSync(outPath); } catch (e) {}
    res.status(500).json({ error: "TTS failed to start", detail: String(err.message) });
  });
});

// ---------- OpenAPI (Swagger) spec for changelogs and scheduled APIs ----------
app.get("/api/openapi.json", (req, res) => {
  const baseUrl = `${req.protocol}://${req.get("host") || `localhost:${PORT}`}`;
  const spec = {
    openapi: "3.0.3",
    info: {
      title: "Agent Web API",
      description: "Changelogs and scheduled tasks APIs for Agent Web UI. Use these endpoints to push external status updates (e.g. from another laptop) or trigger scheduled jobs.",
      version: "1.0.0",
    },
    servers: [{ url: baseUrl, description: "This server" }],
    paths: {
      "/api/changelogs": {
        get: {
          summary: "List changelogs",
          description: "Returns recent changelog entries. Requires same auth as web UI (cookie) if password is set.",
          operationId: "listChangelogs",
          parameters: [
            { name: "limit", in: "query", description: "Max entries to return (default 30, max 100)", schema: { type: "integer", minimum: 1, maximum: 100, default: 30 } },
          ],
          responses: {
            "200": {
              description: "List of changelogs",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      changelogs: {
                        type: "array",
                        items: {
                          type: "object",
                          properties: {
                            date: { type: "string", example: "2026-03-05" },
                            source: { type: "string", example: "laptop-other" },
                            content: { type: "string" },
                            receivedAt: { type: "string", format: "date-time" },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        post: {
          summary: "Add changelog entry",
          description: "Add a status update. Auth: set Authorization: Bearer <CHANGELOG_SECRET> or X-Changelog-Secret header (when CHANGELOG_SECRET is set), or use web UI cookie.",
          operationId: "createChangelog",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["content"],
                  properties: {
                    content: { type: "string", description: "Status / changelog text" },
                    date: { type: "string", format: "date", description: "Optional YYYY-MM-DD (default: today)" },
                    source: { type: "string", description: "Optional label for the sender (default: external)" },
                  },
                },
              },
            },
          },
          responses: {
            "201": {
              description: "Created",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: { ok: { type: "boolean" }, date: { type: "string" }, source: { type: "string" } },
                  },
                },
              },
            },
            "400": { description: "Missing or invalid content" },
            "401": { description: "Unauthorized" },
          },
        },
      },
      "/api/scheduled": {
        get: {
          summary: "List scheduled jobs",
          description: "Returns scheduled job definitions (cron, prompt, etc.). Webhook secrets are redacted.",
          operationId: "listScheduled",
          responses: {
            "200": {
              description: "List of jobs",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      jobs: {
                        type: "array",
                        items: {
                          type: "object",
                          properties: {
                            id: { type: "string" },
                            name: { type: "string" },
                            prompt: { type: "string" },
                            cron: { type: "string" },
                            enabled: { type: "boolean" },
                            model: { type: "string" },
                            webhookSecret: { type: "string", description: "*** when set" },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
      "/api/scheduled/trigger": {
        post: {
          summary: "Trigger a scheduled job",
          description: "Run a job by id. Send secret if the job has webhookSecret or SCHEDULED_WEBHOOK_SECRET is set.",
          operationId: "triggerScheduled",
          requestBody: {
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    id: { type: "string", description: "Job id" },
                    secret: { type: "string", description: "Webhook secret if required" },
                  },
                },
              },
            },
          },
          responses: {
            "200": { description: "Job triggered" },
            "401": { description: "Unauthorized" },
            "404": { description: "Job not found" },
          },
        },
      },
    },
  };
  res.setHeader("Content-Type", "application/json");
  res.send(JSON.stringify(spec, null, 2));
});

// ---------- Telegram bridge (mirrors web UI: same agent, reply via Telegram) ----------

async function telegramApi(method, body = {}, opts = {}) {
  if (!TELEGRAM_BOT_TOKEN) return { ok: false };
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`;

  const telegramTimeoutSec = body.timeout || 0;
  const fetchTimeoutMs =
    telegramTimeoutSec > 0 ? (telegramTimeoutSec + 5) * 1000 : 15000;

  const timeoutSignal = AbortSignal.timeout(fetchTimeoutMs);
  const signal = opts.signal
    ? AbortSignal.any([opts.signal, timeoutSignal])
    : timeoutSignal;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });

    return await res.json();
  } catch (err) {
    if (err.name === "AbortError" && opts.signal?.aborted) {
      if (DEBUG) console.log("[telegram] request aborted (shutdown)");
      throw err;
    }
    const cause = err.cause ? ` (${err.cause.code || err.cause.message || err.cause})` : "";
    if (DEBUG) console.log("[telegram] api error:", err.name, err.message, cause);
    throw err;
  }
}

/**
 * Convert markdown to Telegram HTML so messages render nicely in the app
 * instead of showing raw markdown. Uses Telegram's parse_mode: "HTML" tags.
 */
function markdownToTelegramHtml(text) {
  if (!text || typeof text !== "string") return text;
  function esc(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  // Tokenize: extract code blocks and inline code first (they shouldn't be processed for formatting)
  const tokens = [];
  let remaining = text;

  // Extract fenced code blocks
  remaining = remaining.replace(/```(\w*)\n?([\s\S]*?)```/g, (match, _lang, code) => {
    const placeholder = `\x00CODE${tokens.length}\x00`;
    tokens.push("<pre>" + esc(code.trim()) + "</pre>");
    return placeholder;
  });

  // Extract inline code
  remaining = remaining.replace(/`([^`]+)`/g, (match, code) => {
    const placeholder = `\x00CODE${tokens.length}\x00`;
    tokens.push("<code>" + esc(code) + "</code>");
    return placeholder;
  });

  // Escape HTML entities in the remaining text
  remaining = esc(remaining);

  // Bold: **text** or __text__ (allow multiline content)
  remaining = remaining.replace(/\*\*([\s\S]*?)\*\*/g, (_, x) => "<b>" + x + "</b>");
  remaining = remaining.replace(/__([\s\S]*?)__/g, (_, x) => "<b>" + x + "</b>");

  // Italic: *text* or _text_ (single, non-greedy, no nesting issues since bold is already replaced)
  remaining = remaining.replace(/(?<!\*)\*((?!\s)[^*]+(?<!\s))\*(?!\*)/g, (_, x) => "<i>" + x + "</i>");
  remaining = remaining.replace(/(?<!_)_((?!\s)[^_]+(?<!\s))_(?!_)/g, (_, x) => "<i>" + x + "</i>");

  // Links: [text](url) — entities are already escaped so match escaped versions
  remaining = remaining.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    (_, t, u) => '<a href="' + u + '">' + t + "</a>"
  );

  // Restore code/pre tokens
  remaining = remaining.replace(/\x00CODE(\d+)\x00/g, (_, idx) => tokens[parseInt(idx, 10)]);

  return remaining;
}

/** Download a file from Telegram by file_id; returns path to temp file or null. */
async function downloadTelegramFile(fileId) {
  const res = await telegramApi("getFile", { file_id: fileId });
  if (!res.ok || !res.result?.file_path) return null;
  const filePath = res.result.file_path;
  const url = `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${filePath}`;
  const resp = await fetch(url);
  if (!resp.ok) return null;
  const tmpPath = path.join(os.tmpdir(), `tg_voice_${Date.now()}_${Math.random().toString(36).slice(2)}${path.extname(filePath) || ".oga"}`);
  const buf = Buffer.from(await resp.arrayBuffer());
  fs.writeFileSync(tmpPath, buf);
  return tmpPath;
}

/** Transcribe audio file to text using Python STT script. Returns trimmed text or empty string. */
function transcribeVoiceNote(audioPath) {
  return new Promise((resolve) => {
    if (!fs.existsSync(TTS_SCRIPT)) {
      console.log("[telegram] STT: script not found at", TTS_SCRIPT);
      resolve("");
      return;
    }
    console.log(`[telegram] STT: transcribing ${audioPath} (${fs.statSync(audioPath).size} bytes)`);
    const proc = spawn(PYTHON_BIN, [TTS_SCRIPT, "transcribe", audioPath], {
      cwd: path.dirname(TTS_SCRIPT),
      env: { ...process.env, PYTHONPATH: path.dirname(TTS_SCRIPT) },
    });
    let out = "";
    let stderr = "";
    proc.stdout && proc.stdout.on("data", (d) => { out += d.toString(); });
    proc.stderr && proc.stderr.on("data", (d) => { stderr += d.toString(); });
    proc.on("close", (code) => {
      try { fs.unlinkSync(audioPath); } catch (e) {}
      const text = code === 0 ? String(out).trim() : "";
      if (code !== 0 || !text) {
        console.log(`[telegram] STT: exit ${code}, stderr: ${stderr.slice(0, 300)}`);
      }
      resolve(text);
    });
    proc.on("error", (err) => {
      console.log(`[telegram] STT: spawn error: ${err.message}`);
      try { fs.unlinkSync(audioPath); } catch (e) {}
      resolve("");
    });
  });
}

/** Send a voice message (MP3/OGG) to Telegram. */
async function sendTelegramVoice(chatId, audioPath) {
  if (!TELEGRAM_BOT_TOKEN || !fs.existsSync(audioPath)) return;
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendVoice`;
  const body = fs.readFileSync(audioPath);
  const form = new FormData();
  form.append("chat_id", String(chatId));
  form.append("voice", new Blob([body], { type: "audio/mpeg" }), path.basename(audioPath));
  try {
    const res = await fetch(url, { method: "POST", body: form });
    const data = await res.json();
    if (!data.ok && DEBUG) console.log("[telegram] sendVoice error:", data.description);
  } catch (e) {
    if (DEBUG) console.log("[telegram] sendVoice fetch error:", e.message);
  }
}
async function sendTelegramMessage(chatId, text, opts = {}) {
  const useHtml = opts.parse_mode !== "Markdown" && opts.parse_mode !== "MarkdownV2";
  const htmlBody = useHtml ? markdownToTelegramHtml(text) : text;
  const parseMode = useHtml ? "HTML" : (opts.parse_mode || "");

  const makeChunks = (body) => {
    const chunks = [];
    for (let i = 0; i < body.length; i += TELEGRAM_MAX_MESSAGE_LENGTH) {
      chunks.push(body.slice(i, i + TELEGRAM_MAX_MESSAGE_LENGTH));
    }
    return chunks.length ? chunks : ["(no output)"];
  };

  const chunks = makeChunks(htmlBody);
  for (let i = 0; i < chunks.length; i++) {
    const result = await telegramApi("sendMessage", {
      chat_id: chatId,
      text: chunks[i],
      parse_mode: parseMode,
      disable_web_page_preview: true,
      ...opts,
    });
    if (!result.ok) {
      if (result.error_code === 400 && result.description?.includes("parse entities")) {
        if (DEBUG) console.log("[telegram] HTML parse failed, falling back to plain text");
        const plainChunks = makeChunks(text);
        for (let j = i; j < plainChunks.length; j++) {
          const retry = await telegramApi("sendMessage", {
            chat_id: chatId,
            text: plainChunks[j],
            disable_web_page_preview: true,
          });
          if (!retry.ok && DEBUG) console.log("[telegram] sendMessage error (plain):", retry);
        }
        return;
      }
      if (DEBUG) console.log("[telegram] sendMessage error:", result);
    }
  }
}

function runAgentForTelegram(chatId, prompt, replyToMessageId) {
  const state = getChatState(chatId);
  const profile = CLI_PROFILES[state.cli] || CLI_PROFILES[currentCli] || CLI_PROFILES.agent;
  const promptWithContext = buildPromptContext() + prompt;
  const gemSid = state.cli === "gemini" ? state.geminiSessionId || null : null;
  const args = profile.buildArgs(promptWithContext, state.sessionId, state.model, undefined, gemSid);

  if (DEBUG) console.log(`[telegram] spawn ${state.cli} for chat ${chatId}: ${profile.bin} ${args.slice(0, -1).join(" ")} "<prompt>"`);

  const proc = spawn(profile.bin, args, {
    env: { ...process.env },
    cwd: WORKSPACE,
  });

  const session = {
    id: null,
    startedAt: new Date().toISOString(),
    messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
    process: proc,
  };

  let buffer = "";
  let assistantText = "";
  let lastSentIndex = 0; // for incremental paragraph updates to Telegram
  let lastSentContent = ""; // suppress duplicate sends (exact same message twice)
  const stderrChunks = [];
  const rawStdoutLines = [];
  const sentToolUseIds = new Set(); // avoid sending "🔧 Using X..." twice per tool

  async function sendStreamChunk(chunkText) {
    const trimmed = chunkText && chunkText.trim();
    if (!trimmed) return;
    if (trimmed === lastSentContent) return; // suppress duplicate
    lastSentContent = trimmed;
    try {
      await sendTelegramMessage(chatId, trimmed);
    } catch (e) {
      if (DEBUG) console.log("[telegram] stream chunk send error:", e.message);
    }
  }

  proc.stderr.on("data", (chunk) => {
    const text = chunk.toString();
    stderrChunks.push(text);
    if (DEBUG && text.trim()) console.log("[telegram] agent stderr:", text.slice(0, 200));
  });

  proc.stdout.on("data", (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);

        if (event.type === "init" && event.session_id) {
          session.id = event.session_id;
          if (state.cli === "gemini") {
            state.geminiSessionId = event.session_id;
            saveTelegramChatState();
          }
        } else if (event.session_id && !session.id) {
          session.id = event.session_id;
          sessions.set(session.id, session);
          state.sessionId = session.id;
          if (!state.sessionIds) state.sessionIds = [];
          state.sessionIds = [session.id, ...state.sessionIds.filter((id) => id !== session.id)].slice(0, 50);
          saveTelegramChatState();
        }

        if (event.type === "message" && event.role === "assistant" && typeof event.content === "string") {
          assistantText += event.content;
          let idx;
          while ((idx = assistantText.indexOf("\n\n", lastSentIndex)) !== -1) {
            const paragraph = assistantText.slice(lastSentIndex, idx + 2).trim();
            lastSentIndex = idx + 2;
            if (paragraph) sendStreamChunk(paragraph);
          }
        } else if (event.type === "tool_use") {
          const id =
            event.tool_use_id ||
            event.tool_id ||
            event.id ||
            `${event.tool_name || event.name || "tool"}-${event.timestamp_ms || Date.now()}`;
          if (!sentToolUseIds.has(id)) {
            sentToolUseIds.add(id);
            const name = event.tool_name || event.name || "tool";
            sendStreamChunk(`🔧 Using ${name}...`);
          }
        } else if (event.type === "assistant") {
          let text = event.message?.content?.[0]?.text || "";
          if (text && event.timestamp_ms) {
            if (assistantText.length > 0 && text.startsWith(assistantText)) {
              text = text.slice(assistantText.length);
            }
            assistantText += text;
            let idx;
            while ((idx = assistantText.indexOf("\n\n", lastSentIndex)) !== -1) {
              const paragraph = assistantText.slice(lastSentIndex, idx + 2).trim();
              lastSentIndex = idx + 2;
              if (paragraph) sendStreamChunk(paragraph);
            }
          }
        }
      } catch {
        rawStdoutLines.push(line);
        if (DEBUG) console.log("[telegram] agent raw stdout:", line.slice(0, 150));
      }
    }
  });

  proc.on("close", async (code) => {
    if (buffer.trim()) {
      try {
        const event = JSON.parse(buffer.trim());
        if (event.type === "init" && event.session_id && state.cli === "gemini") {
          state.geminiSessionId = event.session_id;
          saveTelegramChatState();
        }
        if (event.type === "message" && event.role === "assistant" && typeof event.content === "string") {
          assistantText += event.content;
        } else if (event.type === "assistant") {
          const text = event.message?.content?.[0]?.text || "";
          if (text && event.timestamp_ms) assistantText += text;
        }
      } catch {
        rawStdoutLines.push(buffer.trim());
      }
    }
    if (session.process) session.process = null;

    const elapsed = Date.now() - session.messages[0].timestamp;
    console.log(`[telegram] agent exited (code ${code}) for chat ${chatId} after ${(elapsed / 1000).toFixed(1)}s — output: ${assistantText.length} chars`);

    // Only send the unsent remainder (we already sent paragraphs during stream); avoid sending full message again
    const unsentTail = assistantText.slice(lastSentIndex).trim();
    let toSend = unsentTail;

    if (!assistantText.trim()) {
      const rawText = rawStdoutLines.join("\n").trim();
      if (code !== 0) {
        toSend = "";
        const stderrText = stderrChunks.join("").trim();
        console.log(`[telegram] agent error — stderr: ${stderrText.slice(0, 500) || "(empty)"}`);
        console.log(`[telegram] agent error — raw stdout: ${rawText.slice(0, 500) || "(empty)"}`);
        const errParts = [
          `The agent exited (code ${code}).`,
          stderrText && `\nStderr:\n${stderrText.slice(0, 2000)}`,
          rawText && `\nOutput:\n${rawText.slice(0, 2000)}`,
        ].filter(Boolean);
        toSend = errParts.length > 1 ? errParts.join("") : `The agent exited with code ${code}. (No stderr or raw output captured.)`;
      } else if (rawText) {
        toSend = rawText;
        console.log(`[telegram] using raw stdout as reply for chat ${chatId} (${rawText.length} chars)`);
      } else {
        console.log(`[telegram] agent returned no text (exit 0) for chat ${chatId}`);
        toSend = "No reply generated.";
      }
    } else if (unsentTail && unsentTail !== lastSentContent) {
      const preview = toSend.length > 200 ? toSend.slice(0, 200) + "…" : toSend;
      console.log(`[telegram] sending unsent tail to chat ${chatId}: "${preview}"`);
    }
    // If we already sent everything during stream (unsentTail empty and we had content), skip final send

    let sent = false;
    if (toSend.length > 0) {
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          await sendTelegramMessage(chatId, toSend);
          console.log(`[telegram] sent response to chat ${chatId} (${toSend.length} chars, attempt ${attempt})`);
          sent = true;
          break;
        } catch (err) {
          const cause = err.cause ? ` — ${err.cause.code || err.cause.message}` : "";
          console.log(`[telegram] send failed (attempt ${attempt}/3): ${err.message}${cause}`);
          if (attempt < 3) {
            await new Promise((r) => setTimeout(r, 2000 * attempt));
          } else {
            console.log(`[telegram] DROPPED response for chat ${chatId} after 3 attempts — response was: "${toSend.slice(0, 500)}"`);
          }
        }
      }
    } else if (assistantText.trim()) {
      sent = true; // already sent in full via stream chunks
    }

    if (replyToMessageId) {
      telegramApi("setMessageReaction", {
        chat_id: chatId,
        message_id: replyToMessageId,
        reaction: [{ type: "emoji", emoji: sent ? "✅" : "❌" }],
      }).catch(() => {});
    }

    // If user has reply-with-audio on, send TTS version
    const fullResponseText = assistantText.trim();
    const currentState = getChatState(chatId);
    if (code === 0 && fullResponseText && currentState.voiceReply && fs.existsSync(TTS_SCRIPT)) {
      const ttsPath = path.join(os.tmpdir(), `tg_tts_${chatId}_${Date.now()}.mp3`);
      console.log(`[telegram] TTS: generating voice reply for chat ${chatId} (${fullResponseText.length} chars)`);
      let ttsStderr = "";
      const proc = spawn(PYTHON_BIN, [TTS_SCRIPT, "tts", fullResponseText.slice(0, 4096), "--output", ttsPath], {
        cwd: path.dirname(TTS_SCRIPT),
        env: { ...process.env, PYTHONPATH: path.dirname(TTS_SCRIPT) },
      });
      proc.stderr.on("data", (d) => { ttsStderr += d; });
      proc.on("close", (ttsCode) => {
        if (ttsCode === 0 && fs.existsSync(ttsPath)) {
          console.log(`[telegram] TTS: generated ${fs.statSync(ttsPath).size} bytes, sending voice to chat ${chatId}`);
          sendTelegramVoice(chatId, ttsPath).then(() => {
            console.log(`[telegram] TTS: voice sent to chat ${chatId}`);
          }).catch((err) => {
            console.log(`[telegram] TTS: send voice failed for chat ${chatId}: ${err.message}`);
          }).finally(() => {
            try { fs.unlinkSync(ttsPath); } catch (e) {}
          });
        } else {
          console.log(`[telegram] TTS: script exited ${ttsCode} for chat ${chatId}${ttsStderr ? " — " + ttsStderr.slice(0, 200) : ""}`);
          try { fs.unlinkSync(ttsPath); } catch (e) {}
        }
      });
      proc.on("error", (err) => {
        console.log(`[telegram] TTS: spawn error for chat ${chatId}: ${err.message}`);
        try { fs.unlinkSync(ttsPath); } catch (e) {}
      });
    }

    if (session.id && assistantText.trim()) {
      saveConversationTurn(session.id, "auto", session.startedAt, prompt, assistantText.trim(), { telegramChatId: chatId });
    }
  });

  proc.on("error", async (err) => {
    console.log(`[telegram] agent spawn error for chat ${chatId}: ${err.message}`);
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await sendTelegramMessage(chatId, `Error: ${err.message}`);
        break;
      } catch (sendErr) {
        console.log(`[telegram] send error (spawn, attempt ${attempt}/3): ${sendErr.message}`);
        if (attempt < 3) await new Promise((r) => setTimeout(r, 2000 * attempt));
      }
    }
  });
}

async function pollTelegram() {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_ENABLED || telegramPolling) return;
  telegramPolling = true;

  // Reset Telegram's polling state so stale connections from previous runs are dropped
  try {
    const wh = await telegramApi("deleteWebhook", { drop_pending_updates: false });
    if (DEBUG) console.log("[telegram] deleteWebhook:", wh.ok ? "ok" : wh.description || "failed");
  } catch (err) {
    if (DEBUG) console.log("[telegram] deleteWebhook error (non-fatal):", err.message);
  }

  // Register bot commands so they appear as autocomplete suggestions in Telegram
  try {
    const cmds = await telegramApi("setMyCommands", {
      commands: [
        { command: "new", description: "Start a fresh conversation" },
        { command: "convos", description: "List recent conversations" },
        { command: "convo", description: "Switch to conversation (e.g. /convo 1)" },
        { command: "model", description: "Set model (e.g. /model sonnet)" },
        { command: "agent", description: "Switch CLI agent (e.g. /agent claude)" },
        { command: "voice", description: "Toggle reply with audio (TTS)" },
        { command: "graham", description: "Same as /voice — TTS replies" },
        { command: "status", description: "Show current settings" },
        { command: "help", description: "Show available commands" },
      ],
    });
    if (DEBUG) console.log("[telegram] setMyCommands:", cmds.ok ? "ok" : cmds.description || "failed");
  } catch (err) {
    if (DEBUG) console.log("[telegram] setMyCommands error (non-fatal):", err.message);
  }

  let consecutiveErrors = 0;

  const poll = async () => {
    telegramPollAbort = new AbortController();
    try {
      const result = await telegramApi("getUpdates", {
        offset: telegramOffset,
        timeout: 30,
        allowed_updates: ["message"],
      }, { signal: telegramPollAbort.signal });

      if (!result.ok) {
        consecutiveErrors++;
        const delay = Math.min(1000 * Math.pow(2, consecutiveErrors), 30000);
        if (DEBUG) console.log(`[telegram] getUpdates not ok: ${result.description || "unknown"}, retry in ${delay}ms`);
        setTimeout(poll, delay);
        return;
      }

      consecutiveErrors = 0;
      const updates = result.result || [];
      if (updates.length > 0) {
        console.log(`[telegram] received ${updates.length} update(s) (offset ${telegramOffset})`);
      }
      for (const u of updates) {
        telegramOffset = u.update_id + 1;
        const msg = u.message;
        const chatId = msg?.chat?.id;
        const userId = msg?.from?.id;
        const username = msg?.from?.username || msg?.from?.first_name || "unknown";

        if (!msg) {
          console.log(`[telegram] update ${u.update_id}: no message object (edited_message, callback_query, etc.) — skipped`);
          continue;
        }

        const msgType = msg.text ? "text" : msg.photo ? "photo" : msg.document ? "document"
          : msg.voice ? "voice" : msg.video ? "video" : msg.sticker ? "sticker"
          : msg.audio ? "audio" : msg.location ? "location" : msg.contact ? "contact"
          : msg.caption ? "caption-only" : "other";

        let promptText = (msg.text || "").trim();
        if (!promptText && msg.voice) {
          telegramApi("setMessageReaction", {
            chat_id: chatId, message_id: msg.message_id,
            reaction: [{ type: "emoji", emoji: "🎙" }],
          }).catch(() => {});
          telegramApi("sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => {});
          const tmpPath = await downloadTelegramFile(msg.voice.file_id);
          if (tmpPath) {
            promptText = await transcribeVoiceNote(tmpPath);
            console.log(`[telegram] voice transcribed: "${promptText.slice(0, 120)}"`);
          }
          if (!promptText) {
            telegramApi("setMessageReaction", {
              chat_id: chatId, message_id: msg.message_id,
              reaction: [{ type: "emoji", emoji: "❌" }],
            }).catch(() => {});
            await sendTelegramMessage(chatId, "Could not transcribe the voice note. Please try again or send text.");
            continue;
          }
        }

        if (!promptText) {
          console.log(`[telegram] update ${u.update_id}: non-text message (${msgType}) from ${username} (${userId}) in chat ${chatId} — skipped`);
          continue;
        }

        const preview = promptText.length > 80 ? promptText.slice(0, 80) + "…" : promptText;
        console.log(`[telegram] update ${u.update_id}: text from ${username} (${userId}) in chat ${chatId}: "${preview}"`);

        try {
          if (TELEGRAM_ALLOWED_IDS.length === 0) {
            console.log(`[telegram] rejected: no allowlist configured (user ${userId})`);
            await sendTelegramMessage(
              chatId,
              "This bot requires an allowlist. Set TELEGRAM_ALLOWED_USER_IDS in .env (comma-separated user IDs) and restart the server. Your user ID: " + userId + " — add it to allow access."
            );
            continue;
          }
          if (!TELEGRAM_ALLOWED_IDS.includes(String(userId))) {
            console.log(`[telegram] rejected: user ${userId} (${username}) not in allowlist`);
            await sendTelegramMessage(
              chatId,
              "You're not allowed to use this bot. Your Telegram user ID is: " + userId + ". Add it to TELEGRAM_ALLOWED_USER_IDS in .env and restart to allow access."
            );
            continue;
          }
          const cmdMatch = promptText.match(/^\/(\w+)(?:@\w+)?(?:\s+(.*))?$/);

          if (cmdMatch) {
            const cmd = cmdMatch[1].toLowerCase();
            const cmdArg = (cmdMatch[2] || "").trim();
            const state = getChatState(chatId);
            console.log(`[telegram] command /${cmd}${cmdArg ? " " + cmdArg : ""} from ${username}`);

            switch (cmd) {
              case "voice":
              case "graham": {
                state.voiceReply = !state.voiceReply;
                saveTelegramChatState();
                console.log(`[telegram] voiceReply for chat ${chatId} → ${state.voiceReply}`);
                await sendTelegramMessage(chatId, `Reply with audio (TTS) is now ${state.voiceReply ? "on" : "off"}. Send /voice or /graham again to toggle.`);
                continue;
              }
              case "new":
              case "newchat":
              case "reset": {
                state.sessionId = null;
                state.geminiSessionId = null;
                saveTelegramChatState();
                console.log(`[telegram] /${cmd} from ${username} — session reset`);
                await sendTelegramMessage(chatId, "Started a new chat. Your next message will begin a fresh conversation.");
                continue;
              }
              case "model": {
                if (!cmdArg) {
                  await sendTelegramMessage(chatId,
                    `Current model: ${state.model}\n\nUsage: /model <name>\nExamples: /model sonnet, /model opus, /model auto`);
                } else {
                  state.model = cmdArg.toLowerCase();
                  saveTelegramChatState();
                  console.log(`[telegram] /${cmd} ${cmdArg} from ${username} — model set to ${state.model}`);
                  await sendTelegramMessage(chatId, `Model set to: ${state.model}`);
                }
                continue;
              }
              case "agent":
              case "cli": {
                const available = Object.keys(CLI_PROFILES);
                if (!cmdArg) {
                  const profileList = available.map((k) => `  ${k === state.cli ? "→ " : "  "}${k} (${CLI_PROFILES[k].label})`).join("\n");
                  await sendTelegramMessage(chatId,
                    `Current agent: ${state.cli} (${CLI_PROFILES[state.cli]?.label || "unknown"})\n\nAvailable:\n${profileList}\n\nUsage: /agent <name>`);
                } else {
                  const choice = cmdArg.toLowerCase();
                  if (!CLI_PROFILES[choice]) {
                    await sendTelegramMessage(chatId,
                      `Unknown agent: "${choice}"\nAvailable: ${available.join(", ")}`);
                  } else {
                    state.cli = choice;
                    state.sessionId = null;
                    state.geminiSessionId = null;
                    saveTelegramChatState();
                    console.log(`[telegram] /${cmd} ${choice} from ${username} — CLI set to ${choice}, session reset`);
                    await sendTelegramMessage(chatId,
                      `Agent switched to: ${choice} (${CLI_PROFILES[choice].label})\nSession reset — next message starts a fresh conversation.`);
                  }
                }
                continue;
              }
              case "status": {
                const profile = CLI_PROFILES[state.cli] || {};
                const lines = [
                  `Agent: ${state.cli} (${profile.label || "unknown"})`,
                  `Model: ${state.model}`,
                  `Session: ${state.cli === "gemini" ? state.geminiSessionId || "none" : state.sessionId || "none"}`,
                  `Reply with audio (TTS): ${state.voiceReply ? "on" : "off"} — /voice or /graham to toggle`,
                  `Server default agent: ${currentCli}`,
                ];
                await sendTelegramMessage(chatId, lines.join("\n"));
                continue;
              }
              case "help":
              case "start": {
                const helpText = [
                  "Available commands:",
                  "",
                  "/new — Start a fresh conversation",
                  "/convos or /conversations — List recent conversations",
                  "/convo <n> — Switch to conversation n (e.g. /convo 1)",
                  "/model <name> — Set model (e.g. sonnet, opus, auto)",
                  "/agent <name> — Switch CLI agent (e.g. agent, claude)",
                  "/voice or /graham — Toggle reply with audio (TTS)",
                  "/status — Show current settings",
                  "/help — Show this message",
                  "",
                  "Send a voice note to speak instead of typing. Any other message is sent to the agent.",
                ].join("\n");
                await sendTelegramMessage(chatId, helpText);
                continue;
              }
              case "conversations":
              case "convos": {
                const listLimit = cmdArg && /^\d+$/.test(cmdArg) ? Math.min(parseInt(cmdArg, 10), 50) : 20;
                const threads = getTelegramChatThreads(chatId, listLimit);
                if (threads.length === 0) {
                  await sendTelegramMessage(chatId, "No conversations yet. Send a message to start one; use /new to start a fresh thread.");
                  continue;
                }
                const lines = ["Recent conversations (use /convo <n> to switch):\n"];
                threads.forEach((t, i) => {
                  const ts = (t.updatedAt || "").slice(0, 16).replace("T", " ");
                  lines.push(`${i + 1}. [${ts}] ${t.messageCount} msgs — ${t.preview}`);
                });
                await sendTelegramMessage(chatId, lines.join("\n"));
                continue;
              }
              case "convo": {
                const num = cmdArg ? parseInt(cmdArg, 10) : NaN;
                if (!Number.isInteger(num) || num < 1) {
                  await sendTelegramMessage(chatId, "Usage: /convo <n> — e.g. /convo 1 to switch to the first conversation in the list.");
                  continue;
                }
                const threads = getTelegramChatThreads(chatId, 50);
                if (threads.length === 0) {
                  await sendTelegramMessage(chatId, "No conversations yet. Send a message to start one, or /convos to see the list.");
                  continue;
                }
                if (num > threads.length) {
                  await sendTelegramMessage(chatId, `Invalid number. Use 1–${threads.length} (send /convos to see the list).`);
                  continue;
                }
                const chosen = threads[num - 1];
                state.sessionId = chosen.id;
                saveTelegramChatState();
                const ts = (chosen.updatedAt || "").slice(0, 16).replace("T", " ");
                await sendTelegramMessage(chatId, `Switched to conversation ${num} (updated ${ts}). Your next message will use this context.`);
                continue;
              }
              default:
                break; // unknown /command — fall through and treat as a prompt
            }
          }

          telegramApi("sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => {});
          telegramApi("setMessageReaction", {
            chat_id: chatId,
            message_id: msg.message_id,
            reaction: [{ type: "emoji", emoji: "👀" }],
          }).catch(() => {});
          console.log(`[telegram] dispatching to ${getChatState(chatId).cli} for chat ${chatId}`);
          runAgentForTelegram(chatId, promptText, msg.message_id);
        } catch (err) {
          console.log(`[telegram] error processing update ${u.update_id}: ${err.message}`);
        }
      }
    } catch (err) {
      if (!telegramPollAbort || telegramPollAbort.signal.aborted) return;
      consecutiveErrors++;
      const delay = Math.min(1000 * Math.pow(2, consecutiveErrors), 30000);
      if (DEBUG) console.log(`[telegram] poll error: ${err.message}, retry in ${delay}ms`);
      setTimeout(poll, delay);
      return;
    }
    setTimeout(poll, 100);
  };

  poll();
}

startScheduledJobs();

// Graceful shutdown: abort in-flight Telegram poll so Telegram releases the connection immediately
function gracefulShutdown(signal) {
  if (DEBUG) console.log(`\n[server] ${signal} received, shutting down…`);
  telegramPolling = false;
  if (telegramPollAbort) {
    telegramPollAbort.abort();
    telegramPollAbort = null;
  }
  for (const [, task] of scheduledCronTasks) task.stop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000);
}
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));

server.listen(PORT, () => {
  console.log(`Agent Web UI: http://localhost:${PORT}`);
  console.log(`Workspace: ${WORKSPACE}`);
  console.log(`Default CLI: ${currentCli} (${CLI_PROFILES[currentCli].label}) — available: ${Object.keys(CLI_PROFILES).join(", ")}`);
  if (AGENT_WEB_PASSWORD) console.log("Web UI: password protection enabled");
  const jobs = loadScheduledJobs().filter((j) => j.enabled !== false && j.cron);
  if (jobs.length) console.log(`Scheduled: ${jobs.length} cron job(s) loaded`);
  if (CHANGELOG_SECRET) console.log("Changelogs: external POST enabled (set CHANGELOG_SECRET)");
  if (TELEGRAM_BOT_TOKEN && TELEGRAM_ENABLED) {
    if (TELEGRAM_ALLOWED_IDS.length === 0) {
      console.log("Telegram: bot enabled but TELEGRAM_ALLOWED_USER_IDS is empty — all messages will be rejected until you set it in .env");
    } else {
      console.log("Telegram: allowlist enabled (" + TELEGRAM_ALLOWED_IDS.length + " user(s))");
    }
    pollTelegram();
  } else if (TELEGRAM_BOT_TOKEN && !TELEGRAM_ENABLED) {
    console.log("Telegram: disabled (set TELEGRAM_ENABLED=1 to enable)");
  }
});
