// airport ✂ auto-trim — shrink a plane's REAL context (its Claude Code transcript)
// by a chosen fraction, cheapest loss first. Pure functions over the jsonl text;
// daemon.js does the file I/O (backup, atomic rename, undo).
//
// What counts: the records on the live chain (parentUuid walk back from the newest
// user/assistant record, plus the parallel-tool-call results the CLI re-attaches;
// a compact boundary ends the walk). Everything from the 2nd-to-last turn's prompt
// on is PROTECTED (if that tail is over 35% of the context — one giant turn — the
// newest ~20% is). User and assistant TEXT is never touched. The hierarchy, each
// step only until the target is reached:
//   a. truncate   big old tool results → head + tail + "[✂ trimmed N chars …]"   (largest first)
//   b. remove     old tool results → "[✂ removed: <tool> result, N chars …]"     (oldest first)
//   c. thinking   drop old thinking blocks (signed, so all or nothing)           (oldest first)
//   d. collapse   long string fields in old tool calls' inputs                   (largest first)
// The file stays valid for `claude --resume`: tool_use/tool_result ids stay paired
// (contents change, blocks never vanish), thinking-only records are spliced out
// with their children re-parented, and every other record keeps its bytes.
//
// Sizes: tokens ≈ base + scale × Σ(chars × weight) + 1.6k per image, with `scale`
// fitted to the plane's last measured context. The weights are measured
// (claude-opus-5-5, CLI 2.1.302, 2026-11): per char, a thinking block's signature
// costs ~1/5 of a tool result, tool-call input JSON ~1.4×, prose ~0.6×.

const W = { results: 1, calls: 1.4, thinking: 0.2, text: 0.6, other: 0.6 };
const IMG_TOK = 1600;
const TRUNC_MIN = 4000;           // a result must be this long (chars) to be worth truncating
const KEEP_HEAD = 1200, KEEP_TAIL = 600;
const REMOVE_MIN = 300;           // smaller results aren't worth a removal note
const INPUT_MIN = 400, FIELD_MAX = 200, FIELD_KEEP = 120;
const STEPS = ["truncate", "remove", "thinking", "collapse"];

const textOf = (c) => typeof c === "string" ? c
  : Array.isArray(c) ? c.map((x) => (x && x.type === "text" ? x.text || "" : "")).join("\n") : "";
const charsOf = (c) => typeof c === "string" ? c.length
  : Array.isArray(c) ? c.reduce((a, x) => a + (!x || x.type === "image" ? 0 : x.type === "text" ? (x.text || "").length : JSON.stringify(x).length), 0) : 0;
const imagesOf = (c) => Array.isArray(c) ? c.filter((x) => x && x.type === "image").length : 0;
const fmtN = (n) => Math.round(n).toLocaleString("en-US");

// the page's box text for a tool call / tool result (daemon.js streams exactly
// these) — the tower finds a trimmed item's box by its text
function toolUseBoxText(c) {
  const inp = JSON.stringify(c.input || {});
  return `▸ ${c.name}  ${inp.length > 300 ? inp.slice(0, 300) + "…" : inp}`;
}
function toolResultBoxText(c) {
  let t = typeof c.content === "string" ? c.content : (c.content || []).map((x) => x.text || "").join("\n");
  if (t.length > 1500) t = t.slice(0, 1500) + `\n… [${t.length} chars]`;
  return t.trim() ? t : null;
}

function parse(text) {
  const raw = text.split("\n").filter((l) => l.trim());
  const recs = raw.map((l) => { try { return JSON.parse(l); } catch (_) { return null; } });
  const byUuid = new Map();
  recs.forEach((r, i) => { if (r && r.uuid) byUuid.set(r.uuid, i); });
  let leaf = -1;
  for (let i = recs.length - 1; i >= 0; i--) {
    const r = recs[i];
    if (r && (r.type === "user" || r.type === "assistant") && r.uuid && !r.isSidechain) { leaf = i; break; }
  }
  const chain = [], seen = new Set();
  for (let i = leaf; i >= 0 && !seen.has(i); ) {
    seen.add(i); chain.push(i);
    const p = recs[i].parentUuid;
    i = p && byUuid.has(p) ? byUuid.get(p) : -1;
  }
  // parallel tool calls: their results hang off the chain as leaf siblings, and the
  // CLI re-attaches them on load — so they count too
  const uses = new Set();
  for (const i of chain) { const c = recs[i].message && recs[i].message.content; if (recs[i].type === "assistant" && Array.isArray(c)) for (const b of c) if (b && b.type === "tool_use") uses.add(b.id); }
  recs.forEach((r, i) => {
    if (seen.has(i) || !r || r.type !== "user" || r.isSidechain || !byUuid.has(r.parentUuid) || !seen.has(byUuid.get(r.parentUuid))) return;
    const c = r.message && r.message.content;
    if (Array.isArray(c) && c.length && c.every((b) => b && b.type === "tool_result" && uses.has(b.tool_use_id))) { seen.add(i); chain.push(i); }
  });
  chain.sort((a, b) => a - b);
  return { raw, recs, chain };
}

