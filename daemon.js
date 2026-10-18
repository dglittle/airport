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
//   AIRPORT_ROOTS          extra cwd whitelist, colon-separated (e.g. ~/code:~/src)
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
const TURN_TIMEOUT_MS = Number(process.env.AIRPORT_TURN_TIMEOUT_MS || 0); // 0 = no limit (◼ stop is the brake)
const MAX_CONCURRENT_TURNS = Number(process.env.AIRPORT_MAX_TURNS || 2);

const expandHome = (p) => (p && p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p);
const SESS_ROOT = expandHome(process.env.AIRPORT_SESS_ROOT || "~/airport-sessions");
// AIRPORT_ROOTS=/ whitelists the whole filesystem (the whitelist machinery stays)
const WHITELIST = [SESS_ROOT].concat(
  (process.env.AIRPORT_ROOTS || "").split(":").filter(Boolean).map(expandHome)
    .map((r) => (r.length > 1 ? r.replace(/\/+$/, "") : r)));

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
// ---- per-turn cost ----
// On --resume the CLI's result.total_cost_usd, modelUsage and duration_api_ms are
// CUMULATIVE over the whole transcript (verified 2.1.302), and subtracting the last
// total breaks after trims/rebuilds. result.usage IS per-invocation (summed over all
// of the turn's API calls — matches the CLI's own delta to 7 decimals), so the turn
// costs usage × price. Table = the CLI's model catalog (pricing_tiers, 2.1.302),
// $/Mtok; same formula as the CLI (1h vs 5m writes from usage.cache_creation,
// long_prompt tier, ×1.1 for inference_geo "us"). Unknown model → cost null.
const PRICE_TIERS = {
  tier_2_10:                  { input: 2,   output: 10,  w5: 2.5,   w1: 4,   read: 0.2 },
  tier_2_10_cache_read_0_10:  { input: 2,   output: 10,  w5: 2.5,   w1: 4,   read: 0.1 },
  tier_3_15:                  { input: 3,   output: 15,  w5: 3.75,  w1: 6,   read: 0.3 },
  tier_5_25:                  { input: 5,   output: 25,  w5: 6.25,  w1: 10,  read: 0.5 },
  tier_15_75:                 { input: 15,  output: 75,  w5: 18.75, w1: 30,  read: 1.5 },
  tier_10_50:                 { input: 10,  output: 50,  w5: 12.5,  w1: 20,  read: 1 },
  tier_10_50_cache_read_0_25: { input: 10,  output: 50,  w5: 12.5,  w1: 20,  read: 0.25 },
  tier_4_20_cache_read_0_20:  { input: 4,   output: 20,  w5: 5,     w1: 8,   read: 0.2 },
  haiku_35:                   { input: 0.8, output: 4,   w5: 1,     w1: 1.6, read: 0.08 },
  haiku_45:                   { input: 1,   output: 5,   w5: 1.25,  w1: 2,   read: 0.1 },
  haiku_55:                   { input: 0.1, output: 0.5, w5: 0.125, w1: 0.2, read: 0.01,
    long: { above: 1e5, input: 0.5, output: 2.5, w5: 0.625, w1: 1, read: 0.05 } },
};
const MODEL_TIER = {
  "claude-3-5-haiku": "haiku_35", "claude-haiku-4-5": "haiku_45", "claude-haiku-5-5": "haiku_55",
  "claude-3-5-sonnet": "tier_3_15", "claude-3-7-sonnet": "tier_3_15", "claude-sonnet-4-0": "tier_3_15", "claude-sonnet-4": "tier_3_15",
  "claude-sonnet-4-5": "tier_3_15", "claude-sonnet-4-6": "tier_3_15", "claude-sonnet-5": "tier_2_10", "claude-sonnet-5-5": "tier_2_10_cache_read_0_10",
  "claude-opus-4-0": "tier_15_75", "claude-opus-4": "tier_15_75", "claude-opus-4-1": "tier_15_75", "claude-opus-4-5": "tier_5_25",
  "claude-opus-4-6": "tier_5_25", "claude-opus-4-7": "tier_5_25", "claude-opus-4-8": "tier_5_25", "claude-opus-5": "tier_5_25",
  "claude-opus-5-5": "tier_4_20_cache_read_0_20", "claude-fable-5": "tier_10_50", "claude-fable-5-1": "tier_10_50_cache_read_0_25",
  "claude-mythos-5": "tier_10_50", "claude-mythos-5-1": "tier_10_50_cache_read_0_25",
};
function priceFor(model) {
  const m = String(model || "").toLowerCase().replace(/\[.*\]$/, "").replace(/-\d{8}$/, ""); // drop [1m] / -YYYYMMDD
  return PRICE_TIERS[MODEL_TIER[m]] || null;
}
function turnCost(model, u) {
  const p0 = priceFor(model);
  if (!p0 || !u) return null;
  const cw = u.cache_creation_input_tokens || 0, cr = u.cache_read_input_tokens || 0, inp = u.input_tokens || 0;
  const p = p0.long && inp + cr + cw > p0.long.above ? p0.long : p0;
  const h = Math.min((u.cache_creation && u.cache_creation.ephemeral_1h_input_tokens) || 0, cw);
  const c = (inp * p.input + (u.output_tokens || 0) * p.output + cr * p.read + h * p.w1 + (cw - h) * p.w5) / 1e6;
  return c * (u.inference_geo === "us" ? 1.1 : 1) + ((u.server_tool_use && u.server_tool_use.web_search_requests) || 0) * 0.01;
}

