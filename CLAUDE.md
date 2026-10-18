# Working on airport

This directory is a git checkout of the public repo github.com/dglittle/airport, and on a live box it's also the running copy. Edits here can affect live sessions.

- **Public repo: nothing personal or secret goes in.** Settings and secrets live in `~/.airport/.env` (outside the repo). Runtime data (`airport-data.json`, `icons/`) and `*.bak*` files are gitignored. If something specific to one person or one machine has to be configurable, make it an env setting (like `AIRPORT_OWNER`) with a neutral default.
- **Commit small and often, then push.** Git is the backup now. A box may run a pre-commit hook (not in the repo) that blocks personal or secret strings; if it fires, fix the content rather than bypassing it.
- **Test on a scratch tower first,** never the live one: another port, with `AIRPORT_STATE_DIR` and `AIRPORT_DATA` under `/tmp` (copy the data file there). Clear inherited env (`AIRPORT_PASS`, `AIRPORT_TLS_*`, `AIRPORT_URL`), because a turn launched by a daemon inherits the daemon's `.env`.
- **What takes effect when:**
  - `airport.html` is hot: the tower serves it live on save and open pages reload, so a broken save breaks every open page.
  - `server.js` and `daemon.js` need a restart. A tower restart is safe for running turns (daemons buffer in an outbox and report back). A daemon restart kills its running turns, so restart only when nothing is flying.
- **Keep the README in step** with the features and the doc shape.