// every trimmable item on the chain: its size (chars, weighted units, images) and age (chain position)
function inventory(P) {
  const { recs, chain } = P;
  const uses = new Map();
  for (const i of chain) {
    const r = recs[i];
    if (r.type === "assistant" && Array.isArray(r.message && r.message.content))
      for (const c of r.message.content) if (c && c.type === "tool_use") uses.set(c.id, c);
  }
  const items = [], br = { results: 0, calls: 0, thinking: 0, text: 0, other: 0 }, brImg = { results: 0, text: 0 };
  const prompts = [], cum = [];
  let units = 0;
  const add = (k, chars, img) => { const u = chars * W[k]; br[k] += u; if (img) brImg[k] += img; units += u; return u; };
  chain.forEach((i, pos) => {
    const r = recs[i], m = r.message;
    if (r.type === "user" && m) {
      if (typeof m.content === "string") add("text", m.content.length);
      else if (Array.isArray(m.content)) for (const [bi, c] of m.content.entries()) {
        if (!c) continue;
        if (c.type === "tool_result") {
          const chars = charsOf(c.content), img = imagesOf(c.content), u = uses.get(c.tool_use_id);
          items.push({ kind: "result", pos, rec: i, bi, chars, u: add("results", chars, img), img, tool: u ? u.name : "tool" });
        } else add("text", c.type === "image" ? 0 : charsOf([c]), c.type === "image" ? 1 : 0);
      }
      if (!r.isMeta && !r.isCompactSummary && (typeof m.content === "string" || (Array.isArray(m.content) && !m.content.some((c) => c && c.type === "tool_result"))))
        prompts.push(pos);
    } else if (r.type === "assistant" && m && Array.isArray(m.content)) {
      for (const [bi, c] of m.content.entries()) {
        if (!c) continue;
        if (c.type === "thinking" || c.type === "redacted_thinking") {
          const chars = (c.thinking || "").length + (c.signature || "").length + (c.data || "").length;
          items.push({ kind: "thinking", pos, rec: i, bi, chars, u: add("thinking", chars), img: 0, only: m.content.length === 1 });
        } else if (c.type === "tool_use") {
          const chars = JSON.stringify(c.input || {}).length;
          items.push({ kind: "use", pos, rec: i, bi, chars, u: add("calls", chars), img: 0, tool: c.name });
        } else add("text", c.type === "text" ? (c.text || "").length : JSON.stringify(c).length);
      }
    } else if (r.type === "attachment" && Array.isArray(r.rendered)) {
      // only the rendered part reaches the model (a prompt_snapshot, say, never does)
      add("other", r.rendered.reduce((a, x) => a + (typeof (x && x.content) === "string" ? x.content.length : JSON.stringify(x || "").length), 0));
    }
    cum.push(units);
  });
  // the protected tail: from the 2nd-to-last turn's prompt on — unless that's over
  // 35% of everything (one giant turn), then just the newest ~20%
  const before = (pos) => (pos > 0 ? cum[pos - 1] : 0);
  let guard = prompts.length >= 2 ? prompts[prompts.length - 2] : 0;
  if (units && units - before(guard) > units * 0.35) {
    guard = chain.length;
    while (guard > 0 && units - before(guard - 1) < units * 0.2) guard--;
    guard = Math.max(0, Math.min(guard - 1, chain.length - 20));
  }
  const lastPrompt = prompts.length ? prompts[prompts.length - 1] : 0;
  return { items, br, brImg, units, images: brImg.results + brImg.text, guard, lastPrompt, turns: prompts.length, keptUnits: units - before(guard) };
}

