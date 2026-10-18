#!/usr/bin/env node
// airport tower — the control tower. Runs on the always-on machine (e.g. a small cloud VM)
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
//         POST /wake        {pass?, id} → fire one ⏰ timer wake now (see wakeTick)
//         POST /whisper?pass= raw audio → OpenAI whisper transcription
//   WS    browsers + host daemons connect, auth, receive the doc, exchange
//         deltas; run/interrupt/fs are routed to the owning host's socket.
//
// Auth: one passphrase (AIRPORT_PASS env, or AIRPORT_PASS= line in
// ~/.airport/.env). Unset = open (localhost/yard use). Browsers keep it in
// localStorage; daemons read the same env. TLS via AIRPORT_TLS_CERT/_KEY.
//
// Lineage: two earlier projects — marina (the multi-machine hub) + corral
// (the single-machine original). Shelf merge: github.com/dglittle/shelf.

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
// ---- limbo: a ground crew we can't hear from may still be flying its turns ----
// (tower restart, network blip). Its running planes go "offline but still running" for
// LIMBO_MS; if the crew reconnects it reports which turns are still flying (kept flying)
// and which finished meanwhile (their run-done arrives from its outbox). Silence past the
// grace = the turns are presumed lost (the old behavior, now just delayed).
const LIMBO_MS = 90_000;
const limboTimers = {};
function armLimbo(host) {
  clearTimeout(limboTimers[host]);
  limboTimers[host] = setTimeout(() => {
    delete limboTimers[host];
    if (hostSocket(host)) return;
    const patch = { sessions: {} };
    for (const [id, s] of Object.entries(doc[0].sessions || {})) {
      if (!s || s.host !== host || !s.running) continue;
      addBox(id, "tool", "✗ ground crew went offline mid-turn — this run was lost (work already on disk is kept; ⚡ to continue)", { synced: true, err: true });
      patch.sessions[id] = { state: "offline", running: false };
    }
    apply(patch);
  }, LIMBO_MS);
}
// boot cleanup: daemons re-report. Running planes go into limbo (their crews will say
// whether they're still flying); hosts are offline until they dial in.
const bootLimbo = new Set();
for (const [id, s] of Object.entries(doc[0].sessions || {}))
  if (s && (s.running || s.state === "processing")) {
    shelf_merge(doc, { sessions: { [id]: { state: "offline" } } });
    if (s.running) bootLimbo.add(s.host); else shelf_merge(doc, { sessions: { [id]: { running: false } } });
  }
setTimeout(() => { for (const h of bootLimbo) armLimbo(h); }, 0);
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
  const box = Object.assign({ role, text, ts: Date.now() }, extra || {});
  const d = Number(s.indent) || 0;             // detour depth: every new box —
  if (d && box.depth == null) box.depth = d;   // user, ai, tool — rides at the session's current level
  apply({ sessions: { [id]: { messages: { [key]: box } } } });
  return key;
}
function hostSocket(hostName) {
  for (const c of clients) if (c._role === "host" && c._host === hostName && c.readyState === 1) return c;
  return null;
}
const fsWaiters = new Map(); // reqId -> browser socket
const termOwners = new Map(); // termId -> {ws (browser), hostName}

