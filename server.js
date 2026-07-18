#!/usr/bin/env node
// airport tower — the control tower. Runs on the always-on machine (Lightsail)
// so the airfield is always serving; can also run on localhost for yard use.
//
// The tower's shelf doc OWNS every session: params (title/emoji/host/cwd/model/
// systemPrompt/systemMode/tools) + the full message mirror
// messages{m000001…: {role:user|ai|tool, text, ts, synced, stats}}. Everything
// is data manipulation (patches) until someone runs a turn — then the tower
// hands a SELF-CONTAINED run command to the session's host daemon (ground crew).
//
//   HTTP  GET  /            airport.html (page-version stamped for self-reload)
//         GET  /pagever     {v}
//         GET  /health      {ok, ...}
//         GET  /doc?pass=   the shelf doc (register-script verification / debug)
//         POST /auth        {pass} → {ok}
//         POST /update      {pass?, patch} → shelf-merge + broadcast (register scripts)
//         POST /run         {pass?, id, text?} → run a turn (curl-able)
//         POST /whisper?pass= raw audio → OpenAI whisper transcription
//   WS    browsers + host daemons connect, auth, receive the doc, exchange
//         deltas; run/interrupt/fs are routed to the owning host's socket.
//
// Auth: one passphrase (AIRPORT_PASS env, or AIRPORT_PASS= line in
// ~/.airport/.env). Unset = open (localhost/yard use). Browsers keep it in
// localStorage; daemons read the same env. TLS via AIRPORT_TLS_CERT/_KEY.
//
// Lineage: ~/pima/projects/marina (hub.js, multi-machine) + ~/ergeon/corral
// (server.js, the corral model). Shelf merge: github.com/dglittle/shelf.

const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const https = require("https");

const STATE_DIR = process.env.AIRPORT_STATE_DIR || path.join(os.homedir(), ".airport");
try { fs.mkdirSync(STATE_DIR, { recursive: true }); } catch (_) {}

// ---------- env (~/.airport/.env supplies defaults; real env wins) ----------
try {
  const envText = fs.readFileSync(path.join(STATE_DIR, ".env"), "utf8");
  for (const m of envText.matchAll(/^([A-Z0-9_]+)\s*=\s*(\S+)/gm))
    if (process.env[m[1]] == null) process.env[m[1]] = m[2];
} catch (_) {}

const PORT = Number(process.env.AIRPORT_PORT || 7800);
const VERSION = "1.0";
const PASS = process.env.AIRPORT_PASS || null; // null = open (yard mode)
const DIR = __dirname;
const HTML = path.join(DIR, "airport.html");
const DATA = process.env.AIRPORT_DATA || path.join(DIR, "airport-data.json");
const HOT_MS = 3600_000; // CLI prompt-cache TTL on subscription (ephemeral_1h, verified)

process.on("unhandledRejection", (x) => log(`unhandledRejection: ${(x && x.stack) || x}`));
process.on("uncaughtException", (x) => log(`uncaughtException: ${(x && x.stack) || x}`));

function log(msg) {
  console.log(`[${new Date().toISOString().replace("T", " ").slice(0, 19)}] ${msg}`);
}

