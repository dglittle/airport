# Synthetic sessions — fabricating transcripts that `claude -p --resume` accepts

(Carried over from marina, where this was verified 2026-07-12 on claude 2.1.198,
Mac; corral ran the same recipe on 2.1.207. This is what `daemon.js`'s
`synthTranscript()` implements.)

A session file written from scratch — never touched by Claude Code — resumes
perfectly, including fabricated tool_use/tool_result pairs.

## The recipe

1. **File:** `~/.claude/projects/<mangled-cwd>/<session-uuid>.jsonl`
   — mangling: non-alphanumerics in the absolute cwd path → `-`
   (`/Users/x/sessions/test` → `-Users-x-sessions-test`).
2. **Records** (one JSON per line), chained by `uuid`/`parentUuid`
   (first record's `parentUuid: null`), all carrying the same `sessionId`
   (= filename), `cwd`, `timestamp`, `version`, `userType:"external"`:
   - `user`: `{type:"user", message:{role:"user", content:<str or blocks>}}`
   - `assistant`: `{type:"assistant", requestId, message:{model, id,
     type:"message", role:"assistant", content:[{type:"text",text}…],
     stop_reason, usage, …}}`
   - tool calls: assistant content block `{type:"tool_use", id, name, input}` +
     a following `user` record whose content is `[{type:"tool_result",
     tool_use_id, content:[…]}]`. **Pairs must balance.**
   - `usage` and ids (`msg_…`, `req_…`, `toolu_…`) can be minimal/fabricated.
3. **Resume:** run with cwd = the session's cwd:
   `claude -p --resume <uuid> "next message"` (all normal flags apply).

## The system prompt is NOT in the transcript

It's rebuilt on every invocation from Claude Code's own prompt + the cwd's
CLAUDE.md + `--append-system-prompt` / `--system-prompt`. So: the messages go
in the file, the system prompt goes on the resume command line — and can
differ per turn.

## Gotchas

- **Internal format** — a CLI update can break it; re-verify on upgrades.
- A fabricated history is **cache-cold**: the first resumed turn pays full
  input tokens.
- After a resumed `-p` turn, the CLI writes records back and mints a NEW
  session id for continuation (the tower tracks that via `run-done`).
- Extra record types (`queue-operation`, `file-history-snapshot`, `ai-title`,
  `mode`, `attachment`, sidechains) are optional — resume works without them.

## Cache economics (measured 2026-07-12, claude 2.1.198, fable-5)

| scenario | cache_creation | cache_read |
|---|---|---|
| fresh synthetic session, first resume | 8,073 | 17,556 |
| content-identical history, NEW session id | 8,072 | 17,556 |
| forked file, sessionIds rewritten to new id | 8,176 | 17,556 |
| pure byte-copy, new filename only | 8,198 | 17,556 |
| re-resume the SAME id | **98** | **25,629** |
| fabricated in-place append + resume SAME id | **75** | **25,727** |

Read as: ~17.5k = Claude Code's shared system prefix (caches across ALL
sessions); ~8k = the session-scoped request prefix.

**The law: cache reuse follows the SESSION ID, not the file content.** No
cross-session-id construction hits the session-scoped cache — not even a pure
byte-copy. But under the SAME id, everything hits: re-resumes are ~free, and
in-place fabricated appends keep the full cache hit.

**Design rule for airport:** build and edit sessions IN PLACE under a stable
session id. Appending history = cheap. Editing EARLY history invalidates cache
from the edit point onward but keeps the same-id prefix before it. Minting a
new id costs one ~8k+history cold read — fine as a one-time import (that's
what flying a session between machines costs), wasteful as a per-turn pattern.
Cache TTL: 1h (the CLI uses ephemeral_1h on subscription).
