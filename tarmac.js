#!/usr/bin/env node
// tarmac.js — a plain CLI over the airport tower, e.g. for a plane that oversees other planes.
// Reads AIRPORT_PASS / AIRPORT_PORT / AIRPORT_URL from the env or ~/.airport/.env (env wins);
// AIRPORT_URL defaults to http://localhost:<port> (set it when the tower runs TLS on a real hostname).
//
//   node ~/airport/tarmac.js ls                     every plane: state, age, last words
//   node ~/airport/tarmac.js show <id> [n]          its last n user/ai boxes (default 6)
//   node ~/airport/tarmac.js say <id> <text…>       add a user box and fly it (fails if flying)
//   node ~/airport/tarmac.js wake <id>              fire its ⏰ wake now (pump planes pump)
//   node ~/airport/tarmac.js new <id> --title T --emoji E [--cwd DIR] [--model M]
//                                [--host H] [--sys FILE] [--wake MIN] [--pump TEXT] [--text FIRST]
//                                                   create a plane (and fly it if --text)
//   node ~/airport/tarmac.js set <id> key=value …   patch plane params (numbers/true/false/null parsed)
//   node ~/airport/tarmac.js usage                  5h / 7d use per account
//   node ~/airport/tarmac.js queue <id> <text…>     ⏭ queue a message if it's flying, else fly it now
//   node ~/airport/tarmac.js ember <tile> <url> [--owner PLANE] [--title T] [--emoji E]
//                                                   put an ember (github.com/dglittle/ember) on the tarmac;
//                                                   its new `tell` messages go to --owner as user turns
//   node ~/airport/tarmac.js ember <tile> stop|pause|resume     steer it
//
// The tower owns everything; this is just HTTP: GET /doc, POST /update, /run, /wake, /queue, /ember.
const fs = require("fs"), os = require("os"), path = require("path");
let env = ""; try { env = fs.readFileSync(path.join(process.env.AIRPORT_STATE_DIR || path.join(os.homedir(), ".airport"), ".env"), "utf8"); } catch (_) {}
const conf = (k, d) => process.env[k] || (new RegExp("^" + k + "=(\\S+)", "m").exec(env) || [])[1] || d;
const PASS = conf("AIRPORT_PASS", "");
const PORT = conf("AIRPORT_PORT", "7800");
const BASE = conf("AIRPORT_URL", `http://localhost:${PORT}`).replace(/\/+$/, "");
const [cmd, id, ...rest] = process.argv.slice(2);

const post = (p, body) => fetch(BASE + p, { method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ pass: PASS, ...body }) }).then((r) => r.json());
const getDoc = () => fetch(BASE + "/doc?pass=" + encodeURIComponent(PASS)).then((r) => r.json()).then((j) => j.doc[0]);
const ago = (t) => { if (!t) return "never"; const m = Math.round((Date.now() - t) / 60000);
  return m < 60 ? m + "m" : m < 2880 ? Math.round(m / 60) + "h" : Math.round(m / 1440) + "d"; };
const boxes = (s) => Object.keys(s.messages || {}).sort().map((k) => s.messages[k]);
const one = (t, n) => String(t || "").replace(/\s+/g, " ").trim().slice(0, n);
function flags(a) { const o = {}; for (let i = 0; i < a.length; i++) if (a[i].startsWith("--")) o[a[i].slice(2)] = a[i + 1], i++; return o; }

