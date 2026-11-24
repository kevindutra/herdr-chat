// The host's pane, hidden. A chat's host terminal is a pane of the chat's
// tab, so Herdr lists it as an agent (the agents list, the tab and space
// dots, cmd-]/cmd-[, its own toasts), but that pane is marked `hidden: true`
// in the core's layout document ("herdr-app"): Herdr doesn't draw it and
// gives it no room, through splits, closes and restarts. No command reaches
// a pane's `hidden`, so the document is written here (doc.get, edit, doc.set
// with the version read; docs/dev/research/split-glitch.md §2–§3).
//
// A chat in another machine's space (machine.js): that space's tabs and panes are in that
// machine's core's document, under bare ids ("t7", not "air/t7"). Every function takes the
// machine `m` (null: this computer) and the ids as the app names them; the document is read
// and written over `hc exec -i --on <m> hc connect`.

import { exec, panes, spaces } from "herdr";
import { randomBytes } from "crypto";
import { bare, machineOf, remoteHc } from "./machine.js";

const HELLO = '{"jsonrpc":"2.0","id":1,"method":"hello","params":{"generation":1}}';
const q = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;

// One request over `hc connect` (machine `m`'s core): its result, or a thrown error (`kind` set from
// the core's error data). `at` (epoch ms): connected first, the request is sent then (the process
// start doesn't delay it).
async function rpc(method, params, at = null, m = null) {
  const req = JSON.stringify({ jsonrpc: "2.0", id: 2, method, params });
  const wait = at ? `perl -MTime::HiRes=time,sleep -e '$d = $ARGV[0] - time; sleep($d) if $d > 0' ${(at / 1000).toFixed(3)}; ` : "";
  const connect = m ? `hc exec -i --on ${q(m)} ${q(await remoteHc(m))} connect` : "hc connect";
  const r = await exec("/bin/sh", ["-c", `{ printf '%s\\n' ${q(HELLO)}; ${wait}printf '%s\\n' ${q(req)}; } | ${connect}`]);
  if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim() || `hc connect: exit ${r.code}`);
  const res = r.stdout.trim().split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).find((x) => x?.id === 2);
  if (!res) throw new Error(`${method}: no answer`);
  if (res.error) throw Object.assign(new Error(res.error.message ?? `${method} failed`), { kind: res.error.data?.kind ?? null });
  return res.result;
}

// The layout document of machine `m` (null: this computer's) and its version: {value, version}.
export async function getDoc(m = null) {
  const r = await rpc("doc.get", { name: "herdr-app" }, null, m);
  return { value: r?.value ?? null, version: r?.version ?? 0 };
}

// Write it if nobody wrote since `version` read it: the new version, else throws (kind "conflict").
export async function setDoc(value, version, at = null, m = null) {
  return (await rpc("doc.set", { name: "herdr-app", value, version }, at, m))?.version ?? null;
}

function walk(n, f, parent = null) {
  if (!n) return;
  f(n, parent);
  for (const c of n.children ?? []) walk(c, f, n);
}

// Where things are in the document: the chat's own pane and the host's.
// {chat: {pane, tab, space} | null, host: {pane, tab, space, hidden, px} | null}
// `terminal` and the ids returned are as the document names them (bare on another machine).
export function locate(doc, chat, terminal) {
  let me = null, host = null;
  for (const s of doc?.spaces ?? []) for (const t of s.tabs ?? []) walk(t.root, (n) => {
    const c = n.content;
    if (c?.mod && c.props?.chat === chat && !me) me = { pane: n.id, tab: t.id, space: s.id };
    if (terminal && c?.terminal === terminal && !host) host = { pane: n.id, tab: t.id, space: s.id, hidden: Boolean(n.hidden), px: n.size?.px ?? null };
  });
  return { chat: me, host };
}

