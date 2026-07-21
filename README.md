# ✈ airport — every claude session, one airfield

A system for managing Claude sessions, built on one idea:

> **A session is just data** — a message history plus a bag of parameters
> (model, cwd, system prompt, allowed tools, and *which machine it runs on*).
> Everything is data manipulation — edit, fork, delete, drag around — until you
> hit ⚡, which executes **one turn** of `claude -p` on the session's machine.

Lineage: this is the merger of two earlier projects — **corral**
(`~/ergeon/corral`: the single-machine original, sessions as a shelf-synced CRUD
collection) and **marina** (`~/pima/projects/marina`: the multi-machine hub with
sailing, auth, and two-account failover). Airport takes the best of both.

## The shape

```
                    ┌── the UI (airport.html — served BY the tower, or open the file anywhere)
   phone/laptop ───▶│      browser speaks WS to the tower
                    ▼
   ┌────────────── TOWER (server.js — the always-on machine, e.g. Lightsail) ─────────────┐
   │  • the shelf doc OWNS every session: params + full message mirror                     │
   │  • single merge point: writers send unversioned patches, tower fans versioned deltas  │
   │  • routes ⚡ run / interrupt / fs to the session's ground crew                         │
   │  • persists to airport-data.json; serves the UI; optional passphrase + TLS            │
   └───────▲──────────────────────────▲──────────────────────────────▲─────────────────────┘
           │ dial-out WS              │ dial-out WS                   │ dial-out WS
   ┌───────┴────────┐        ┌────────┴───────┐              ┌────────┴───────┐
   │ GROUND CREW    │        │ GROUND CREW    │              │ GROUND CREW    │
   │ (daemon.js)    │        │ (daemon.js)    │              │ (daemon.js)    │
   │ mac laptop     │        │ the Lightsail  │              │ any other      │
   │                │        │ box itself     │              │ machine…       │
   └────────────────┘        └────────────────┘              └────────────────┘
```

