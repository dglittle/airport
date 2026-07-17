# recreating yourself at the airport

You are a Claude session (VS Code / terminal). These instructions register THIS
conversation as a plane in **airport** — the claude-sessions dashboard — so it
can be viewed, edited, and continued from there (phone included).

## how it works

The tower holds one shelf doc: `{sessions: {id: {host, cwd, model,
claudeSessionId, sidHost, messages: {m000001: {role, text, ts, synced}}, ...}}}`.
Your conversation already lives in a transcript file at
`~/.claude/projects/<cwd with [/._]→"-">/<session-uuid>.jsonl`.
To recreate yourself you POST a patch that:

- sets `claudeSessionId` to your own session uuid and `cwd` to your **realpath'd**
  cwd (macOS `/tmp` is a symlink — airport resumes by resolved path),
- sets `host` AND `sidHost` to this machine's airfield name (the daemon only
  resumes your id if the session last ran here; a wrong `sidHost` makes the
  first ⚡ rebuild from the mirror instead of resuming your real context),
- mirrors your user/ai turns into `messages` (display only — mark them
  `synced: true` so airport doesn't re-send them as a prompt),
- keeps `dirty` false (dirty would make airport REBUILD the transcript from the
  mirror and lose your real context: thinking, tool results, the works).

When someone hits ⚡ on your plane, airport runs
`claude -p "<new box>" --resume <your-session-id>` in your cwd, on this machine.

## the script — run this in your session's cwd

```bash
node - <<'EOF'
const fs = require("fs"), path = require("path"), os = require("os");
const BASE = process.env.AIRPORT_URL || "http://localhost:7800";
const PASS = process.env.AIRPORT_PASS || "";
const HOST = process.env.AIRPORT_HOST ||
  os.hostname().split(".")[0].toLowerCase().replace(/[^a-z0-9-]+/g, "-").slice(0, 32);
const cwd = fs.realpathSync(process.cwd());
const dir = path.join(os.homedir(), ".claude", "projects", cwd.replace(/[\/._]/g, "-"));
// newest jsonl in the project dir = the session being written right now = you
const file = fs.readdirSync(dir).filter(f => f.endsWith(".jsonl"))
  .map(f => ({ f, m: fs.statSync(path.join(dir, f)).mtimeMs }))
  .sort((a, b) => b.m - a.m)[0].f;
const sid = file.replace(".jsonl", "");
const lines = fs.readFileSync(path.join(dir, file), "utf8").split("\n").filter(Boolean)
  .map(l => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
let model = null; const turns = [];
for (const r of lines) {
  if (r.isMeta || r.isSidechain) continue;
  if (r.type === "user" && typeof r.message?.content === "string") turns.push(["user", r.message.content]);
  else if (r.type === "user" && Array.isArray(r.message?.content))
    turns.push(["user", r.message.content.filter(c => c.type === "text").map(c => c.text).join("\n")]);
  else if (r.type === "assistant") {
    model = r.message?.model || model;
    turns.push(["ai", (r.message?.content || []).filter(c => c.type === "text").map(c => c.text).join("\n")]);
  }
}
const msgs = {}; let n = 0;
for (const [role, text] of turns.slice(-300))          // keep the shelf light:
  if (text && text.trim()) msgs["m" + String(++n).padStart(6, "0")] =
    { role, text: text.slice(0, 8000), ts: Date.now() - (300 - n) * 60000, synced: true };
const id = (process.env.AIRPORT_ID || (path.basename(cwd).toLowerCase().replace(/[^a-z0-9]+/g, "-") + "-" + sid.slice(0, 4))).slice(0, 40);
const patch = { sessions: { [id]: {
  title: process.env.AIRPORT_TITLE || id, emoji: process.env.AIRPORT_EMOJI || "🛰",
  host: HOST, cwd, model, claudeSessionId: sid, sidHost: HOST, dirty: false,
  state: "ready", createdAt: Date.now(),
  x: Math.random() * 0.7 + 0.15, y: Math.random() * 0.6 + 0.15, messages: msgs,
} } };
fetch(BASE + "/update", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pass: PASS, patch }) })
  .then(r => r.json())
  .then(j => console.log(j.ok ? `registered as "${id}" on airfield "${HOST}" (${n} boxes, model ${model}) → ${BASE}` : "failed: " + JSON.stringify(j)))
  .catch(e => { console.error("tower unreachable at " + BASE + ": " + e.message); process.exit(1); });
EOF
```

Env knobs: `AIRPORT_URL` (if not localhost), `AIRPORT_PASS` (if the tower has
one), `AIRPORT_HOST` (airfield name — MUST match the daemon's
`AIRPORT_HOST_NAME` on this machine), `AIRPORT_ID` (plane id,
lowercase/dashes), `AIRPORT_TITLE`, `AIRPORT_EMOJI`. Example:

```bash
AIRPORT_ID=lead-audit AIRPORT_TITLE="lead audit" AIRPORT_EMOJI=🕵 node - <<'EOF' ...
```

All of these — plus model, cwd, tools, and a per-plane system prompt — can also
be changed later in the plane's "flight plan" card (top of its feed in the UI).

## verify

```bash
curl -s -m 2 "http://localhost:7800/doc?pass=$AIRPORT_PASS" | head -c 800   # your id should appear
```

Then open the tower URL — your plane is on the tarmac with your history.

## caveats — tell your human

- **Hand over the reins.** After registering, stop driving the conversation
  from this window. Airport appends to the same transcript on ⚡; two writers
  interleave badly. (Registering alone changes nothing — it's read-only.)
- **First ⚡ is a cold write.** Airport runs with its own system/tool flags, so
  your session's warm cache doesn't transfer; the first airport run re-writes
  the full context once, then airport runs are cache-hot (1h TTL).
- **The cwd must be inside the daemon's whitelist** (`AIRPORT_ROOTS` /
  `AIRPORT_SESS_ROOT`) — otherwise the first ⚡ remaps to a fresh hangar dir and
  synthesizes there instead of resuming you. Check the daemon's boot log.
- The box mirror is for reading/editing in the UI; it may include harness
  noise and skips tool traffic. Fine to prune boxes in the UI — but know that
  any edit/delete of synced boxes sets `dirty`, and the next ⚡ rebuilds the
  transcript from boxes (real context replaced by the mirror — sometimes
  that's exactly what you want, just know you're choosing it).
- Big sessions: the script keeps the last 300 turns, 8k chars each.