// The edit that hides `terminal` in `tab`: its node marked hidden, or a
// hidden node appended to the tab's root. Returns what it did, or null when
// there's nothing to do (already hidden) or no such tab.
export function hideIn(doc, tab, terminal) {
  let node = null;
  for (const s of doc?.spaces ?? []) for (const x of s.tabs ?? []) walk(x.root, (n) => { if (n.content?.terminal === terminal) node = n; });
  if (node) {
    if (node.hidden) return null;
    node.hidden = true;
    return { did: "flagged", pane: node.id };
  }
  const t = (doc?.spaces ?? []).flatMap((s) => s.tabs ?? []).find((x) => x.id === tab);
  if (!t?.root) return null;
  const block = { id: `p${randomBytes(16).toString("hex")}`, type: "block", hidden: true, content: { terminal } };
  // A tab's root is a container; a lone block (another client's shape) is wrapped in a row.
  if (!t.root.children) t.root = { id: `s${randomBytes(16).toString("hex")}`, type: "row", children: [t.root] };
  t.root.children.push(block);
  return { did: "added", pane: block.id };
}

// Whether the document holds what the app shows now: the same tabs and
// panes. The app writes its own changes a moment after it makes them, and a
// write of ours that lands first makes it take our document and drop its
// change (a new tab gone: "Layout changed elsewhere"). So ours waits until
// the app's latest change is in the document. Machine `m`'s document holds
// that machine's tabs and panes ("air/…" in the app, bare there); null: this computer's.
export function inStep(doc, except = null, m = null) {
  const docTabs = new Set(), docPanes = new Set();
  for (const s of doc?.spaces ?? []) for (const t of s.tabs ?? []) {
    docTabs.add(t.id);
    walk(t.root, (n) => { if (!n.children?.length && n.id !== except) docPanes.add(n.id); }); // the leaves: panes (`except`: the one we add)
  }
  const mine = (id) => machineOf(id) === m;
  const appTabs = spaces().flatMap((s) => s.tabs.map((t) => t.id)).filter(mine).map((id) => bare(m, id));
  const appPanes = panes().map((p) => p.pane).filter(mine).map((id) => bare(m, id));
  return appTabs.length === docTabs.size && appTabs.every((t) => docTabs.has(t))
    && appPanes.length === docPanes.size && appPanes.every((p) => docPanes.has(p));
}

// Hide the host: read, edit, write with the version read; a conflict reads
// again (the edit is idempotent). {did: "flagged"|"added"|"already"|"waiting", pane} or throws.
// "waiting": the app has a change it hasn't written yet (inStep); nothing written.
// `beforeWrite()`: awaited between the edit and the write, it gives the time the write
// should land (main.js: just before the app's next read of the document), or false: not
// now. The app must not have moved meanwhile. `tab` and `terminal` as the app names them;
// the pane and tab returned are too.
export async function hideHost(tab, terminal, { tries = 4, force = false, beforeWrite = null, machine = null } = {}) {
  const m = machine;
  const dTab = bare(m, tab), dTerm = bare(m, terminal);
  const out = (did, pane, t) => ({ did, pane: pane && m ? `${m}/${pane}` : pane, tab: t && m && !String(t).includes("/") ? `${m}/${t}` : t });
  for (let i = 0; ; i++) {
    const { value, version } = await getDoc(m);
    if (!value?.spaces) throw new Error("no layout document");
    if (!force && !inStep(value, null, m)) return out("waiting", null, tab);
    const edit = hideIn(value, dTab, dTerm);
    if (!edit) {
      const where = locate(value, null, dTerm).host;
      if (!where) throw new Error(`no tab ${tab} in the layout document`);
      return out("already", where.pane, where.tab);
    }
    let at = null;
    if (beforeWrite) {
      at = await beforeWrite();
      if (at === false && !force) return out("waiting", null, tab);
      if (!force && !inStep(value, edit.did === "added" ? edit.pane : null, m)) return out("waiting", null, tab);
    }
    try {
      await setDoc(value, version, typeof at === "number" ? at : null, m);
      return out(edit.did, edit.pane, tab);
    } catch (e) {
      if (e?.kind !== "conflict" || i + 1 >= tries) throw e;
    }
  }
}