- **Tower** (`server.js`) — one service on the always-on machine. Holds the
  sessions **shelf doc** (merged with the 75-line
  [shelf](https://github.com/dglittle/shelf) library), fans deltas to everyone,
  and relays runs/interrupts/file-ops down to the right machine.
- **Ground crew** (`daemon.js`) — one bare-bones daemon per machine. Dials OUT
  to the tower (laptops behind NAT need no inbound port), spawns
  `claude -p --resume` turns, streams events back as box patches. Generic by
  design: point it at a tower, give it a name, done.
- **UI** (`airport.html`) — the tarmac. Served by the tower at `/`.

## The tarmac (spatial memory contract)

The main view is a **square** (the apron). Sessions are planes parked on it at
x/y *fractions* of the square — and **every size on the apron is a fraction of
the square's side too** (a plane's disc is ⅛ of the side). So the field is
spatially IDENTICAL on your phone and your desktop: same places, same relative
sizes, just bigger on the big screen. Your spatial memory transfers exactly.

Drag to park, tap to board. Badges: amber pulse = flying (turn running), green
ring = cache-hot (ran within the 1h prompt-cache TTL), purple dot = landed
since you last looked, dimmed = its machine is offline.

## A session's life

- **Boxes.** The feed is `messages{m000001…}`: `user` / `ai` / `tool` boxes.
  `synced` means "the real transcript on disk already reflects this box".
- **⚡ run** = prompt is the trailing *unsynced user* boxes; the daemon resumes
  `claudeSessionId` when the history is clean AND the session last ran on this
  machine; otherwise it **synthesizes a fresh transcript** from the boxes (see
  [SYNTHETIC.md](SYNTHETIC.md)) and resumes that.
- **Editing or deleting synced history sets `dirty`** → the next ⚡ rebuilds the
  transcript from the boxes. You're choosing mirror-over-reality (the rebuilt
  transcript has only user/ai text — thinking and tool traffic don't survive);
  a ⟲ box notes it. Cost: one cold cache read.
- **Fork** (⑂) branches a session. When the parent is clean, it's a REAL fork:
  the first ⚡ runs `--resume <parent> --fork-session`, branching the actual
  transcript (tool results + thinking included) under a new session id — one
  cold cache write (session-scoped prompt cache follows the session id, so
  forks can't cache-hit the parent; measured on 2.1.207). If the parent has no
  resumable transcript (or edited history), it falls back to a mirror fork:
  `dirty` + text-only rebuild. **Delete** removes a session from the doc
  (transcript files stay on disk).
- **Flying** (marina's sailing): change the session's *airfield* in its flight
  plan — the next ⚡ rebuilds the transcript on the new machine (one cold read,
  🛬 box). A stored cwd that doesn't fit the target machine's whitelist remaps
  deterministically to `<sess-root>/<id>` WITHOUT touching the stored value —
  fly home and the original workshop is back.
- **File columns.** In landscape, each session gets explorer + file viewer
  columns rooted at its cwd (relayed tower→daemon), with a monaco editor and
  unsaved-edit drafts. Small images preview inline (base64 through the relay).
- **⎇ git view.** The explorer header's ⎇ flips the file column to git: the
  changed files (click one = monaco diff of HEAD vs working tree in the file
  view), then every commit with a VS-Code-style graph gutter (click one = its
  patch). 📁 flips back to files.
- **>_ terminal.** Inside a session, the header's `>_` swaps the feed for a
  live terminal on the session's machine, opened at its cwd. Real PTY via
  python3's pty module — macOS `script(1)` can't take node's socketpair stdio
  (util-linux `script -qfc` is the no-python fallback on linux). The tower
  reaps PTYs when the browser disconnects or the plane is closed.
- **Context checkboxes** (in the flight plan; all live-verified on claude
  2.1.207 — any change = cold cache next run):
  - **CLAUDE.md** (default OFF): adds the `project` setting source
    (`--setting-sources user,project`), which loads the cwd's CLAUDE.md — and
    with it project-level skills/settings/hooks (they ride together; there is
    no finer switch).
  - **memory** (default ON): the auto-memory feature (MEMORY.md under
    `~/.claude/projects/<cwd>/memory/`). Off = spawn with
    `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`. (Beware `--bare` and
    `CLAUDE_CODE_SIMPLE=1`: they also disable it but break subscription oauth.)
  - **skills** (default ON): off = `--disable-slash-commands`, which unlists
    ALL skills (user and project level).
- **🧭 briefing button** (composer): stows a stock user box that tells the
  session's Claude how airport drives it — turn mechanics, box mirror/rebuild
  rules, rendering, file delivery — templated with that plane's live setup
  (cwd, machine, model, context toggles). Like a skill, but it works even when
  the session runs with skills/CLAUDE.md off, and there's nothing to copy into
  each cwd. It's a pending box: stack your actual ask on top, then ⚡.

## Quickstart (single machine, no auth)

```bash
npm install          # just `ws`, for the tower
node server.js       # tower on http://localhost:7800
node daemon.js       # ground crew 'yourhostname' → ws://localhost:7800
```

Open <http://localhost:7800>, hit ＋, pick the airfield, go.

## Multi-machine (the real thing)

**Tower on the always-on box** (Lightsail):

```bash
# ~/.airport/.env on the box:
#   AIRPORT_PASS=<a good passphrase>
AIRPORT_TLS_CERT=/path/fullchain.pem AIRPORT_TLS_KEY=/path/privkey.pem node server.js
# e.g. inside a screen:  screen -dmS airport-tower node server.js   (env in ~/.airport/.env)
```

**Ground crew on every machine that should run sessions** (the box itself, each
laptop):

```bash
# ~/.airport/.env on each machine:
#   AIRPORT_SERVER=wss://your.box:7800
#   AIRPORT_PASS=<same passphrase>
#   AIRPORT_HOST_NAME=mac            # or box / mac2 / …
#   AIRPORT_ROOTS=~/pima:~/src       # optional extra cwd whitelist
node daemon.js
```

Browsers: open `https://your.box:7800`, type the passphrase once per device.

### Reboot-proofing

- **Mac laptop:** LaunchAgent — copy
  [deploy/com.airport.daemon.plist](deploy/com.airport.daemon.plist) to
  `~/Library/LaunchAgents/` (fix the paths inside), then
  `launchctl load ~/Library/LaunchAgents/com.airport.daemon.plist`.
  Starts at login, KeepAlive respawns it.
- **Linux box:** systemd units in [deploy/](deploy/) —
  `airport-tower.service` + `airport-daemon.service` (fix paths/user), or
  `@reboot` crontab lines with screens if that's your house style.

## Configuration

Env vars, or `KEY=VALUE` lines in `~/.airport/.env` (env wins):

| var | used by | default | meaning |
|---|---|---|---|
| `AIRPORT_PORT` | tower | `7800` | listen port |
| `AIRPORT_PASS` | both | *(unset = open)* | the one passphrase (browsers + daemons) |
| `AIRPORT_TLS_CERT` / `AIRPORT_TLS_KEY` | tower | *(unset = http)* | cert paths; watched + hot-reloaded |
| `AIRPORT_DATA` | tower | `./airport-data.json` | shelf doc persistence |
| `AIRPORT_SERVER` | daemon | `ws://localhost:7800` | tower URL (`http(s)://` also accepted) |
| `AIRPORT_HOST_NAME` | daemon | short hostname | this machine's airfield name |
| `AIRPORT_CLAUDE_BIN` | daemon | `claude` | the CLI |
| `AIRPORT_DEFAULT_MODEL` | daemon | `claude-fable-5` | when a session doesn't say |
| `AIRPORT_SESS_ROOT` | daemon | `~/airport-sessions` | where remapped cwds live |
| `AIRPORT_ROOTS` | daemon | *(none)* | extra cwd whitelist, colon-separated; `/` = allow everything |
| `AIRPORT_MAX_TURNS` | daemon | `2` | concurrent turn cap default; per-airfield override in the UI (⚙), applies live |
| `AIRPORT_TURN_TIMEOUT_MS` | daemon | `0` *(no limit)* | optional per-turn kill switch; ◼ stop is the manual brake |
| `AIRPORT_STATE_DIR` | both | `~/.airport` | `.env`, token state |
| `OPENAI_API_KEY` | tower | *(unset)* | enables ☁︎ whisper transcription |

## Two-account failover (the subscription-keys feature)

Both machines can hold **two** long-lived Claude subscription OAuth tokens
(`claude setup-token`) in `~/.airport/.env`:

```
CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-…    # primary account
CLAUDE_CODE_OAUTH_TOKEN_2=sk-ant-oat01-…  # fallback account
```

Every turn uses a **sticky account choice** (`~/.airport/token-state.json`): a
hard-failed turn matching the allowance/auth regex flips accounts, retries
once, and the winner sticks until it fails in turn. NOTE the limit-failure
shape (live-verified in marina): exit code 0, `subtype:"success"`, but
`is_error:true` with result text like "You've reached your … limit" — so
detection keys on a failed turn plus a deliberately broad regex.

No tokens configured = the machine's ambient `claude` login. `ANTHROPIC_API_KEY`
is always stripped from turn env — airport never bills cash by accident.

## Registering an existing session

A live Claude Code session (VS Code / terminal) can register ITSELF as a plane —
see [REGISTER.md](REGISTER.md). Its transcript stays where it is; airport
mirrors the turns and resumes the same session id on the next ⚡.

## Security (be loud about this)

The tower is a URL that can **type into Claude sessions running with full
permissions on your machines** — remote code execution as a feature. If it
leaves localhost:

1. Set a strong `AIRPORT_PASS` (it gates browsers, daemons, and every mutating
   HTTP endpoint). Rotate by changing it everywhere.
2. Run TLS (the tower supports it natively, certs hot-reload).
3. New-session cwds are whitelisted per machine (`AIRPORT_ROOTS` + the session
   root); anything else remaps into `AIRPORT_SESS_ROOT`. Don't whitelist `~`.
4. Turns run `--permission-mode dontAsk` with an explicit `--allowedTools`
   list (per-session editable) — mind what you allow.

## Protocol (for tinkering)

WS to the tower: `{type:"auth", role:"browser"|"host", pass, host?, info?}` →
`{type:"doc"}` then `{type:"delta"}` stream. Writers send
`{type:"update", patch}` (unversioned; the tower is the single merge point).
Browsers: `run` / `interrupt` / `addbox` / `fs`. Daemons: `addbox` /
`run-done` / `fs-res`. HTTP: `POST /update`, `POST /run` (curl-able), `GET
/doc`, `GET /health`, `POST /whisper`.

The doc:

```js
{ pageVersion, hosts: { mac: { online, lastSeen, roots, sessRoot, defaultModel, … } },
  sessions: { "<id>": {
    title, emoji, host, cwd, model, systemPrompt, systemMode, tools,   // the params
    x, y,                       // fractions of the apron square
    state, running, startedAt,  // ready | processing | offline
    claudeSessionId, sidHost, dirty,
    seenAt, lastRunEndedAt, hotUntil, turns, lastCost, lastMs, totalTokens, lastError,
    messages: { m000001: { role, text, ts, synced, stats } },
} } }
```

## Known edges

- Transcript synthesis uses Claude Code's **internal** jsonl format
  ([SYNTHETIC.md](SYNTHETIC.md)) — a CLI update can break it; re-verify on
  upgrades (last verified 2.1.198–2.1.207).
- The monaco editor and the terminal's xterm.js load from CDNs (needs internet
  in the browser). xterm is fetched + eval'd with `define` shadowed so its UMD
  build doesn't register into monaco's AMD loader.
- One daemon per machine name; a second connection with the same name
  supersedes the first.
- No remirror endpoint yet (corral had one): if a registered session keeps
  talking outside airport, the mirror falls behind — re-register to catch up.
