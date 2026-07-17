#!/usr/bin/env node
// airport ground crew — the turn runner. One file, ANY machine. Bare-bones by
// design: dial OUT to the tower (no inbound port needed — laptops behind NAT
// work), auth, then execute self-contained commands:
//
//   ← {type:"run", session, prompt, history:[{role,text}…], meta:{cwd,model,
//        systemPrompt,systemMode,tools,claudeSessionId,sidHost,dirty}}
//        resume claudeSessionId when clean AND sidHost is this machine;
//        else SYNTHESIZE a transcript from history (see SYNTHETIC.md) — that's
//        also how a session MOVES between machines: one cold rebuild, then
//        cache-hot here.
//   ← {type:"interrupt", session}          SIGTERM the run's process group
//   ← {type:"fs", reqId, session, cwd, op:list|read|write, rel, text, ifAbsent}
//   → {type:"addbox"|"run-done"|"fs-res", …}
//
// Config (env, or KEY=VALUE lines in <state>/.env):
//   AIRPORT_SERVER         tower URL, e.g. wss://tower.example:7800 (or ws:// / http://)
//   AIRPORT_HOST_NAME      this machine's name (default: short hostname)
//   AIRPORT_PASS           tower passphrase (omit if the tower runs open)
//   AIRPORT_STATE_DIR      default ~/.airport
//   AIRPORT_CLAUDE_BIN     default "claude"
//   AIRPORT_DEFAULT_MODEL  default "claude-fable-5"
//   AIRPORT_SESS_ROOT      where remapped session cwds live (default ~/airport-sessions)
//   AIRPORT_ROOTS          extra cwd whitelist, colon-separated (e.g. ~/pima:~/src)
//   AIRPORT_MAX_TURNS      concurrent turn cap (default 2)
//
// Auth to claude: up to two subscription oauth tokens in <state>/.env
// (CLAUDE_CODE_OAUTH_TOKEN, CLAUDE_CODE_OAUTH_TOKEN_2) with STICKY FAILOVER on
// allowance/auth errors — a failed turn that smells like "out of credit" flips
// accounts, retries once, and the winner sticks (see README). No tokens = this
// machine's ambient claude login.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, execFile } = require("child_process");

const STATE_DIR = process.env.AIRPORT_STATE_DIR || path.join(os.homedir(), ".airport");
fs.mkdirSync(STATE_DIR, { recursive: true });

// ---------- env (<state>/.env supplies defaults; real env wins) ----------
let envText = "";
try {
  envText = fs.readFileSync(path.join(STATE_DIR, ".env"), "utf8");
  for (const m of envText.matchAll(/^([A-Z0-9_]+)\s*=\s*(\S+)/gm))
    if (process.env[m[1]] == null) process.env[m[1]] = m[2];
} catch (_) {}

const HOST_NAME = (process.env.AIRPORT_HOST_NAME || os.hostname().split(".")[0])
  .toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "ground";
const SERVER = (process.env.AIRPORT_SERVER || "ws://localhost:7800")
  .replace(/^http/, "ws").replace(/\/+$/, "");
const PASS = process.env.AIRPORT_PASS || null;
const CLAUDE_BIN = process.env.AIRPORT_CLAUDE_BIN || "claude";
const DEFAULT_MODEL = process.env.AIRPORT_DEFAULT_MODEL || "claude-fable-5";
const DEFAULT_TOOLS = "Bash,Read,Edit,Write,Glob,Grep,WebFetch,WebSearch,TodoWrite";
const TURN_TIMEOUT_MS = Number(process.env.AIRPORT_TURN_TIMEOUT_MS || 10 * 60 * 1000);
const MAX_CONCURRENT_TURNS = Number(process.env.AIRPORT_MAX_TURNS || 2);

const expandHome = (p) => (p && p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p);
const SESS_ROOT = expandHome(process.env.AIRPORT_SESS_ROOT || "~/airport-sessions");
const WHITELIST = [SESS_ROOT].concat(
  (process.env.AIRPORT_ROOTS || "").split(":").filter(Boolean).map(expandHome));