// fit `scale` (tokens per weighted unit) to the plane's last measured context;
// the base is the system prompt + tools, which aren't in the transcript
function calibrate(inv, ctxTokens) {
  const imgTok = inv.images * IMG_TOK;
  const base = ctxTokens ? Math.min(20000, ctxTokens * 0.3) : 20000;
  const fit = ctxTokens && inv.units ? (ctxTokens - base - imgTok) / inv.units : 0;
  const scale = fit > 0.15 && fit < 1.5 ? fit : 0.5;
  return { base, scale, tokens: ctxTokens || Math.round(base + imgTok + inv.units * scale), measured: !!ctxTokens };
}
const tokOf = (cal, u, img) => u * cal.scale + (img || 0) * IMG_TOK;

// the plan: which edits, in hierarchy order, reach `cutTok` tokens (no mutation)
function plan(P, inv, cal, cutTok) {
  const old = inv.items.filter((it) => it.pos < inv.guard);
  const edits = [], counts = { truncate: 0, remove: 0, thinking: 0, collapse: 0 }, saved = { truncate: 0, remove: 0, thinking: 0, collapse: 0 };
  let got = 0;
  const truncated = new Map(); // item -> its truncate edit
  const take = (e) => { edits.push(e); got += e.gain; counts[e.step]++; saved[e.step] += e.gain; return e; };
  // a. truncate the largest text-only results
  for (const it of old.filter((x) => x.kind === "result" && x.chars >= TRUNC_MIN && !x.img && !hasNonText(P, x)).sort((a, b) => b.chars - a.chars)) {
    if (got >= cutTok) break;
    truncated.set(it, take({ step: "truncate", it, gain: tokOf(cal, (it.chars - KEEP_HEAD - KEEP_TAIL - 80) * W.results) }));
  }
  // b. remove results, oldest first (a truncated one becomes a removal)
  for (const it of old.filter((x) => x.kind === "result").sort((a, b) => a.pos - b.pos)) {
    if (got >= cutTok) break;
    const full = tokOf(cal, Math.max(0, it.chars - 80) * W.results, it.img), tr = truncated.get(it);
    if (tr) {
      const more = full - tr.gain;
      counts.truncate--; saved.truncate -= tr.gain; counts.remove++; saved.remove += full;
      tr.step = "remove"; tr.gain = full; got += more;
      continue;
    }
    if (it.chars < REMOVE_MIN && !it.img) continue;
    take({ step: "remove", it, gain: full });
  }
  // c. thinking, oldest first (never in the newest turn)
  for (const it of old.filter((x) => x.kind === "thinking" && x.pos < inv.lastPrompt).sort((a, b) => a.pos - b.pos)) {
    if (got >= cutTok) break;
    if (it.only && !canSplice(P, it.rec)) continue;
    take({ step: "thinking", it, gain: tokOf(cal, it.u) });
  }
  // d. collapse the largest tool-call inputs
  for (const it of old.filter((x) => x.kind === "use" && x.chars >= INPUT_MIN).sort((a, b) => b.chars - a.chars)) {
    if (got >= cutTok) break;
    const after = JSON.stringify(collapseInput(P.recs[it.rec].message.content[it.bi].input, "")).length;
    if (it.chars - after < 100) continue;
    take({ step: "collapse", it, gain: tokOf(cal, (it.chars - after) * W.calls) });
  }
  return { edits, counts, saved, got, reached: got >= cutTok };
}
function hasNonText(P, it) {
  const c = P.recs[it.rec].message.content[it.bi].content;
  return Array.isArray(c) && c.some((x) => x && x.type !== "text");
}
// a thinking-only record can go if nothing but its children's parentUuid points at it
function canSplice(P, rec) {
  if (!P._refs) {
    P._refs = new Set();
    for (const r of P.recs) if (r) for (const [k, v] of Object.entries(r))
      if (k !== "uuid" && k !== "parentUuid" && typeof v === "string" && v.length === 36) P._refs.add(v);
  }
  return !P._refs.has(P.recs[rec].uuid);
}
function collapseInput(v, stamp) {
  if (typeof v === "string") return v.length > FIELD_MAX ? v.slice(0, FIELD_KEEP) + `…[✂ ${fmtN(v.length)} chars collapsed${stamp}]` : v;
  if (Array.isArray(v)) { const n = JSON.stringify(v).length; return n > FIELD_MAX ? `[✂ ${fmtN(n)} chars collapsed${stamp}]` : v; }
  if (v && typeof v === "object") { const o = {}; for (const [k, x] of Object.entries(v)) o[k] = collapseInput(x, stamp); return o; }
  return v;
}