// ---------- run routing (the ⚡): tower builds a self-contained command ----------
function routeRun(id, text, fail) {
  const s = sess(id);
  if (!s) return fail("no such session");
  if (s.kind === "note") return fail("that's a 📝 note — nothing to fly");
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
  // lastToken = the account this turn flies on: the plane's pin, else the airfield's
  // sticky index (best guess at launch; run-done reports the real one, e.g. after failover)
  const nTok = Number(hostInfo.tokens) || 0, pin = Number(s.token) || 0;
  const lastToken = nTok ? (pin >= 1 && pin <= nTok ? pin : Number(hostInfo.activeToken) || 1) : null;
  // runBoxKeys: exactly the boxes this turn carries — run-done marks only THESE synced
  // (a box queued/stowed mid-flight was never seen by the run and must survive)
  apply({ sessions: { [id]: { running: true, state: "processing", startedAt: Date.now(), lastError: null, lastToken,
    runBoxKeys: promptBoxes.map((b) => b.key), queueWait: null } } });
  setTimeout(() => pushMem(), 3000); // the new claude process shows up on the meter
  try {
    host.send(JSON.stringify({ type: "run", session: id, prompt, history, cap,
      trim: (s.trim && s.trim.text) ? s.trim : null,  // pending tail-zap: daemon cuts the file in place before resuming
      meta: { cwd: s.cwd || "", model: s.model || "", systemPrompt: s.systemPrompt || "",
              systemMode: s.systemMode || "append", tools: s.tools || "",
              useClaudeMd: !!s.useClaudeMd, useMemory: s.useMemory !== false, useSkills: s.useSkills !== false,
              claudeSessionId: s.claudeSessionId || null, sidHost: s.sidHost || null, dirty: !!s.dirty,
              forkNext: !!s.forkNext, token: Number(s.token) || null } }));
  } catch (_) {
    apply({ sessions: { [id]: { running: false, state: "ready" } } });
    return fail("host send failed");
  }
  return true;
}

// capability flags the page checks before using newer messages (a hot-reloaded page
// can meet an older tower until the restart)
setTimeout(() => { if (!(doc[0].towerFeatures || {}).pump) apply({ towerFeatures: { queue: 1, pump: 1, icons: 1 } }); }, 0);

// ⏭ the queue flies itself: after a clean landing, the trailing unsynced user
// boxes (queued ones + anything ＋-stowed alongside) go out as the next turn.
// A bounce (turn cap, airfield offline) parks it with s.queueWait; kickQueues
// retries whenever a slot frees on that airfield or its ground crew reconnects.
function autoRun(id) {
  const s = sess(id);
  if (!s || s.running) return;
  const ok = routeRun(id, null, (error) => apply({ sessions: { [id]: { queueWait: "⏭ waiting: " + error } } }));
  if (ok === true) addBox(id, "tool", "⏭ queued message sent as the next turn", { synced: true, sys: true });
}
function kickQueues(hostName) {
  for (const [id, s] of Object.entries(doc[0].sessions || {}))
    if (s && s.host === hostName && !s.running && typeof s.queueWait === "string" && s.queueWait.startsWith("⏭ waiting")) autoRun(id);
}

// ---------- plane images: ~/airport/icons/<id>.png, stamped on the plane as iconV ----------
// POST /icon {pass, session, png: base64, meta?} — any PNG ≤ 1 MB (128×128 is
// plenty). GET /icon/<id>.png serves it (public: they're just pictures; ?v= busts caches).
const ICONS = path.join(DIR, "icons");
const safeId = (id) => /^[a-z0-9][a-z0-9-]{0,63}$/.test(String(id || ""));
function saveIcon(id, b64, meta) {
  if (!safeId(id) || !sess(id)) return "no such session";
  const buf = Buffer.from(String(b64 || ""), "base64");
  if (buf.length < 64 || buf.length > 1_000_000) return "png must be 64 B – 1 MB";
  if (buf.readUInt32BE(0) !== 0x89504e47) return "not a png";
  fs.mkdirSync(ICONS, { recursive: true });
  fs.writeFileSync(path.join(ICONS, id + ".png"), buf);
  const m = meta && typeof meta === "object" ? meta : {};
  apply({ sessions: { [id]: { iconV: Date.now(), iconMeta: JSON.stringify({
    title: String(m.title || sess(id).title || "").slice(0, 200), emoji: String(m.emoji || "").slice(0, 16),
    prompt: String(m.prompt || "").slice(0, 2000), model: String(m.model || "").slice(0, 80), at: Date.now() }) } } });
  return null;
}