// ---------- shelf (verbatim — github.com/dglittle/shelf) ----------
function shelf_merge(shelf, incoming) {
    if (!(incoming instanceof Array)) incoming = [incoming, null]
    let [val, ver, change] = merge(shelf[0], shelf[1], incoming[0], incoming[1])
    shelf[0] = val
    shelf[1] = ver
    return change

    function is_obj(o) { return o && typeof o == 'object' && !Array.isArray(o) }
    function ver_num(x) { return (x instanceof Array) ? x[0] : x }

    function make_ver(val) {
        let x = {}
        for (let [k, v] of Object.entries(val))
            x[k] = is_obj(v) ? [1, make_ver(v)] : 1
        return x
    }

    function merge(a_val, a_ver, b_val, b_ver) {
        if (b_ver == null) {
            if (!is_obj(a_val) || !is_obj(b_val)) {
                if (a_val == b_val) return [a_val, a_ver, null]
                b_ver = (a_ver ? ver_num(a_ver) : 0) + 1
                if (is_obj(b_val)) b_ver = [b_ver, make_ver(b_val)]
                return [b_val, b_ver, [b_val, b_ver]]
            }
        } else {
            let c = (a_ver != null) ? (ver_num(a_ver) - ver_num(b_ver)) : -1
            if (c > 0) return [a_val, a_ver, null]
            if (c < 0) return [b_val, b_ver, [b_val, b_ver]]
        }

        if (is_obj(a_val) && is_obj(b_val)) {
            let change = null
            for (let key of Object.keys(a_ver[1])) {
                if ((!b_ver && b_val[key] !== undefined) || b_ver?.[1][key] != null) {
                    let [val, ver, c] = merge(a_val[key], a_ver[1][key], b_val[key], b_ver?.[1][key])

                    if (val != null) a_val[key] = val
                    else delete a_val[key]

                    a_ver[1][key] = ver
                    if (c) {
                        if (!change) change = [{}, [ver_num(a_ver), {}]]
                        change[0][key] = c[0]
                        change[1][1][key] = c[1]
                    }
                }
            }
            for (let key of Object.keys(b_val)) {
                if (a_ver[1][key] == null) {
                    let [val, ver, c] = merge(null, null, b_val[key], b_ver?.[1][key])

                    if (val != null) a_val[key] = val
                    else delete a_val[key]

                    if (ver != null) a_ver[1][key] = ver

                    if (c) {
                        if (!change) change = [{}, [ver_num(a_ver), {}]]
                        change[0][key] = c[0]
                        change[1][1][key] = c[1]
                    }
                }
            }
            return [a_val, a_ver, change]
        } else if (JSON.stringify(a_val) >= JSON.stringify(b_val)) {
            return [a_val, a_ver, null]
        } else {
            return [b_val, b_ver, [b_val, b_ver]]
        }
    }
}

// ---------- doc + persistence ----------
let doc = [null, null];
try {
  const saved = JSON.parse(fs.readFileSync(DATA, "utf8"));
  doc = saved.length === 2 ? saved : [saved, null];
} catch (_) {}
shelf_merge(doc, { sessions: {}, hosts: {} }); // ensure shape
// boot cleanup: daemons re-report; anything marked running/online is stale
for (const [id, s] of Object.entries(doc[0].sessions || {}))
  if (s && (s.running || s.state === "processing"))
    shelf_merge(doc, { sessions: { [id]: { running: false, state: "offline" } } });
for (const [h, v] of Object.entries(doc[0].hosts || {}))
  if (v && v.online) shelf_merge(doc, { hosts: { [h]: { online: false } } });

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.writeFile(DATA, JSON.stringify(doc), (e) => { if (e) log("save failed: " + e.message); });
  }, 400);
}

// ---------- clients + fanout ----------
const clients = new Set(); // authed ws; ws._role = "browser"|"host", ws._host = name
function broadcast(msg) {
  const s = JSON.stringify(msg);
  for (const ws of clients) if (ws.readyState === 1) { try { ws.send(s); } catch (_) {} }
}
function apply(patch) {
  const delta = shelf_merge(doc, [patch, null]);
  if (delta) { broadcast({ type: "delta", delta: delta }); save(); }
  return delta;
}

// ---------- helpers ----------
const sess = (id) => (doc[0].sessions || {})[id];
const orderedBoxes = (s) => Object.keys(s.messages || {}).sort().map((k) => ({ key: k, ...s.messages[k] }));
function nextKey(s) {
  const keys = Object.keys(s.messages || {}).sort();
  const last = keys.length ? parseInt(keys[keys.length - 1].slice(1), 10) : 0;
  return "m" + String(last + 1).padStart(6, "0");
}
function addBox(id, role, text, extra) {
  const s = sess(id);
  if (!s) return null;
  const key = nextKey(s);
  apply({ sessions: { [id]: { messages: { [key]: Object.assign({ role, text, ts: Date.now() }, extra || {}) } } } });
  return key;
}
function hostSocket(hostName) {
  for (const c of clients) if (c._role === "host" && c._host === hostName && c.readyState === 1) return c;
  return null;
}
const fsWaiters = new Map(); // reqId -> browser socket