// subscription tokens (up to two accounts; sticky failover)
const TOKENS = [];
for (const key of ["CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN_2"]) {
  const m = new RegExp("^" + key + "\\s*=\\s*(\\S+)", "m").exec(envText);
  if (m) TOKENS.push(m[1]);
  else if (process.env[key]) TOKENS.push(process.env[key]);
}
const TOKEN_STATE = path.join(STATE_DIR, "token-state.json");
let tokenIdx = 0;
try { tokenIdx = Math.min(JSON.parse(fs.readFileSync(TOKEN_STATE, "utf8")).idx || 0, Math.max(TOKENS.length - 1, 0)); } catch (_) {}
function saveTokenIdx() { try { fs.writeFileSync(TOKEN_STATE, JSON.stringify({ idx: tokenIdx }) + "\n"); } catch (_) {} }
// the limit failure shape (live-verified): exit 0, subtype "success", but is_error
// with result text like "You've reached your … limit" — so detection keys on a
// FAILED turn plus this deliberately broad regex.
const LIMIT_RE = /limit|allowance|quota|exceed|credit|unauthorized|invalid.*(key|token)|revoked|401|403|429/i;

let CLAUDE_VERSION = "2.1.207";
execFile(CLAUDE_BIN, ["--version"], (e, out) => { if (!e && out) CLAUDE_VERSION = out.trim().split(/\s/)[0]; });

function log(msg) {
  console.log(`[${new Date().toISOString().replace("T", " ").slice(0, 19)}] ${msg}`);
}

const uuid = () => require("crypto").randomUUID();
const encodeCwd = (p) => p.replace(/[\/._]/g, "-");
function inWhitelist(abs) {
  return WHITELIST.some((root) => abs === root || abs.startsWith(root + path.sep));
}

// ---------- transcript synthesis (see SYNTHETIC.md — CC-internal format) ----------
function synthTranscript(cwd, modelId, history) {
  const sid = uuid();
  const dir = path.join(os.homedir(), ".claude", "projects", encodeCwd(cwd));
  fs.mkdirSync(dir, { recursive: true });
  // merge consecutive same-role text; tool boxes are display-only artifacts of past runs
  const turns = [];
  for (const b of history) {
    if (b.role !== "user" && b.role !== "ai") continue;
    const role = b.role === "ai" ? "assistant" : "user";
    if (turns.length && turns[turns.length - 1].role === role) turns[turns.length - 1].text += "\n\n" + (b.text || "");
    else turns.push({ role, text: b.text || "" });
  }
  const lines = [];
  let parent = null;
  let ts = Date.now() - turns.length * 2000;
  for (const t of turns) {
    const u = uuid();
    const base = {
      parentUuid: parent, isSidechain: false, userType: "external",
      cwd, sessionId: sid, version: CLAUDE_VERSION, gitBranch: "",
      timestamp: new Date((ts += 2000)).toISOString(), uuid: u,
    };
    if (t.role === "user") {
      lines.push(JSON.stringify({ ...base, type: "user", message: { role: "user", content: t.text } }));
    } else {
      lines.push(JSON.stringify({
        ...base, type: "assistant", requestId: "req_synth_" + u.slice(0, 8),
        message: {
          id: "msg_synth_" + u.slice(0, 8), type: "message", role: "assistant", model: modelId,
          content: [{ type: "text", text: t.text }], stop_reason: "end_turn", stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        },
      }));
    }
    parent = u;
  }
  fs.writeFileSync(path.join(dir, sid + ".jsonl"), lines.join("\n") + "\n");
  return sid;
}

// ---------- running turns ----------
const procs = new Map(); // session id -> ChildProcess

function addBox(id, role, text, extra) {
  towerSend({ type: "addbox", session: id, role, text, extra: extra || {} });
}

// a session's stored cwd is interpreted PER MACHINE: if it doesn't fit this
// machine's whitelist (e.g. ~/pima flown to the box), it deterministically
// remaps to <sess root>/<id> — the stored cwd stays untouched, so flying
// home restores the original workshop.
function effectiveCwd(id, cwdRaw) {
  let cwd = expandHome(cwdRaw || "");
  try {
    fs.mkdirSync(cwd, { recursive: true });
    cwd = fs.realpathSync(cwd); // /tmp is a symlink on macOS — claude encodes the RESOLVED cwd
  } catch (_) { cwd = ""; }
  if (cwd && inWhitelist(cwd)) return { cwd, remapped: false };
  const fallback = path.join(SESS_ROOT, id);
  fs.mkdirSync(fallback, { recursive: true });
  return { cwd: fs.realpathSync(fallback), remapped: true };
}

function failRun(id, error) {
  addBox(id, "tool", "✗ " + error, { synced: true, err: true });
  runDone(id, { failed: true, error });
}