const LIMIT_RE = /limit|allowance|quota|exceed|credit|unauthorized|invalid.*(key|token)|revoked|401|403|429/i;

let CLAUDE_VERSION = "2.1.207";
execFile(CLAUDE_BIN, ["--version"], (e, out) => { if (!e && out) CLAUDE_VERSION = out.trim().split(/\s/)[0]; });

function log(msg) {
  console.log(`[${new Date().toISOString().replace("T", " ").slice(0, 19)}] ${msg}`);
}

const uuid = () => require("crypto").randomUUID();
const encodeCwd = (p) => p.replace(/[\/._]/g, "-");
function inWhitelist(abs) {
  return WHITELIST.some((root) => root === path.sep || abs === root || abs.startsWith(root + path.sep));
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

// ---------- tail trim: cut zapped trailing turns off the REAL transcript ----------
// The warm path for ⇥ detour zaps (and any turn-aligned tail delete): the cut
// lands right before the prompt record of the first zapped turn, so the
// surviving file is a byte-prefix of what earlier turns already cached — the
// resume re-reads the warm prefix AND the remaining history keeps its real
// tool traffic + thinking (no text-only rebuild). Any doubt → throw → the
// caller falls back to full synthesis, which is always safe.
function trimTranscript(cwd, sid, text) {
  const file = path.join(os.homedir(), ".claude", "projects", encodeCwd(cwd), sid + ".jsonl");
  const lines = fs.readFileSync(file, "utf8").split("\n").filter((l) => l.trim());
  const want = String(text).trim();
  const hits = [];
  for (let i = 0; i < lines.length; i++) {
    let r; try { r = JSON.parse(lines[i]); } catch (_) { continue; }
    if (r.type !== "user" || r.isSidechain || r.isMeta || !r.message || r.message.role !== "user") continue;
    const c = r.message.content;  // turn prompts are strings (tool results are block arrays)
    const t = typeof c === "string" ? c
      : Array.isArray(c) && c.length === 1 && c[0].type === "text" ? c[0].text : null;
    if (t != null && t.trim() === want) hits.push(i);
  }
  if (hits.length !== 1) throw new Error(hits.length ? "prompt text ambiguous" : "prompt not found");
  let cut = hits[0];
  while (cut > 0) {  // metadata riding with the zapped turn (queue-operation, last-prompt, …)
    let r; try { r = JSON.parse(lines[cut - 1]); } catch (_) { break; }
    if (r.type === "user" || r.type === "assistant") break;
    cut--;
  }
  if (!cut) throw new Error("cut would empty the transcript");
  fs.writeFileSync(file, lines.slice(0, cut).join("\n") + "\n");
  return lines.length - cut;
}

// ---------- running turns ----------
const procs = new Map(); // session id -> ChildProcess

function addBox(id, role, text, extra) {
  towerSend({ type: "addbox", session: id, role, text, extra: extra || {} });
}

// a session's stored cwd is interpreted PER MACHINE: if it doesn't fit this
// machine's whitelist (e.g. ~/code from a laptop, flown to a server), it deterministically
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
  runDone(id, { failed: true, error, unsent: true }); // bounced before the CLI ran: the prompt boxes stay pending
}