// ---------- ⛽ pump: a plane that re-runs the same message, forever, without growing ----------
// s.pumpText = the message. Each pump first zaps the PREVIOUS pump turn (every box from the
// first pump-marked box on) — via ✂ tail-trim when it can (same session id: the base
// transcript survives byte-for-byte, warm cache), else a text rebuild — then sends pumpText
// again as a pump box. So the transcript is always base + one pump: it never needs to compact,
// and the last pump's results stay on screen until the next one.
function routePump(id, fail) {
  const s = sess(id);
  if (!s) return fail("no such session");
  if (!s.pumpText || !String(s.pumpText).trim()) return fail("not a pump plane — set a pump message in its flight plan");
  if (s.running) return fail("already flying — pump again when it lands");
  const all = orderedBoxes(s);
  const from = all.findIndex((b) => b.pump);
  if (from >= 0) {
    const cut = all.slice(from), msgs = {};
    for (const b of cut) msgs[b.key] = null;
    const real = (b) => b.synced && (b.role === "user" || b.role === "ai");
    const p = { messages: msgs };
    const firstReal = cut.find(real);
    if (firstReal) {
      let prevReal = null;
      for (let i = from - 1; i >= 0; i--) if (real(all[i])) { prevReal = all[i]; break; }
      if (!s.dirty && s.claudeSessionId && prevReal && prevReal.role === "ai" && firstReal.role === "user") {
        const texts = [];   // = the prompt routeRun sent for that turn (consecutive user boxes)
        for (const b of cut) { if (!real(b)) continue; if (b.role !== "user") break; texts.push(b.text || ""); }
        p.trim = { text: texts.join("\n\n") };
      } else p.dirty = true;   // no clean cut point (e.g. no base turn): rebuild from what's left
    }
    apply({ sessions: { [id]: p } });
  }
  addBox(id, "user", String(s.pumpText).trim().slice(0, 64 * 1024), { pump: true });
  return routeRun(id, null, fail);
}

// ---------- ⏰ wake timer: a plane that flies itself every N minutes ----------
// s.wakeEvery = minutes (≥ 5; null/0 = off). Once a minute the tower checks each plane:
// due when now ≥ (s.lastWakeAt || 0) + wakeEvery. A pump plane (pumpText) pumps — the
// transcript never grows; any other plane gets s.wakeText (default "⏰ wake") as a new turn.
// Not due-and-blocked (flying, airfield offline / at its turn cap, usage gate) = no box is
// added and lastWakeAt doesn't move: it just tries again next minute (s.wakeWait says why).
// Gate: s.wakeGate (0–1, default 0.8) — skip while EVERY account's 5h use is ≥ the gate.
// POST /wake {pass, id} fires one wake now (same path, ignores the clock and the gate).
function wakeBlocked(s, useGate) {
  if (s.running) return "flying";
  if (!hostSocket(s.host)) return "airfield '" + (s.host || "?") + "' offline";
  const hostInfo = (doc[0].hosts || {})[s.host] || {};
  const cap = Math.max(1, Number(hostInfo.turnCap) || Number(hostInfo.maxTurns) || 2);
  const flying = Object.values(doc[0].sessions || {}).filter((x) => x && x.host === s.host && x.running).length;
  if (flying >= cap) return "airfield at its turn cap (" + flying + "/" + cap + ")";
  if (useGate) {
    const gate = Number(s.wakeGate) > 0 ? Number(s.wakeGate) : 0.8;
    const use = Object.values(doc[0].usage || {}).filter((u) => u && typeof u.five === "number");
    if (use.length && use.every((u) => u.five >= gate)) return "5h use ≥ " + Math.round(gate * 100) + "% on every account";
  }
  return null;
}
function fireWake(id, useGate) {
  const s = sess(id);
  if (!s || s.kind === "note") return "no such plane";
  const why = wakeBlocked(s, useGate);
  if (why) {
    const w = "⏰ waiting: " + why;
    if (s.wakeWait !== w && why !== "flying") apply({ sessions: { [id]: { wakeWait: w } } });
    return why;
  }
  let err = null;
  const fail = (e) => { err = e; };
  apply({ sessions: { [id]: { lastWakeAt: Date.now(), wakeWait: null } } });
  addBox(id, "tool", "⏰ timer wake", { synced: true, sys: true });
  if (s.pumpText && String(s.pumpText).trim()) routePump(id, fail);
  else routeRun(id, String(s.wakeText || "").trim() || "⏰ wake", fail);
  if (err) { apply({ sessions: { [id]: { wakeWait: "⏰ failed: " + err } } }); log("wake " + id + " failed: " + err); }
  else log("wake " + id);
  return err;
}
function wakeTick() {
  const now = Date.now();
  for (const [id, s] of Object.entries(doc[0].sessions || {})) {
    const every = Number(s && s.wakeEvery) || 0;
    if (!s || s.kind === "note" || every < 5) continue;
    if (now < (Number(s.lastWakeAt) || 0) + every * 60_000) continue;
    fireWake(id, true);
  }
}
setInterval(wakeTick, 60_000).unref();
setTimeout(() => { if (!(doc[0].towerFeatures || {}).wake) apply({ towerFeatures: { wake: 1 } }); }, 0);

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
apply({ owner: process.env.AIRPORT_OWNER || null }); // whose airport: the 🧭 briefing names them (unset = "the user")
fs.watchFile(HTML, { interval: 2000 }, () => {
  const v = hashHtml();
  if (v && v !== HTML_VER) { HTML_VER = v; apply({ pageVersion: v }); }
});