function run(cmd, attempt = 0) {
  const id = cmd.session;
  if (procs.has(id)) { failRun(id, "already running here"); return; }
  if (procs.size >= MAX_CONCURRENT_TURNS) { failRun(id, "ground crew busy (turn cap " + MAX_CONCURRENT_TURNS + ")"); return; }
  if (!TOKENS.length && process.env.ANTHROPIC_API_KEY) {
    failRun(id, "ANTHROPIC_API_KEY is set and no oauth tokens configured — that would bill cash, not the plan"); return;
  }

  let cwd, remapped;
  try { ({ cwd, remapped } = effectiveCwd(id, cmd.meta.cwd)); }
  catch (e) { failRun(id, "cwd: " + e.message); return; }

  const model = cmd.meta.model || DEFAULT_MODEL;

  let resumeSid = cmd.meta.claudeSessionId;
  let synthed = false;
  if (cmd.meta.dirty || !resumeSid || cmd.meta.sidHost !== HOST_NAME) {
    if ((cmd.history || []).length) {
      try { resumeSid = synthTranscript(cwd, model, cmd.history); synthed = true; }
      catch (e) { runDone(id, { failed: true, error: "synthesis failed: " + e.message }); return; }
    } else resumeSid = null;
  }
  const sid = resumeSid || uuid();

  // context checkboxes (all live-verified on claude 2.1.207):
  //   useClaudeMd → the "project" setting source carries cwd CLAUDE.md
  //     (plus project skills/settings — they ride together)
  //   useSkills   → --disable-slash-commands kills ALL skills
  //   useMemory   → CLAUDE_CODE_DISABLE_AUTO_MEMORY=1 (the env var; --bare and
  //     CLAUDE_CODE_SIMPLE=1 also work but break subscription oauth — unusable)
  const args = ["-p", cmd.prompt, "--output-format", "stream-json", "--verbose",
    "--model", model, "--setting-sources", cmd.meta.useClaudeMd ? "user,project" : "user",
    "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
    "--allowedTools", cmd.meta.tools || DEFAULT_TOOLS, "--permission-mode", "dontAsk"];
  if (cmd.meta.useSkills === false) args.push("--disable-slash-commands");
  if (cmd.meta.systemPrompt) // part of the cache prefix — byte-stable across runs
    args.push(cmd.meta.systemMode === "replace" ? "--system-prompt" : "--append-system-prompt", cmd.meta.systemPrompt);
  args.push(resumeSid ? "--resume" : "--session-id", sid);

  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY; // subscription runs only — never bill cash by accident
  if (cmd.meta.useMemory === false) env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = "1";
  const tok = TOKENS[tokenIdx] || null;
  if (tok) env.CLAUDE_CODE_OAUTH_TOKEN = tok;

  let child;
  try { child = spawn(CLAUDE_BIN, args, { cwd, detached: true, env, stdio: ["ignore", "pipe", "pipe"] }); }
  catch (e) { failRun(id, "spawn: " + e.message); return; }
  procs.set(id, child);
  if (synthed && attempt === 0)
    addBox(id, "tool", (cmd.meta.sidHost && cmd.meta.sidHost !== HOST_NAME
      ? `🛬 session flew to ${HOST_NAME} — transcript rebuilt here (one cold read)`
      : "⟲ transcript rebuilt from boxes (fresh cache prefix)")
      + (remapped ? `\n🧭 hangar here: ${cwd} (stored cwd doesn't fit this machine)` : ""), { synced: true, sys: true });

  const killer = setTimeout(() => { log(`turn timeout (${id})`); try { process.kill(-child.pid, "SIGTERM"); } catch (_) {} }, TURN_TIMEOUT_MS);
  let buf = "", stderr = "", finalResult = null, lastMsgUsage = null;
  child.stderr.on("data", (d) => { stderr = (stderr + d).slice(-4000); });
  child.stdout.on("data", (d) => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
      let ev; try { ev = JSON.parse(line); } catch (_) { continue; }
      if (ev.type === "assistant") {
        if (ev.message?.usage) lastMsgUsage = ev.message.usage; // ctx size = LAST call, not the run's sum
        for (const c of ev.message?.content || []) {
          if (c.type === "text" && c.text?.trim()) addBox(id, "ai", c.text, { synced: true });
          if (c.type === "tool_use") {
            const inp = JSON.stringify(c.input || {});
            addBox(id, "tool", `▸ ${c.name}  ${inp.length > 300 ? inp.slice(0, 300) + "…" : inp}`, { synced: true });
          }
        }
      } else if (ev.type === "user") {
        for (const c of ev.message?.content || []) {
          if (c.type === "tool_result") {
            let t = typeof c.content === "string" ? c.content : (c.content || []).map((x) => x.text || "").join("\n");
            if (t.length > 1500) t = t.slice(0, 1500) + `\n… [${t.length} chars]`;
            if (t.trim()) addBox(id, "tool", t, { synced: true, result: true });
          }
        }
      } else if (ev.type === "result") finalResult = ev;
    }
  });

  child.on("close", (code) => {
    clearTimeout(killer);
    procs.delete(id);
    const failed = (code !== 0 && !finalResult) || finalResult?.is_error ||
      (finalResult?.subtype && finalResult.subtype !== "success");
    // account failover: allowance/auth smell → flip token, retry once
    if (failed && attempt === 0 && TOKENS.length > 1 &&
        LIMIT_RE.test(String(finalResult?.result || "") + " " + stderr)) {
      tokenIdx = (tokenIdx + 1) % TOKENS.length;
      saveTokenIdx();
      log(`(${id}) allowance/auth failure — switching to token #${tokenIdx + 1}, retrying`);
      addBox(id, "tool", "(account allowance hit — switching accounts and retrying)", { synced: true, sys: true });
      // retry resumes the SAME sid — the failed turn added nothing worth keeping
      run({ ...cmd, meta: { ...cmd.meta, claudeSessionId: sid, sidHost: HOST_NAME, dirty: false } }, 1);
      return;
    }
    if (failed)
      addBox(id, "tool", "✗ " + (finalResult?.result || finalResult?.subtype || ("claude exited " + code)) + (stderr ? "\n" + stderr.slice(0, 500) : ""), { synced: true, err: true });
    const u = finalResult?.usage;
    runDone(id, {
      claudeSessionId: sid, sidHost: HOST_NAME, failed: !!failed,
      error: failed ? String(finalResult?.subtype || ("exit " + code)) : null,
      stats: {
        ms: finalResult?.duration_api_ms || 0, cost: finalResult?.total_cost_usd || 0,
        out: u?.output_tokens || 0, in: u?.input_tokens || 0,
        cread: u?.cache_read_input_tokens || 0, cwrite: u?.cache_creation_input_tokens || 0,
        ctx: lastMsgUsage
          ? (lastMsgUsage.cache_read_input_tokens || 0) + (lastMsgUsage.cache_creation_input_tokens || 0) + (lastMsgUsage.input_tokens || 0) + (lastMsgUsage.output_tokens || 0)
          : (u ? (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.input_tokens || 0) : 0),
      },
    });
    log(`turn done (${id}) failed=${!!failed} $${finalResult?.total_cost_usd || "?"}`);
  });
  child.on("error", (err) => {
    clearTimeout(killer);
    procs.delete(id);
    runDone(id, { failed: true, error: "spawn failed: " + err.message });
  });
}