function run(cmd, attempt = 0) {
  const id = cmd.session;
  if (procs.has(id)) { failRun(id, "already running here"); return; }
  // cap: the tower sends the per-airfield value (UI-adjustable); env is the fallback
  const cap = Math.max(1, Number(cmd.cap) || MAX_CONCURRENT_TURNS);
  if (procs.size >= cap) { failRun(id, "ground crew busy (turn cap " + cap + ")"); return; }
  if (!TOKENS.length && process.env.ANTHROPIC_API_KEY) {
    failRun(id, "ANTHROPIC_API_KEY is set and no oauth tokens configured — that would bill cash, not the plan"); return;
  }

  let cwd, remapped;
  try { ({ cwd, remapped } = effectiveCwd(id, cmd.meta.cwd)); }
  catch (e) { failRun(id, "cwd: " + e.message); return; }

  const model = cmd.meta.model || DEFAULT_MODEL;

  let resumeSid = cmd.meta.claudeSessionId;
  let synthed = false;
  // resumable = clean history, ran here last, AND the transcript actually exists in
  // THIS effective cwd (claude locates sessions per-cwd — a remapped cwd, e.g. a
  // fork of an empty-cwd session, won't see the parent's transcript)
  const resumable = resumeSid && !cmd.meta.dirty && cmd.meta.sidHost === HOST_NAME &&
    fs.existsSync(path.join(os.homedir(), ".claude", "projects", encodeCwd(cwd), resumeSid + ".jsonl"));
  let trimmed = 0, trimErr = null;
  if (resumable && cmd.trim && cmd.trim.text) {
    try { trimmed = trimTranscript(cwd, resumeSid, cmd.trim.text); }
    catch (e) { trimErr = e.message; }
  }
  if (!resumable || trimErr) {
    if ((cmd.history || []).length) {
      try { resumeSid = synthTranscript(cwd, model, cmd.history); synthed = true; }
      catch (e) { runDone(id, { failed: true, error: "synthesis failed: " + e.message, unsent: true }); return; }
    } else resumeSid = null;
  }
  // the tower drops its trim marker once the transcript no longer needs it —
  // either the tail was cut in place, or a rebuild made the point moot
  const trimConsumed = !!(trimmed || synthed || cmd.trimSpent || cmd.priorSynthed);
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
  // real fork: branch the parent's transcript under a NEW session id (full context
  // incl. tool results; the CLI mints the id — we pick it up from the result event)
  const forking = !!(cmd.meta.forkNext && resumeSid && !synthed);
  if (forking) args.push("--fork-session");

  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY; // subscription runs only — never bill cash by accident
  if (cmd.meta.useMemory === false) env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = "1";
  // token: a plane may pin one (meta.token, 1-based, like its model); unpinned
  // planes ride the airfield's sticky failover index. cmd.useTok = this turn's
  // forced pick (the failover retry). Switching tokens = cold cache (per account).
  const pin = Number(cmd.meta.token) || 0;
  const tokUsed = cmd.useTok != null ? cmd.useTok
    : (pin >= 1 && pin <= TOKENS.length ? pin - 1 : tokenIdx);
  const tok = TOKENS[tokUsed] || null;
  if (tok) env.CLAUDE_CODE_OAUTH_TOKEN = tok;

  let child;
  try { child = spawn(CLAUDE_BIN, args, { cwd, detached: true, env, stdio: ["ignore", "pipe", "pipe"] }); }
  catch (e) { failRun(id, "spawn: " + e.message); return; }
  procs.set(id, child);
  if (trimmed && attempt === 0)
    addBox(id, "tool", `✂ zapped tail cut off the transcript in place (${trimmed} record(s)) — warm resume, real history kept`, { synced: true, sys: true });
  if (synthed && attempt === 0)
    addBox(id, "tool", (cmd.meta.sidHost && cmd.meta.sidHost !== HOST_NAME
      ? `🛬 session flew to ${HOST_NAME} — transcript rebuilt here (one cold read)`
      : "⟲ transcript rebuilt from boxes (fresh cache prefix)")
      + (trimErr ? `\n(✂ tail-trim fell back: ${trimErr})` : "")
      + (remapped ? `\n🧭 hangar here: ${cwd} (stored cwd doesn't fit this machine)` : ""), { synced: true, sys: true });

  const killer = TURN_TIMEOUT_MS > 0
    ? setTimeout(() => { log(`turn timeout (${id})`); try { process.kill(-child.pid, "SIGTERM"); } catch (_) {} }, TURN_TIMEOUT_MS)
    : null;
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
      const next = (tokUsed + 1) % TOKENS.length;
      if (!pin) { // unpinned: the airfield's sticky default flips too
        tokenIdx = next;
        saveTokenIdx();
        towerSend({ type: "update", patch: { hosts: { [HOST_NAME]: { activeToken: tokenIdx + 1 } } } });
      }
      log(`(${id}) allowance/auth failure on token #${tokUsed + 1} — retrying on #${next + 1}${pin ? " (this turn only; plane pins #" + pin + ")" : ""}`);
      addBox(id, "tool", `(account allowance hit on t${tokUsed + 1} — retrying this turn on t${next + 1}${pin ? "; the plane stays pinned to t" + pin : ""})`, { synced: true, sys: true });
      // retry resumes the SAME sid — the failed turn added nothing worth keeping.
      // trim/synth already happened on attempt 0: don't redo, but keep reporting it
      run({ ...cmd, useTok: next, trim: null, trimSpent: trimConsumed, priorSynthed: synthed || cmd.priorSynthed,
            meta: { ...cmd.meta, claudeSessionId: sid, sidHost: HOST_NAME, dirty: false } }, 1);
      return;
    }
    if (failed)
      addBox(id, "tool", "✗ " + (finalResult?.result || finalResult?.subtype || ("claude exited " + code)) + (stderr ? "\n" + stderr.slice(0, 500) : ""), { synced: true, err: true });
    const u = finalResult?.usage;
    runDone(id, {
      // normal runs keep sid; a SUCCESSFUL --fork-session run gets the CLI-minted new
      // id from the result (a failed fork keeps the parent sid so the retry re-branches)
      claudeSessionId: (forking && !failed && finalResult?.session_id) ? finalResult.session_id : sid,
      sidHost: HOST_NAME, failed: !!failed, token: tok ? tokUsed + 1 : null,
      synthed: synthed || !!cmd.priorSynthed, trimConsumed,
      error: failed ? String(finalResult?.subtype || ("exit " + code)) : null,
      stats: {
        // per-invocation numbers only (duration_api_ms / total_cost_usd are cumulative on --resume)
        ms: finalResult?.duration_ms || 0,
        cost: turnCost(Object.keys(finalResult?.modelUsage || {}).length === 1 ? Object.keys(finalResult.modelUsage)[0] : model, u),
        total: finalResult?.total_cost_usd || 0, // the CLI's running total for this transcript
        model,
        out: u?.output_tokens || 0, in: u?.input_tokens || 0,
        cread: u?.cache_read_input_tokens || 0, cwrite: u?.cache_creation_input_tokens || 0,
        ctx: lastMsgUsage
          ? (lastMsgUsage.cache_read_input_tokens || 0) + (lastMsgUsage.cache_creation_input_tokens || 0) + (lastMsgUsage.input_tokens || 0) + (lastMsgUsage.output_tokens || 0)
          : (u ? (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.input_tokens || 0) : 0),
      },
    });
    { const tc = turnCost(model, u); log(`turn done (${id}) failed=${!!failed} turn $${tc == null ? "?" : tc.toFixed(4)} (transcript total $${finalResult?.total_cost_usd || "?"})`); }
  });
  child.on("error", (err) => {
    clearTimeout(killer);
    procs.delete(id);
    runDone(id, { failed: true, error: "spawn failed: " + err.message, synthed, trimConsumed, unsent: true });
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

// ---------- terminals (a real PTY, no native deps) ----------
// python3's pty module wins: BSD script(1) dies on node's socketpair stdio
// ("tcgetattr: Operation not supported on socket"). util-linux script(1)
// tolerates it, so linux-without-python still has a fallback; mac does not.
const HAVE_PY3 = (() => {
  try { return require("child_process").spawnSync("python3", ["-c", "import pty"], { timeout: 8000 }).status === 0; }
  catch (_) { return false; }
})();
const terms = new Map(); // termId -> child
function termOpen(m) {
  if (terms.has(m.termId)) return;
  let cwd;
  try { ({ cwd } = effectiveCwd(m.session, m.cwd)); }
  catch (e) { towerSend({ type: "term-exit", termId: m.termId, error: "cwd: " + e.message }); return; }
  const shell = process.env.SHELL || (os.platform() === "darwin" ? "/bin/zsh" : "/bin/bash");
  if (!HAVE_PY3 && os.platform() === "darwin") {
    towerSend({ type: "term-exit", termId: m.termId, error: "python3 required for the terminal on macOS" });
    return;
  }
  const [bin, args] = HAVE_PY3
    ? ["python3", ["-c", "import pty,sys; pty.spawn(sys.argv[1:])", shell, "-il"]]
    : ["script", ["-qfc", shell + " -il", "/dev/null"]];
  const env = { ...process.env, TERM: "xterm-256color" };
  delete env.ANTHROPIC_API_KEY;
  let child;
  try { child = spawn(bin, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] }); }
  catch (e) { towerSend({ type: "term-exit", termId: m.termId, error: "spawn: " + e.message }); return; }
  terms.set(m.termId, child);
  const cols = Math.max(20, Math.min(500, Number(m.cols) || 100));
  const rows = Math.max(5, Math.min(200, Number(m.rows) || 30));
  try { child.stdin.write(`stty cols ${cols} rows ${rows} 2>/dev/null; clear\n`); } catch (_) {}
  const onData = (d) => towerSend({ type: "term-data", termId: m.termId, data: d.toString("utf8") });
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);
  child.on("close", () => { terms.delete(m.termId); towerSend({ type: "term-exit", termId: m.termId }); });
  child.on("error", () => { terms.delete(m.termId); towerSend({ type: "term-exit", termId: m.termId, error: "terminal failed" }); });
  log(`term open ${m.termId} (${m.session}) @ ${cwd}`);
}
function termKill(termId) {
  const c = terms.get(termId);
  if (!c) return;
  terms.delete(termId);
  try { c.kill("SIGHUP"); } catch (_) {}
  setTimeout(() => { try { c.kill("SIGKILL"); } catch (_) {} }, 3000);
}