// ---------- account allowance (rate-limit headers on a 1-token probe) ----------
// The setup-token oauth scope can't read /api/oauth/usage, but every inference
// response carries anthropic-ratelimit-unified-* headers — so a minimal fable
// call per account IS the usage query (fable, not haiku: only a fable call
// reports the 7d_oi = fable-weekly bucket). Polled gently; doc.usage feeds the
// UI; a browser's ↻ sends {type:"usage-probe"} (≤1 per 90 s).
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
      // the whole unified-* family, verbatim — windows come and go per plan
      // (5h, 7d, maybe month/model someday); the UI discovers them from this.
      // JSON string, not an object: shelf-merge would keep stale keys alive.
      const all = {};
      for (const [k, v] of Object.entries(h)) {
        const m = /^anthropic-ratelimit-unified-(.+)$/.exec(k);
        if (m) all[m[1]] = String(v);
      }
      const entry = all["5h-utilization"] != null ? {
        five: num(all["5h-utilization"]),
        fiveReset: (num(all["5h-reset"]) || 0) * 1000 || null,
        seven: num(all["7d-utilization"]),
        sevenReset: (num(all["7d-reset"]) || 0) * 1000 || null,
        status: String(all["status"] || ""),
        hdrs: JSON.stringify(all),
        at: Date.now(), err: null,
      } : { at: Date.now(), err: "no usage headers (http " + res.statusCode + ")" };
      apply({ usage: { [String(i + 1)]: entry } });
    });
    req.on("error", (e) => apply({ usage: { [String(i + 1)]: { at: Date.now(), err: e.message } } }));
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.end(JSON.stringify({ model: "claude-fable-5", max_tokens: 1,
      system: [{ type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." }],
      messages: [{ role: "user", content: "hi" }] }));
  });
}
setInterval(() => fetchUsage(false), 10 * 60 * 1000);
setTimeout(() => fetchUsage(true), 3000);