function runDone(id, extra) {
  towerSend(Object.assign({ type: "run-done", session: id }, extra));
}

function interrupt(id) {
  const child = procs.get(id);
  if (!child) return;
  try { process.kill(-child.pid, "SIGTERM"); } catch (_) { try { child.kill("SIGTERM"); } catch (_) {} }
  setTimeout(() => { if (procs.has(id)) { try { process.kill(-child.pid, "SIGKILL"); } catch (_) {} } }, 5000);
  addBox(id, "tool", "◼ interrupted", { synced: true, sys: true });
}

// ---------- fs ops (rooted at the session's effective cwd) ----------
const IMG_EXT = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml", ico: "image/x-icon" };
function fsSafe(id, cwdRaw, rel) {
  const root = effectiveCwd(id, cwdRaw).cwd;
  const p = path.resolve(root, rel || ".");
  if (p !== root && !p.startsWith(root + path.sep)) throw new Error("path escapes the session");
  return p;
}
function fsOp(cmd) {
  const res = { type: "fs-res", reqId: cmd.reqId, ok: true };
  try {
    if (cmd.op === "list") {
      const p = fsSafe(cmd.session, cmd.cwd, cmd.rel);
      res.entries = fs.readdirSync(p, { withFileTypes: true })
        .filter((e) => e.name !== ".git" && e.name !== "node_modules" && e.name !== ".DS_Store")
        .sort((a, b) => (b.isDirectory() - a.isDirectory()) || a.name.localeCompare(b.name))
        .map((e) => {
          let size = 0;
          try { if (!e.isDirectory()) size = fs.statSync(path.join(p, e.name)).size; } catch (_) {}
          return { name: e.name, dir: e.isDirectory(), size };
        });
    } else if (cmd.op === "read") {
      const p = fsSafe(cmd.session, cmd.cwd, cmd.rel);
      const st = fs.statSync(p);
      if (!st.isFile()) throw new Error("not a file");
      const buf = fs.readFileSync(p);
      const mime = IMG_EXT[(path.extname(p).slice(1) || "").toLowerCase()];
      if (buf.subarray(0, 8192).includes(0) || mime) {
        res.binary = true; res.size = st.size;
        // small images travel as base64 so the viewer can show them through the relay
        if (mime && st.size <= 2 * 1024 * 1024) { res.b64 = buf.toString("base64"); res.mime = mime; }
      } else {
        const CAP = 512 * 1024;
        res.text = buf.toString("utf8", 0, Math.min(buf.length, CAP));
        res.size = st.size; res.truncated = buf.length > CAP;
      }
    } else if (cmd.op === "write") {
      if (!cmd.rel || cmd.rel.endsWith("/")) throw new Error("bad filename");
      const p = fsSafe(cmd.session, cmd.cwd, cmd.rel);
      let st = null; try { st = fs.statSync(p); } catch (_) {}
      if (st && st.isDirectory()) throw new Error("is a directory");
      if (st && cmd.ifAbsent) throw new Error("already exists");
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, String(cmd.text ?? ""));
      res.size = Buffer.byteLength(String(cmd.text ?? ""));
    } else throw new Error("unknown op");
  } catch (e) { res.ok = false; res.error = e.message; }
  towerSend(res);
}