// ---------- git ops (rooted at the session's effective cwd) ----------
function gitOp(cmd) {
  const res = { type: "fs-res", reqId: cmd.reqId, ok: true };
  let root;
  try { root = effectiveCwd(cmd.session, cmd.cwd).cwd; }
  catch (e) { res.ok = false; res.error = e.message; towerSend(res); return; }
  const send = () => towerSend(res);
  const git = (args, cb) => execFile("git", args, { cwd: root, maxBuffer: 8 * 1024 * 1024, timeout: 20000 },
    (e, out, err) => cb(e && e.code === "ENOENT" ? Object.assign(e, { message: "git isn't installed on " + HOST_NAME }) : e, out, err));
  const sub = String(cmd.sub || "");
  if (sub === "status") {
    git(["status", "--porcelain=v1", "-uall"], (e, out, err) => {
      if (e) { res.ok = false; res.error = String(err || e.message).slice(0, 300); return send(); }
      res.text = out.toString().slice(0, 100000); send();
    });
  } else if (sub === "head") {
    // the file's content at HEAD ("" for files git doesn't know yet)
    let rel;
    try { rel = path.relative(root, fsSafe(cmd.session, cmd.cwd, cmd.rel)) || "."; }
    catch (e) { res.ok = false; res.error = e.message; return send(); }
    git(["show", "HEAD:" + rel.split(path.sep).join("/")], (e, out) => {
      res.text = e ? "" : out.toString().slice(0, 512 * 1024); send();
    });
  } else if (sub === "log") {
    git(["log", "--graph", "--format=%h\x1f%s\x1f%cr\x1f%D", "-n", "150"], (e, out, err) => {
      if (e) { res.ok = false; res.error = String(err || e.message).slice(0, 300); return send(); }
      res.text = out.toString().slice(0, 200000); send();
    });
  } else if (sub === "show" && /^[0-9a-f]{4,40}$/i.test(String(cmd.hash || ""))) {
    // -m --first-parent: merge commits show their diff vs first parent (plain `show` prints none)
    git(["show", "-m", "--first-parent", "--stat", "--patch", "--format=%h %s%n%an · %ar", String(cmd.hash)], (e, out, err) => {
      if (e) { res.ok = false; res.error = String(err || e.message).slice(0, 300); return send(); }
      let t = out.toString();
      if (t.length > 300000) t = t.slice(0, 300000) + "\n… [truncated]";
      res.text = t; send();
    });
  } else { res.ok = false; res.error = "unknown git op"; send(); }
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
  if (cmd.op === "git") { gitOp(cmd); return; } // async — sends its own fs-res
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
      // b64 = binary upload (pasted/attached images, files); text = editor saves
      const data = typeof cmd.b64 === "string" ? Buffer.from(cmd.b64, "base64") : String(cmd.text ?? "");
      fs.writeFileSync(p, data);
      res.size = typeof data === "string" ? Buffer.byteLength(data) : data.length;
    } else throw new Error("unknown op");
  } catch (e) { res.ok = false; res.error = e.message; }
  towerSend(res);
}