// ---------- run routing (the ⚡): tower builds a self-contained command ----------
function routeRun(id, text, fail) {
  const s = sess(id);
  if (!s) return fail("no such session");
  if (s.running) return fail("already running");
  if (typeof text === "string" && text.trim()) addBox(id, "user", text.trim().slice(0, 64 * 1024));
  const host = hostSocket(s.host);
  if (!host) return fail("no ground crew online for '" + (s.host || "?") + "'");
  const boxes = orderedBoxes(sess(id));
  // prompt = trailing contiguous unsynced user boxes
  const promptBoxes = [];
  for (let i = boxes.length - 1; i >= 0; i--) {
    if (boxes[i].role === "user" && !boxes[i].synced) promptBoxes.unshift(boxes[i]);
    else break;
  }
  if (!promptBoxes.length) return fail("nothing new to say — add a user box first");
  // per-airfield turn cap: UI override (hosts[h].turnCap) > daemon's env default
  const hostInfo = (doc[0].hosts || {})[s.host] || {};
  const cap = Math.max(1, Number(hostInfo.turnCap) || Number(hostInfo.maxTurns) || 2);
  const flying = Object.values(doc[0].sessions || {}).filter((x) => x && x.host === s.host && x.running).length;
  if (flying >= cap) return fail("airfield '" + s.host + "' at its turn cap (" + flying + "/" + cap + ") — raise it in ⚙ or wait");
  const prompt = promptBoxes.map((b) => b.text).join("\n\n");
  const history = boxes.slice(0, boxes.length - promptBoxes.length)
    .filter((b) => b.role === "user" || b.role === "ai")
    .map((b) => ({ role: b.role, text: b.text || "" }));
  apply({ sessions: { [id]: { running: true, state: "processing", startedAt: Date.now(), lastError: null } } });
  try {
    host.send(JSON.stringify({ type: "run", session: id, prompt, history, cap,
      meta: { cwd: s.cwd || "", model: s.model || "", systemPrompt: s.systemPrompt || "",
              systemMode: s.systemMode || "append", tools: s.tools || "",
              useClaudeMd: !!s.useClaudeMd, useMemory: s.useMemory !== false, useSkills: s.useSkills !== false,
              claudeSessionId: s.claudeSessionId || null, sidHost: s.sidHost || null, dirty: !!s.dirty,
              forkNext: !!s.forkNext } }));
  } catch (_) {
    apply({ sessions: { [id]: { running: false, state: "ready" } } });
    return fail("host send failed");
  }
  return true;
}

function routeInterrupt(id) {
  const s = sess(id);
  if (!s) return;
  const host = hostSocket(s.host);
  if (host) { try { host.send(JSON.stringify({ type: "interrupt", session: id })); } catch (_) {} }
}

// interrupt runs whose session vanished (deleted from another window mid-flight)
function reapDeleted(before) {
  for (const [id, s] of Object.entries(before))
    if (s && s.running && !sess(id)) {
      const host = hostSocket(s.host);
      if (host) { try { host.send(JSON.stringify({ type: "interrupt", session: id })); } catch (_) {} }
    }
}

// ---------- page version (clients self-reload when airport.html changes) ----------
let HTML_VER = "";
function hashHtml() {
  try { return crypto.createHash("sha1").update(fs.readFileSync(HTML)).digest("hex").slice(0, 12); }
  catch (_) { return HTML_VER; } // transient read failure (editor mid-save) — keep last known
}
HTML_VER = hashHtml();
apply({ pageVersion: HTML_VER });
fs.watchFile(HTML, { interval: 2000 }, () => {
  const v = hashHtml();
  if (v && v !== HTML_VER) { HTML_VER = v; apply({ pageVersion: v }); }
});