// apply a plan → the new jsonl text + the marks the tower puts on the page's boxes
function apply(P, edits, when) {
  const stamp = ` on ${when}`;
  const recs = P.recs.slice();
  const dirty = new Set(), drop = new Set(), marks = [];
  const clone = (i) => { if (!dirty.has(i)) { recs[i] = JSON.parse(JSON.stringify(recs[i])); dirty.add(i); } return recs[i]; };
  for (const e of edits) {
    const it = e.it;
    if (e.step === "truncate" || e.step === "remove") {
      const orig = P.recs[it.rec].message.content[it.bi];
      const blk = clone(it.rec).message.content[it.bi];
      const t = textOf(orig.content), n = charsOf(orig.content);
      blk.content = e.step === "truncate"
        ? t.slice(0, KEEP_HEAD) + `\n\n[✂ trimmed ${fmtN(t.length - KEEP_HEAD - KEEP_TAIL)} chars${stamp} — airport auto-trim]\n\n` + t.slice(-KEEP_TAIL)
        : `[✂ removed: ${it.tool} result, ${fmtN(n)} chars${it.img ? ` + ${it.img} image(s)` : ""}${stamp} — airport auto-trim]`;
      const bt = toolResultBoxText(orig);
      if (bt) marks.push({ text: bt, mark: e.step === "truncate" ? "✂ trimmed" : "✂ removed", pos: it.pos });
    } else if (e.step === "thinking") {
      if (it.only) drop.add(it.rec);
      else clone(it.rec).message.content[it.bi] = null;
    } else if (e.step === "collapse") {
      const orig = P.recs[it.rec].message.content[it.bi];
      clone(it.rec).message.content[it.bi].input = collapseInput(orig.input, stamp);
      marks.push({ text: toolUseBoxText(orig), mark: "✂ input collapsed", pos: it.pos });
    }
  }
  for (const i of dirty) if (recs[i].message && Array.isArray(recs[i].message.content))
    recs[i].message.content = recs[i].message.content.filter((c) => c !== null);
  // splice out dropped thinking-only records: their children take their parent
  const reparent = new Map();
  for (const i of drop) reparent.set(P.recs[i].uuid, P.recs[i].parentUuid);
  const up = (u) => { while (reparent.has(u)) u = reparent.get(u); return u; };
  const out = [];
  recs.forEach((r, i) => {
    if (drop.has(i)) return;
    if (r && r.parentUuid && reparent.has(r.parentUuid)) { r = clone(i); r.parentUuid = up(r.parentUuid); }
    out.push(r && dirty.has(i) ? JSON.stringify(r) : P.raw[i]);
  });
  marks.sort((a, b) => a.pos - b.pos);
  return { text: out.join("\n") + "\n", marks: marks.map(({ text, mark }) => ({ text, mark })), dropped: drop.size };
}

// analyse a transcript: the breakdown + a plan per fraction (fracs of the measured context)
function analyse(text, ctxTokens, fracs) {
  const P = parse(text);
  if (!P.chain.length) throw new Error("no conversation found in the transcript");
  const inv = inventory(P), cal = calibrate(inv, ctxTokens);
  const plans = {};
  for (const f of fracs) {
    const p = plan(P, inv, cal, cal.tokens * f);
    plans[f] = { p, view: { frac: f, cut: Math.round(p.got), after: Math.max(0, Math.round(cal.tokens - p.got)), reached: p.reached, counts: p.counts,
      saved: Object.fromEntries(STEPS.map((s) => [s, Math.round(p.saved[s])])) } };
  }
  const R = (u, img) => Math.round(tokOf(cal, u, img));
  return {
    P, inv, cal, plans,
    summary: {
      tokens: cal.tokens, measured: cal.measured, base: Math.round(cal.base), turns: inv.turns,
      breakdown: { results: R(inv.br.results, inv.brImg.results), calls: R(inv.br.calls), thinking: R(inv.br.thinking),
        text: R(inv.br.text, inv.brImg.text), other: R(inv.br.other) },
      protected: R(inv.keptUnits),
      biggest: inv.items.filter((x) => x.pos < inv.guard && x.kind !== "thinking").sort((a, b) => tokOf(cal, b.u, b.img) - tokOf(cal, a.u, a.img)).slice(0, 5)
        .map((x) => ({ what: x.kind === "use" ? x.tool + " call" : x.tool + " result", tokens: R(x.u, x.img) })),
      plans: Object.values(plans).map((x) => x.view),
    },
  };
}

module.exports = { parse, inventory, calibrate, plan, apply, analyse, toolUseBoxText, toolResultBoxText, STEPS };