// ---------- tower connection (dial out + watchdog) ----------
let towerWs = null, pendingWs = null, connecting = false, lastAttempt = 0, reconnectTimer = null;
// ---- outbox: a tower restart / network blip must not lose a turn's boxes or its run-done ----
// While the socket is down, boxes/updates/run-done queue here (in order); on reconnect we
// auth first — reporting which turns are still flying and which finished meanwhile — then
// flush. fs/term replies aren't kept: the browser sockets that asked died with the tower.
// Capped at OUTBOX_MAX bytes (a long outage drops streaming boxes, never a run-done).
const OUTBOX = [];              // [{ s: json, type, session }]
let outboxBytes = 0;
const OUTBOX_MAX = 20_000_000;
const KEEP = new Set(["addbox", "run-done", "update"]);
function towerSend(obj) {
  const s = JSON.stringify(obj);
  if (towerWs && towerWs.readyState === 1 && !OUTBOX.length) {
    try { towerWs.send(s); return; } catch (_) {}
  }
  if (!KEEP.has(obj.type)) return;
  if (outboxBytes + s.length > OUTBOX_MAX && obj.type !== "run-done") return;
  OUTBOX.push({ s, type: obj.type, session: obj.session || null });
  outboxBytes += s.length;
}
function flushOutbox(ws) {
  let n = 0;
  while (OUTBOX.length && ws.readyState === 1) {
    const it = OUTBOX[0];
    try { ws.send(it.s); } catch (_) { break; }
    OUTBOX.shift(); outboxBytes -= it.s.length; n++;
  }
  if (n) log(`outbox: flushed ${n} message(s) held while the tower was unreachable`);
}
function scheduleConnect(ms) { // single pending redial — parallel timers seed flap loops
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connect, ms);
}
function connect() {
  if (connecting) return;
  if (towerWs && towerWs.readyState === 1) return; // already up — a second dial makes the
  // tower supersede-close the live socket, whose close handler redials: a forever flap
  connecting = true; lastAttempt = Date.now();
  let ws;
  try { ws = new WebSocket(SERVER); } catch (_) { connecting = false; return; }
  pendingWs = ws;
  ws.addEventListener("open", () => {
    connecting = false; towerWs = ws;
    // auth goes straight out (ahead of the outbox). flying = turns still running here;
    // pendingDone = turns that ended while we were cut off (their run-done is in the outbox)
    // — so the tower keeps the first flying and lets the second land normally.
    try {
      ws.send(JSON.stringify({ type: "auth", role: "host", host: HOST_NAME, pass: PASS,
        info: { platform: os.platform(), sessRoot: SESS_ROOT, roots: WHITELIST,
                defaultModel: DEFAULT_MODEL, claudeVersion: CLAUDE_VERSION, tokens: TOKENS.length,
                maxTurns: MAX_CONCURRENT_TURNS, activeToken: TOKENS.length ? tokenIdx + 1 : 0,
                flying: [...procs.keys()],
                pendingDone: OUTBOX.filter((x) => x.type === "run-done" && x.session).map((x) => x.session) } }));
    } catch (_) {}
    flushOutbox(ws);
    log("tower connected");
  });
  ws.addEventListener("message", (e) => {
    let m = null;
    try { m = JSON.parse(typeof e.data === "string" ? e.data : e.data.toString()); } catch (_) { return; }
    if (!m || !m.type) return;
    if (m.type === "run" && m.session && m.meta) { run(m); return; }
    if (m.type === "interrupt" && m.session) { interrupt(m.session); return; }
    if (m.type === "fs" && m.reqId) { fsOp(m); return; }
    if (m.type === "term" && m.termId) {
      if (m.action === "open") termOpen(m);
      else if (m.action === "in") { const c = terms.get(m.termId); if (c) { try { c.stdin.write(String(m.data || "")); } catch (_) {} } }
      else if (m.action === "kill") termKill(m.termId);
      return;
    }
    if (m.type === "auth-failed") { log("tower rejected the pass — check AIRPORT_PASS"); }
  });
  ws.addEventListener("close", () => {
    connecting = false;
    if (towerWs === ws) towerWs = null;
    if (towerWs && towerWs.readyState === 1) return; // a superseded/stale socket died — the live one stands
    scheduleConnect(5000);
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
  if (up) return;
  if (!connecting && Date.now() - lastAttempt > 15000) { log("watchdog: redialing tower"); connect(); return; }
  // a connect attempt can wedge without EVER firing close (seen on the mac
  // after sleep/dark-wake: "error" fires, "close" never does, `connecting`
  // sticks true and locks out every retry path) — force-reset stale attempts
  if (connecting && Date.now() - lastAttempt > 60000) {
    log("watchdog: connect attempt wedged — force reset");
    connecting = false;
    try { if (pendingWs) pendingWs.close(); } catch (_) {}
    connect();
  }
}, 30000);
process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