// ---------- account allowance (rate-limit headers on a 1-token probe) ----------
// The setup-token oauth scope can't read /api/oauth/usage, but every inference
// response carries anthropic-ratelimit-unified-* headers — so a minimal haiku
// call per account IS the usage query. Polled gently; doc.usage feeds the UI.
const USAGE_TOKENS = [];
for (const k of ["CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN_2"])
  if (process.env[k]) USAGE_TOKENS.push(process.env[k]);
let lastUsageFetch = 0;
function fetchUsage(force) {
  if (!USAGE_TOKENS.length) return;
  if (!force && Date.now() - lastUsageFetch < 60_000) return; // throttle post-turn refreshes
  lastUsageFetch = Date.now();
  USAGE_TOKENS.forEach((tok, i) => {
    const req = https.request({
      hostname: "api.anthropic.com", path: "/v1/messages", method: "POST", timeout: 15000,
      headers: { Authorization: "Bearer " + tok, "anthropic-beta": "oauth-2025-04-20",
        "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
    }, (res) => {
      res.resume();
      const h = res.headers;
      const num = (x) => (x == null ? null : Number(x));
      const entry = h["anthropic-ratelimit-unified-5h-utilization"] != null ? {
        five: num(h["anthropic-ratelimit-unified-5h-utilization"]),
        fiveReset: (num(h["anthropic-ratelimit-unified-5h-reset"]) || 0) * 1000 || null,
        seven: num(h["anthropic-ratelimit-unified-7d-utilization"]),
        sevenReset: (num(h["anthropic-ratelimit-unified-7d-reset"]) || 0) * 1000 || null,
        status: String(h["anthropic-ratelimit-unified-status"] || ""),
        at: Date.now(), err: null,
      } : { at: Date.now(), err: "no usage headers (http " + res.statusCode + ")" };
      apply({ usage: { [String(i + 1)]: entry } });
    });
    req.on("error", (e) => apply({ usage: { [String(i + 1)]: { at: Date.now(), err: e.message } } }));
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.end(JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 1,
      system: [{ type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." }],
      messages: [{ role: "user", content: "hi" }] }));
  });
}
setInterval(() => fetchUsage(false), 10 * 60 * 1000);
setTimeout(() => fetchUsage(true), 3000);

// ---------- whisper (OpenAI) ----------
function openaiKey() {
  return process.env.OPENAI_API_KEY || null; // env or ~/.airport/.env (loaded above)
}
function whisper(body, contentType, cb) {
  const key = openaiKey();
  if (!key) return cb({ status: 501, error: "no OPENAI_API_KEY (env or ~/.airport/.env)" });
  const boundary = "----airport" + crypto.randomBytes(8).toString("hex");
  const ext = /mp4/.test(contentType) ? "mp4" : /ogg/.test(contentType) ? "ogg" : "webm";
  const pre = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nwhisper-1\r\n` +
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.${ext}"\r\n` +
    `Content-Type: ${contentType || "audio/webm"}\r\n\r\n`);
  const post = Buffer.from(`\r\n--${boundary}--\r\n`);
  const payload = Buffer.concat([pre, body, post]);
  const req = https.request({
    hostname: "api.openai.com", path: "/v1/audio/transcriptions", method: "POST",
    headers: { Authorization: "Bearer " + key, "Content-Type": "multipart/form-data; boundary=" + boundary, "Content-Length": payload.length },
  }, (res) => {
    let out = "";
    res.on("data", (d) => (out += d));
    res.on("end", () => {
      try {
        const j = JSON.parse(out);
        if (j.text != null) cb({ status: 200, text: j.text });
        else cb({ status: 502, error: j.error?.message || out.slice(0, 200) });
      } catch (_) { cb({ status: 502, error: out.slice(0, 200) }); }
    });
  });
  req.on("error", (e) => cb({ status: 502, error: e.message }));
  req.end(payload);
}