(async () => {
  if (cmd === "ls") {
    const d = await getDoc();
    const rows = Object.entries(d.sessions || {}).filter(([, s]) => s && !s.kind)
      .sort(([, a], [, b]) => (b.lastRunEndedAt || b.createdAt || 0) - (a.lastRunEndedAt || a.createdAt || 0));
    for (const [k, s] of Object.entries(d.sessions || {}).filter(([, s]) => s && s.kind === "ember")) {
      const e = s.em || {}, st = e.conn && e.conn !== "connecting" ? "unreachable (" + e.conn + ")" : e.stalled ? "stalled" : e.status || "connecting";
      console.log(`${s.emoji || e.emoji || "🔥"} ${k} — ember "${s.title || e.title || k}" · ${st}${e.total ? " · " + (e.done || 0) + "/" + e.total : ""}${e.msg ? " · " + one(e.msg, 80) : ""}${e.usd != null ? " · $" + Number(e.usd).toFixed(2) : ""} · tells → ${s.owner || "(the ember's owner)"}`);
    }
    for (const [k, s] of rows) {
      const bs = boxes(s), lastAi = [...bs].reverse().find((b) => b.role === "ai");
      const pend = (() => { let n = 0; for (let i = bs.length - 1; i >= 0 && bs[i].role === "user" && !bs[i].synced; i--) n++; return n; })();
      const flags = [s.running ? "✈ FLYING " + ago(s.startedAt) : "", s.wakeEvery ? "⏰" + s.wakeEvery + "m" : "",
        s.pumpText ? "⛽" : "", pend ? "pending:" + pend : "", s.wakeWait || s.queueWait || ""].filter(Boolean).join(" ");
      const online = (d.hosts || {})[s.host]?.online ? "" : " (offline)";
      console.log(`${s.emoji || "·"} ${k} — "${s.title || k}" · ${s.host}${online} · ${s.model || "?"} · landed ${ago(s.lastRunEndedAt)} ago · turns ${s.turns || 0} · $${(s.costTotal || 0).toFixed(2)} ${flags}`);
      console.log(`    cwd ${s.cwd || "?"}`);
      if (lastAi) console.log(`    last: ${one(lastAi.text, 220)}`);
    }
  } else if (cmd === "show") {
    const s = (await getDoc()).sessions[id]; if (!s) throw new Error("no plane " + id);
    const n = Number(rest[0]) || 6;
    const { messages, systemPrompt, ...p } = s;
    console.log(JSON.stringify({ ...p, systemPrompt: one(systemPrompt, 300) }));
    for (const b of boxes(s).filter((b) => b.role === "user" || b.role === "ai").slice(-n))
      console.log(`\n--- ${b.role}${b.synced ? "" : " (pending)"} · ${new Date(b.ts).toISOString().slice(0, 16)}Z\n${String(b.text || "").slice(0, 4000)}`);
  } else if (cmd === "say") {
    console.log(JSON.stringify(await post("/run", { id, text: rest.join(" ") })));
  } else if (cmd === "wake") {
    console.log(JSON.stringify(await post("/wake", { id })));
  } else if (cmd === "new") {
    if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(id || "")) throw new Error("id: lowercase letters, digits, dashes");
    const d = await getDoc(); if (d.sessions[id]) throw new Error("plane exists: " + id);
    const f = flags(rest);
    const cwd = f.cwd || path.join(os.homedir(), "airport-sessions", id);
    fs.mkdirSync(cwd, { recursive: true });
    const p = { title: f.title || id, emoji: f.emoji || "🛩", host: f.host || Object.keys(d.hosts || {}).find((h) => d.hosts[h].online) || "", cwd, model: f.model || "claude-opus-5-5",
      x: 0.15 + Math.random() * 0.7, y: 0.15 + Math.random() * 0.6, createdAt: Date.now(), state: "ready",
      useMemory: false, useSkills: false, dirty: false, turns: 0, messages: {}, createdBy: "tarmac" };
    if (f.sys) { p.systemPrompt = fs.readFileSync(f.sys, "utf8"); p.systemMode = "append"; }
    if (f.wake) p.wakeEvery = Number(f.wake);
    if (f.pump) p.pumpText = f.pump;
    console.log("update", JSON.stringify(await post("/update", { patch: { sessions: { [id]: p } } })));
    if (f.text) console.log("run", JSON.stringify(await post("/run", { id, text: f.text })));
  } else if (cmd === "set") {
    const p = {};
    for (const kv of rest) { const i = kv.indexOf("="); const k = kv.slice(0, i), v = kv.slice(i + 1);
      p[k] = v === "null" ? null : v === "true" ? true : v === "false" ? false : /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v; }
    console.log(JSON.stringify(await post("/update", { patch: { sessions: { [id]: p } } })));
  } else if (cmd === "queue") {
    console.log(JSON.stringify(await post("/queue", { id, text: rest.join(" ") })));
  } else if (cmd === "ember") {
    if (["stop", "pause", "resume"].includes(rest[0])) { console.log(JSON.stringify(await post("/ember", { id, action: rest[0] }))); return; }
    const url = rest[0];
    if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(id || "")) throw new Error("tile id: lowercase letters, digits, dashes");
    if (!/^https:\/\/\S+$/.test(url || "")) throw new Error("usage: ember <tile> <https url> [--owner PLANE] | ember <tile> stop|pause|resume");
    const d = await getDoc();
    if (!(d.towerFeatures || {}).ember) throw new Error("this tower doesn't know embers yet (restart it)");
    if (d.sessions[id]) throw new Error("tile exists: " + id);
    const f = flags(rest.slice(1));
    if (f.owner && !(d.sessions[f.owner] && !d.sessions[f.owner].kind)) throw new Error("no plane " + f.owner);
    const p = { kind: "ember", url, emTold: Date.now(), x: 0.15 + Math.random() * 0.7, y: 0.15 + Math.random() * 0.6, createdAt: Date.now(), createdBy: "tarmac" };
    if (f.owner) p.owner = f.owner;
    if (f.title) p.title = f.title;
    if (f.emoji) p.emoji = f.emoji;
    console.log("update", JSON.stringify(await post("/update", { patch: { sessions: { [id]: p } } })));
  } else if (cmd === "usage") {
    const d = await getDoc();
    for (const [k, u] of Object.entries(d.usage || {}))
      console.log(`account ${k}: 5h ${u.five == null ? "?" : Math.round(u.five * 100) + "%"} · 7d ${u.seven == null ? "?" : Math.round(u.seven * 100) + "%"} · checked ${ago(u.at)} ago${u.err ? " · " + u.err : ""}`);
  } else {
    console.log(fs.readFileSync(__filename, "utf8").split("\n").filter((l) => l.startsWith("//")).slice(0, 21).join("\n"));
  }
})().catch((e) => { console.error("tarmac: " + e.message); process.exit(2); });