// ---------- box meter: RAM · swap · claude processes ----------
// The tower's own machine (the box): /proc/meminfo + RSS of every claude (and codex)
// process on it — airport turns, other tools' turns, interactive sessions alike.
// NOT in the shelf doc (would rewrite airport-data.json every 10 s): a plain
// {type:"mem"} message to browsers — on connect, every 10 s while any are
// connected, and right when a turn starts/ends.
const { execFile } = require("child_process");
function memSample(cb) {
  const mi = {};
  try { for (const l of fs.readFileSync("/proc/meminfo", "utf8").split("\n")) { const m = l.match(/^(\w+):\s+(\d+)/); if (m) mi[m[1]] = +m[2] * 1024; } } catch (_) {}
  execFile("ps", ["-eo", "rss=,comm=,args="], { timeout: 5000, maxBuffer: 10e6 }, (err, out) => {
    const procs = { claude: { n: 0, rss: 0 }, codex: { n: 0, rss: 0 } };
    for (const l of String(out || "").split("\n")) {
      const m = l.trim().match(/^(\d+)\s+(\S+)\s*(.*)$/); if (!m) continue;
      const k = m[2] === "claude" || /claude-cli|\/bin\/claude(\s|$)/.test(m[3]) ? "claude"
        : m[2] === "codex" || /\/codex(\s|$)/.test(m[3]) ? "codex" : null;
      if (k) { procs[k].n++; procs[k].rss += +m[1] * 1024; }
    }
    cb({ type: "mem", at: Date.now(), host: process.env.AIRPORT_HOST_NAME || os.hostname().split(".")[0],
      total: mi.MemTotal || os.totalmem(), avail: mi.MemAvailable ?? os.freemem(),
      swapTotal: mi.SwapTotal || 0, swapFree: mi.SwapFree || 0, load: os.loadavg(), cpus: os.cpus().length, procs });
  });
}
const browsers = () => [...clients].filter((c) => c._role === "browser" && c.readyState === 1);
function pushMem(only) {
  const to = only ? [only] : browsers();
  if (!to.length) return;
  memSample((d) => { const s = JSON.stringify(d); for (const c of to) { try { c.send(s); } catch (_) {} } });
}
setInterval(() => pushMem(), 10_000).unref();

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
  if (req.method === "GET" && url.pathname.startsWith("/icon/")) {
    const id = url.pathname.slice(6).replace(/\.png$/, "");
    if (!safeId(id)) { res.writeHead(404); return res.end(); }
    try {
      const buf = fs.readFileSync(path.join(ICONS, id + ".png"));
      res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "public, max-age=31536000, immutable", "Access-Control-Allow-Origin": "*" });
      return res.end(buf);
    } catch (_) { res.writeHead(404); return res.end(); }
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
      if (url.pathname === "/icon") {
        const err = saveIcon(String(j.session || ""), j.png, j.meta);
        return err ? json(res, 400, { ok: false, error: err }) : json(res, 200, { ok: true });
      }
      if (url.pathname === "/pump") {
        let failed = null;
        routePump(String(j.id || ""), (e) => { failed = e; });
        return failed ? json(res, 409, { ok: false, error: failed }) : json(res, 200, { ok: true });
      }
      if (url.pathname === "/run") {
        let failed = null;
        const r = routeRun(String(j.id || ""), j.text, (e) => { failed = e; });
        return failed ? json(res, 409, { ok: false, error: failed }) : json(res, 200, { ok: true });
      }
      if (url.pathname === "/wake") {
        const err = fireWake(String(j.id || ""), false);
        return err ? json(res, 409, { ok: false, error: err }) : json(res, 200, { ok: true });
      }
      return json(res, 404, { ok: false, error: "unknown endpoint" });
    });
    return;
  }
  res.writeHead(404); res.end();
};