// ---------- http ----------
const bootT = Date.now();
function okPass(p) { return !PASS || p === PASS; }
function json(res, status, obj) {
  res.writeHead(status, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
  res.end(JSON.stringify(obj));
}
const handler = (req, res) => {
  const url = new URL(req.url, "http://x");
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    return res.end();
  }
  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/airport.html")) {
    try {
      const html = fs.readFileSync(HTML, "utf8").replaceAll("__PAGE_VER__", HTML_VER);
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      return res.end(html);
    } catch (_) { res.writeHead(404); return res.end("airport.html missing"); }
  }
  if (req.method === "GET" && url.pathname === "/pagever") return json(res, 200, { v: HTML_VER });
  if (req.method === "GET" && url.pathname === "/health") {
    const ss = doc[0].sessions || {}, hh = doc[0].hosts || {};
    return json(res, 200, {
      ok: true, service: "airport-tower", version: VERSION, port: PORT,
      uptimeSec: Math.floor((Date.now() - bootT) / 1000), authRequired: !!PASS,
      sessions: Object.keys(ss).length,
      hosts: Object.fromEntries(Object.entries(hh).map(([k, v]) => [k, !!(v && v.online)])),
      clients: clients.size,
    });
  }
  if (req.method === "GET" && url.pathname === "/doc") {
    if (!okPass(url.searchParams.get("pass"))) return json(res, 403, { ok: false });
    return json(res, 200, { ok: true, doc });
  }
  if (req.method === "POST") {
    const chunks = [];
    let size = 0;
    req.on("data", (d) => { size += d.length; if (size > 26_000_000) req.destroy(); else chunks.push(d); });
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      if (url.pathname === "/whisper") {
        if (!okPass(url.searchParams.get("pass"))) return json(res, 403, { ok: false });
        return whisper(body, req.headers["content-type"] || "audio/webm", (r) =>
          json(res, r.status, r.status === 200 ? { ok: true, text: r.text } : { ok: false, error: r.error }));
      }
      let j = {};
      try { j = JSON.parse(body.toString("utf8") || "{}"); } catch (_) { return json(res, 400, { ok: false, error: "bad json" }); }
      if (url.pathname === "/auth") return json(res, okPass(j.pass) ? 200 : 403, { ok: okPass(j.pass) });
      if (!okPass(j.pass)) return json(res, 403, { ok: false, error: "bad pass" });
      if (url.pathname === "/update") {
        if (!j.patch || typeof j.patch !== "object") return json(res, 400, { ok: false, error: "no patch" });
        const before = { ...(doc[0].sessions || {}) };
        apply(j.patch);
        reapDeleted(before);
        return json(res, 200, { ok: true });
      }
      if (url.pathname === "/run") {
        let failed = null;
        const r = routeRun(String(j.id || ""), j.text, (e) => { failed = e; });
        return failed ? json(res, 409, { ok: false, error: failed }) : json(res, 200, { ok: true });
      }
      return json(res, 404, { ok: false, error: "unknown endpoint" });
    });
    return;
  }
  res.writeHead(404); res.end();
};

// TLS if certs given (Lightsail house certs), plain HTTP otherwise
const CERT = process.env.AIRPORT_TLS_CERT, KEY = process.env.AIRPORT_TLS_KEY;
let server;
if (CERT && KEY) {
  const certs = () => ({ cert: fs.readFileSync(CERT), key: fs.readFileSync(KEY) });
  server = https.createServer(certs(), handler);
  fs.watchFile(CERT, () => {
    try { server.setSecureContext(certs()); log("certs reloaded"); } catch (e) { log("cert reload failed: " + e.message); }
  });
} else {
  server = require("http").createServer(handler);
}

// ---------- ws ----------
const { WebSocketServer } = require("ws");
const wss = new WebSocketServer({ server, perMessageDeflate: false });