// ---------- tower connection (dial out + watchdog) ----------
let towerWs = null, connecting = false, lastAttempt = 0;
function towerSend(obj) {
  if (!towerWs || towerWs.readyState !== 1) return;
  try { towerWs.send(JSON.stringify(obj)); } catch (_) {}
}
function connect() {
  if (connecting) return;
  connecting = true; lastAttempt = Date.now();
  let ws;
  try { ws = new WebSocket(SERVER); } catch (_) { connecting = false; return; }
  ws.addEventListener("open", () => {
    connecting = false; towerWs = ws;
    towerSend({ type: "auth", role: "host", host: HOST_NAME, pass: PASS,
      info: { platform: os.platform(), sessRoot: SESS_ROOT, roots: WHITELIST,
              defaultModel: DEFAULT_MODEL, claudeVersion: CLAUDE_VERSION, tokens: TOKENS.length } });
    log("tower connected");
  });
  ws.addEventListener("message", (e) => {
    let m = null;
    try { m = JSON.parse(typeof e.data === "string" ? e.data : e.data.toString()); } catch (_) { return; }
    if (!m || !m.type) return;
    if (m.type === "run" && m.session && m.meta) { run(m); return; }
    if (m.type === "interrupt" && m.session) { interrupt(m.session); return; }
    if (m.type === "fs" && m.reqId) { fsOp(m); return; }
    if (m.type === "auth-failed") { log("tower rejected the pass — check AIRPORT_PASS"); }
  });
  ws.addEventListener("close", () => {
    connecting = false;
    if (towerWs === ws) towerWs = null;
    setTimeout(connect, 5000);
  });
  ws.addEventListener("error", (e) => { log(`ws error: ${(e && (e.message || (e.error && e.error.message))) || "unknown"}`); });
  const p = setInterval(() => {
    if (ws.readyState === 1) { try { ws.send('{"type":"ping"}'); } catch (_) {} }
    else if (ws.readyState > 1) clearInterval(p);
  }, 30000);
}

log(`✈ airport ground crew '${HOST_NAME}' → ${SERVER}`);
log(`state ${STATE_DIR} · claude ${CLAUDE_BIN} · default model '${DEFAULT_MODEL}' · auth ${TOKENS.length ? TOKENS.length + " oauth token(s), active #" + (tokenIdx + 1) : "ambient login"}`);
log(`cwd whitelist: ${WHITELIST.join(" · ")} (others remap to ${SESS_ROOT}/<id>)`);
connect();
setInterval(() => {
  const up = towerWs && towerWs.readyState === 1;
  if (!up && !connecting && Date.now() - lastAttempt > 15000) { log("watchdog: redialing tower"); connect(); }
}, 30000);
process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