// TLS if certs given, plain HTTP otherwise
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
        const info = (m.info && typeof m.info === "object") ? { ...m.info } : {};
        // a limbo-aware crew reports flying (turns still running there) and pendingDone
        // (turns that ended while cut off — their run-done is next in its outbox)
        const flying = Array.isArray(info.flying) ? new Set(info.flying.map(String)) : null;
        const pendingDone = new Set(Array.isArray(info.pendingDone) ? info.pendingDone.map(String) : []);
        delete info.flying; delete info.pendingDone;
        clearTimeout(limboTimers[m.host]); delete limboTimers[m.host];
        const patch = { hosts: { [m.host]: Object.assign({ online: true, lastSeen: Date.now() }, info) } };
        patch.sessions = {};
        for (const [id, s] of Object.entries(doc[0].sessions || {})) {
          if (!s || s.host !== m.host || !(s.state === "offline" || s.running)) continue;
          if (flying && s.running && flying.has(id)) { patch.sessions[id] = { state: "processing" }; continue; } // still in the air
          patch.sessions[id] = { state: "ready", running: false };   // runnable again
          if (flying && s.running && !pendingDone.has(id))            // the crew restarted: that turn died with it
            addBox(id, "tool", "✗ ground crew restarted mid-turn — this run was lost (work already on disk is kept; ⚡ to continue)", { synced: true, err: true });
        }
        apply(patch);
        setTimeout(() => kickQueues(m.host), 1000); // parked queues on this airfield can fly again
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
      if (ws._role === "browser") pushMem(ws);
      return;
    }

    if (!authed) return;

    if (m.type === "update" && m.patch && typeof m.patch === "object") {
      const before = { ...(doc[0].sessions || {}) };
      apply(m.patch);
      reapDeleted(before);
      return;
    }
    if (m.type === "usage-probe" && ws._role === "browser") { // header ↻: probe now (at most once per 90 s)
      if (Date.now() - lastUsageFetch >= 90_000) fetchUsage(true); // throttled = no-op; the UI's spinner times out
      return;
    }
    if (m.type === "addbox" && typeof m.session === "string" && typeof m.text === "string") {
      const role = ws._role === "host" ? String(m.role || "ai") : "user";
      if (!["user", "ai", "tool"].includes(role)) return;
      addBox(m.session, role, m.text.slice(0, 64 * 1024), m.extra && typeof m.extra === "object" ? m.extra : {});
      return;
    }
    // ⏭ queue: flying → stow the box marked queued (auto-runs when the turn lands
    // cleanly); not flying (it landed meanwhile) → just an ordinary ⚡ run
    if (m.type === "queue" && ws._role === "browser" && typeof m.session === "string" && typeof m.text === "string" && m.text.trim()) {
      const s = sess(m.session);
      if (!s) return;
      if (s.running) { addBox(m.session, "user", m.text.trim().slice(0, 64 * 1024), { queued: true }); return; }
      routeRun(m.session, m.text, (error) => {
        try { ws.send(JSON.stringify({ type: "run-failed", session: m.session, error })); } catch (_) {}
      });
      return;
    }
    if (m.type === "pump" && ws._role === "browser" && typeof m.session === "string") {
      routePump(m.session, (error) => {
        try { ws.send(JSON.stringify({ type: "run-failed", session: m.session, error })); } catch (_) {}
      });
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
      // sweep: the transcript now reflects the boxes this run CARRIED (runBoxKeys).
      // Unsynced user boxes added mid-flight (⏭ queue, ＋ box) were never seen by the
      // run: they stay pending, and since the run kept appending ai/tool boxes after
      // them, they're re-keyed to the tail so they're the next prompt (not history).
      // A pre-runBoxKeys run (tower restarted mid-flight) falls back to sweep-all.
      const sent = Array.isArray(s.runBoxKeys) ? new Set(s.runBoxKeys) : null;
      const sweep = {};
      const all = orderedBoxes(s), left = [];
      for (const b of all) {
        if (b.synced) continue;
        const carried = !sent || sent.has(b.key);
        if (carried && !m.unsent) sweep[b.key] = b.queued ? { synced: true, queued: null } : { synced: true };
        else if (b.role === "user") left.push(b); // mid-flight box, or a daemon bounce (the CLI never saw it): stays pending
      }
      const atTail = left.every((b, i) => all[all.length - left.length + i].key === b.key);
      if (left.length && !atTail) {
        let n = parseInt(all[all.length - 1].key.slice(1), 10);
        for (const b of left) {
          const { key, ...box } = b;
          sweep[key] = null;
          sweep["m" + String(++n).padStart(6, "0")] = box;
        }
      }
      const queuedLeft = left.filter((b) => b.queued).length;
      // dirty clears only when this run actually reconciled it (a rebuild), or it
      // was never set — a delete/edit landing MID-flight must survive this sweep
      const patch = { running: false, state: "ready", lastRunEndedAt: Date.now(),
        turns: (s.turns || 0) + 1, dirty: !!(s.dirty && !m.synthed), messages: sweep };
      if (m.trimConsumed) patch.trim = null;
      // any completed run that didn't consume the trim may have grown the
      // transcript past the cut (zap landed mid-flight, or an old daemon that
      // doesn't know trim) — a stale cut would eat newer turns, so rebuild
      // instead. Failed runs keep the trim: the early bounces (cap busy, cwd
      // error) never touched the CLI, and new daemons report consumption
      // explicitly even for failures.
      else if (s.trim && !m.failed) { patch.trim = null; patch.dirty = true; }
      if (m.token) patch.lastToken = Number(m.token);
      if (m.claudeSessionId) { patch.claudeSessionId = m.claudeSessionId; patch.sidHost = m.sidHost || s.host; }
      // a successful fork turn consumed forkNext (the daemon reported the NEW sid);
      // a failed one keeps it so the next ⚡ re-attempts the branch (never appends to the parent)
      if (s.forkNext) patch.forkNext = m.failed ? true : null;
      if (m.stats) {
        patch.lastCost = m.stats.cost == null ? null : m.stats.cost; patch.lastMs = m.stats.ms || 0;
        if (m.stats.total) patch.costTotal = m.stats.total; // the CLI's running total for this transcript
        patch.totalTokens = m.stats.ctx || 0;
        patch.hotUntil = Date.now() + HOT_MS;
        // pin the run's stats on its last ai box (per-box statline in the UI)
        if (m.stats.ms || m.stats.cost || m.stats.total) {
          const bs = orderedBoxes(s);
          for (let i = bs.length - 1; i >= 0; i--) if (bs[i].role === "ai") {
            patch.messages[bs[i].key] = Object.assign({}, patch.messages[bs[i].key],
              { stats: { ms: m.stats.ms || 0, cost: m.stats.cost == null ? null : m.stats.cost, total: m.stats.total || 0, v: 2, out: m.stats.out || 0,
                         cread: m.stats.cread || 0, cwrite: m.stats.cwrite || 0 } });
            break;
          }
        }
      }
      patch.lastError = m.failed ? String(m.error || "failed") : null;
      patch.runBoxKeys = null;
      // queued boxes fly next only after a clean landing; a failed/◼ interrupted
      // turn holds them (still marked ⏭ queued) until you ⚡
      patch.queueWait = queuedLeft && m.failed ? "held — the last turn " + (s.stopping ? "was stopped" : "failed") + "; ⚡ sends the queue" : null;
      patch.stopping = null;
      apply({ sessions: { [m.session]: patch } });
      if (queuedLeft && !m.failed) setImmediate(() => autoRun(m.session));
      setImmediate(() => kickQueues(s.host)); // a slot freed on this airfield
      fetchUsage(false); // refresh the allowance gauge after a turn (throttled)
      setTimeout(() => pushMem(), 1500); // its claude process is gone — let the meter see it
      return;
    }
    if (m.type === "interrupt" && ws._role === "browser" && typeof m.session === "string") {
      if (sess(m.session) && sess(m.session).running) apply({ sessions: { [m.session]: { stopping: true } } });
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
      try { host.send(JSON.stringify({ type: "fs", reqId: m.reqId, session: m.session, cwd: s.cwd || "", op: m.op, rel: m.rel || "", text: m.text, b64: m.b64, ifAbsent: m.ifAbsent, sub: m.sub, hash: m.hash })); }
      catch (_) { fsWaiters.delete(m.reqId); bounce("host send failed"); }
      return;
    }
    // ---- terminals: browser <-> the session's ground crew, tower relays ----
    if (m.type === "term" && ws._role === "browser" && typeof m.termId === "string" && m.termId.length <= 24) {
      if (m.action === "open" && typeof m.session === "string") {
        const s = sess(m.session);
        const bounce = (error) => { try { ws.send(JSON.stringify({ type: "term-exit", termId: m.termId, error })); } catch (_) {} };
        if (!s) return bounce("no such session");
        const host = hostSocket(s.host);
        if (!host) return bounce("ground crew offline");
        termOwners.set(m.termId, { ws, hostName: s.host });
        try { host.send(JSON.stringify({ type: "term", action: "open", termId: m.termId, session: m.session, cwd: s.cwd || "", cols: m.cols, rows: m.rows })); }
        catch (_) { termOwners.delete(m.termId); bounce("host send failed"); }
        return;
      }
      const o = termOwners.get(m.termId);
      if (!o || o.ws !== ws) return;
      const host = hostSocket(o.hostName);
      if (host) { try { host.send(JSON.stringify({ type: "term", action: m.action === "kill" ? "kill" : "in", termId: m.termId, data: typeof m.data === "string" ? m.data.slice(0, 16384) : undefined })); } catch (_) {} }
      if (m.action === "kill") termOwners.delete(m.termId);
      return;
    }
    if ((m.type === "term-data" || m.type === "term-exit") && ws._role === "host" && typeof m.termId === "string") {
      const o = termOwners.get(m.termId);
      if (o && o.ws.readyState === 1) { try { o.ws.send(JSON.stringify(m)); } catch (_) {} }
      if (m.type === "term-exit") termOwners.delete(m.termId);
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
    // reap this browser's terminals on the daemons
    for (const [tid, o] of termOwners) {
      if (o.ws !== ws) continue;
      const host = hostSocket(o.hostName);
      if (host) { try { host.send(JSON.stringify({ type: "term", action: "kill", termId: tid })); } catch (_) {} }
      termOwners.delete(tid);
    }
    if (ws._role === "host" && ws._host && !hostSocket(ws._host)) {
      const patch = { hosts: { [ws._host]: { online: false, lastSeen: Date.now() } }, sessions: {} };
      let limbo = false;
      for (const [id, s] of Object.entries(doc[0].sessions || {})) {
        if (!s || s.host !== ws._host || s.state === "offline") continue;
        // running planes keep running (limbo) — the crew may just be reconnecting; armLimbo
        // declares them lost (visibly) only if it stays silent past the grace period
        if (s.running) { limbo = true; patch.sessions[id] = { state: "offline" }; }
        else patch.sessions[id] = { state: "offline", running: false };
      }
      apply(patch);
      if (limbo) armLimbo(ws._host);
      // its PTYs died with it (a superseded socket keeps the daemon process — and
      // its terminals — alive, so this runs only when the host is truly gone)
      for (const [tid, o] of termOwners) {
        if (o.hostName !== ws._host) continue;
        try { o.ws.send(JSON.stringify({ type: "term-exit", termId: tid, error: "ground crew offline" })); } catch (_) {}
        termOwners.delete(tid);
      }
      log(`ground crew '${ws._host}' gone — its sessions offline`);
    }
  });

  ws.on("error", (e) => log(`ws err peer=${peerId}: ${e.message}`));
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") log(`port ${PORT} bound — old tower still up`);
  else log(`server error: ${err.message}`);
});
// "::" = dual-stack: IPv6 natively, IPv4 via mapped addresses (Linux/macOS
// default). IPv6-only client paths (phone hotspots on modern carriers) need
// this plus an AAAA record. AIRPORT_BIND=0.0.0.0 restores the v4-only bind.
const BIND = process.env.AIRPORT_BIND || "::";
server.listen(PORT, BIND, () => {
  const ss = doc[0].sessions || {};
  log(`✈ airport tower ${VERSION} on ${CERT ? "https" : "http"}://[${BIND}]:${PORT} — ${Object.keys(ss).length} session(s), auth ${PASS ? "ON" : "OFF (open)"}, data ${DATA}`);
});

process.on("SIGINT", () => { try { fs.writeFileSync(DATA, JSON.stringify(doc)); } catch (_) {} process.exit(0); });
process.on("SIGTERM", () => { try { fs.writeFileSync(DATA, JSON.stringify(doc)); } catch (_) {} process.exit(0); });