wss.on("connection", (ws) => {
  const peerId = crypto.randomBytes(3).toString("hex");
  let authed = false;
  const authTimer = setTimeout(() => { if (!authed) { try { ws.close(); } catch (_) {} } }, 8000);

  ws.on("message", (data) => {
    let m = null; try { m = JSON.parse(data.toString()); } catch (_) { return; }
    if (!m || !m.type) return;
    if (m.type === "ping") return;

    if (m.type === "auth") {
      if (authed) return;
      if (m.role === "host" && okPass(m.pass) && /^[a-z0-9-]{1,32}$/.test(String(m.host || ""))) {
        authed = true; ws._role = "host"; ws._host = m.host;
        // one daemon per machine: a newer socket for the same host supersedes the old
        for (const c of clients) if (c !== ws && c._role === "host" && c._host === m.host) { try { c.close(); } catch (_) {} }
        clients.add(ws);
        const info = (m.info && typeof m.info === "object") ? m.info : {};
        const patch = { hosts: { [m.host]: Object.assign({ online: true, lastSeen: Date.now() }, info) } };
        // its sessions are runnable again
        patch.sessions = {};
        for (const [id, s] of Object.entries(doc[0].sessions || {}))
          if (s && s.host === m.host && (s.state === "offline" || s.running))
            patch.sessions[id] = { state: "ready", running: false };
        apply(patch);
      } else if (m.role === "browser" && okPass(m.pass)) {
        authed = true; ws._role = "browser";
        clients.add(ws);
      } else {
        log(`peer=${peerId} bad auth (role=${m.role})`);
        try { ws.send(JSON.stringify({ type: "auth-failed" })); ws.close(); } catch (_) {}
        return;
      }
      clearTimeout(authTimer);
      log(`+ ${ws._role}${ws._host ? ":" + ws._host : ""} peer=${peerId} (${clients.size} clients)`);
      try { ws.send(JSON.stringify({ type: "doc", doc })); } catch (_) {}
      return;
    }

    if (!authed) return;

    if (m.type === "update" && m.patch && typeof m.patch === "object") {
      const before = { ...(doc[0].sessions || {}) };
      apply(m.patch);
      reapDeleted(before);
      return;
    }
    if (m.type === "addbox" && typeof m.session === "string" && typeof m.text === "string") {
      const role = ws._role === "host" ? String(m.role || "ai") : "user";
      if (!["user", "ai", "tool"].includes(role)) return;
      addBox(m.session, role, m.text.slice(0, 64 * 1024), m.extra && typeof m.extra === "object" ? m.extra : {});
      return;
    }
    if (m.type === "run" && ws._role === "browser" && typeof m.session === "string") {
      routeRun(m.session, m.text, (error) => {
        try { ws.send(JSON.stringify({ type: "run-failed", session: m.session, error })); } catch (_) {}
      });
      return;
    }
    if (m.type === "run-done" && ws._role === "host" && typeof m.session === "string") {
      const s = sess(m.session);
      if (!s) return;
      // sweep: the transcript now reflects every box
      const sweep = {};
      for (const b of orderedBoxes(s)) if (!b.synced) sweep[b.key] = { synced: true };
      const patch = { running: false, state: "ready", lastRunEndedAt: Date.now(),
        turns: (s.turns || 0) + 1, dirty: false, messages: sweep };
      if (m.claudeSessionId) { patch.claudeSessionId = m.claudeSessionId; patch.sidHost = m.sidHost || s.host; }
      // a successful fork turn consumed forkNext (the daemon reported the NEW sid);
      // a failed one keeps it so the next ⚡ re-attempts the branch (never appends to the parent)
      if (s.forkNext) patch.forkNext = m.failed ? true : null;
      if (m.stats) {
        patch.lastCost = m.stats.cost || 0; patch.lastMs = m.stats.ms || 0;
        patch.totalTokens = m.stats.ctx || 0;
        patch.hotUntil = Date.now() + HOT_MS;
        // pin the run's stats on its last ai box (per-box statline in the UI)
        if (m.stats.ms || m.stats.cost) {
          const bs = orderedBoxes(s);
          for (let i = bs.length - 1; i >= 0; i--) if (bs[i].role === "ai") {
            patch.messages[bs[i].key] = Object.assign({}, patch.messages[bs[i].key],
              { stats: { ms: m.stats.ms || 0, cost: m.stats.cost || 0, out: m.stats.out || 0,
                         cread: m.stats.cread || 0, cwrite: m.stats.cwrite || 0 } });
            break;
          }
        }
      }
      patch.lastError = m.failed ? String(m.error || "failed") : null;
      apply({ sessions: { [m.session]: patch } });
      fetchUsage(false); // refresh the allowance gauge after a turn (throttled)
      return;
    }
    if (m.type === "interrupt" && ws._role === "browser" && typeof m.session === "string") {
      routeInterrupt(m.session);
      return;
    }
    if (m.type === "fs" && ws._role === "browser" && typeof m.session === "string" && m.reqId) {
      const s = sess(m.session);
      const bounce = (error) => { try { ws.send(JSON.stringify({ type: "fs-res", reqId: m.reqId, ok: false, error })); } catch (_) {} };
      if (!s) return bounce("no such session");
      const host = hostSocket(s.host);
      if (!host) return bounce("ground crew offline");
      fsWaiters.set(m.reqId, ws);
      setTimeout(() => fsWaiters.delete(m.reqId), 30000);
      try { host.send(JSON.stringify({ type: "fs", reqId: m.reqId, session: m.session, cwd: s.cwd || "", op: m.op, rel: m.rel || "", text: m.text, ifAbsent: m.ifAbsent })); }
      catch (_) { fsWaiters.delete(m.reqId); bounce("host send failed"); }
      return;
    }
    if (m.type === "fs-res" && ws._role === "host" && m.reqId) {
      const waiter = fsWaiters.get(m.reqId);
      fsWaiters.delete(m.reqId);
      if (waiter && waiter.readyState === 1) { try { waiter.send(JSON.stringify(m)); } catch (_) {} }
      return;
    }
  });

  ws.on("close", () => {
    clearTimeout(authTimer);
    if (!clients.delete(ws)) return;
    log(`- ${ws._role || "?"}${ws._host ? ":" + ws._host : ""} peer=${peerId} (${clients.size} clients)`);
    if (ws._role === "host" && ws._host && !hostSocket(ws._host)) {
      const patch = { hosts: { [ws._host]: { online: false, lastSeen: Date.now() } }, sessions: {} };
      for (const [id, s] of Object.entries(doc[0].sessions || {})) {
        if (!s || s.host !== ws._host || s.state === "offline") continue;
        if (s.running) // make the kill VISIBLE — a silent mid-turn death looks like a finished turn
          addBox(id, "tool", "✗ ground crew went offline mid-turn — this run was lost (work already on disk is kept; ⚡ to continue)", { synced: true, err: true });
        patch.sessions[id] = { state: "offline", running: false };
      }
      apply(patch);
      log(`ground crew '${ws._host}' gone — its sessions offline`);
    }
  });

  ws.on("error", (e) => log(`ws err peer=${peerId}: ${e.message}`));
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") log(`port ${PORT} bound — old tower still up`);
  else log(`server error: ${err.message}`);
});
server.listen(PORT, "0.0.0.0", () => {
  const ss = doc[0].sessions || {};
  log(`✈ airport tower ${VERSION} on ${CERT ? "https" : "http"}://0.0.0.0:${PORT} — ${Object.keys(ss).length} session(s), auth ${PASS ? "ON" : "OFF (open)"}, data ${DATA}`);
});

process.on("SIGINT", () => { try { fs.writeFileSync(DATA, JSON.stringify(doc)); } catch (_) {} process.exit(0); });
process.on("SIGTERM", () => { try { fs.writeFileSync(DATA, JSON.stringify(doc)); } catch (_) {} process.exit(0); });
