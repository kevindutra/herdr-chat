// The client's copy of the chat: ChatState and the timeline items, applied
// from the host's snapshot and patch records (protocol.md "Records").

import { typedText } from "./util.js";

export const EMPTY_STATE = {
  phase: "starting", error: null, cwd: "", sessionFile: null, sessionName: null, agentVersion: null,
  model: null, thinking: null, plan: null, usage: null, queue: { steering: [], followUp: [] }, dialog: null,
  dialogsPending: 0, statuses: [], widgets: [], title: null, editorText: null, commands: [],
};

export class Store {
  constructor() {
    this.state = { ...EMPTY_STATE };
    this.items = [];
    this.index = new Map();
    this.hasOlder = false;
    this.seq = null;
    this.version = 0; // bumps on every change
    this.snapshots = 0;
    this.loaded = false;
    // A chat on another machine (machine.js): its items' image paths are that machine's. mapItem
    // gives the item as shown (the local copies' paths, once copied); `orig` keeps what the host sent,
    // so remap() can show a copy that has landed since.
    this.mapItem = null;
    this.orig = new Map();
  }

  reindex() {
    this.index = new Map(this.items.map((it, i) => [it.id, i]));
  }

  shown(it) {
    if (!this.mapItem) return it;
    this.orig.set(it.id, it);
    return this.mapItem(it);
  }

  // Every item again through mapItem (a local copy landed): true when one changed.
  remap() {
    if (!this.mapItem) return false;
    let changed = false;
    this.items = this.items.map((it) => {
      const o = this.orig.get(it.id);
      const next = o ? this.mapItem(o) : it;
      if (next !== it && JSON.stringify(next) !== JSON.stringify(it)) { changed = true; return next; }
      return it;
    });
    if (changed) this.version++;
    return changed;
  }

  snapshot(rec) {
    this.state = { ...EMPTY_STATE, ...(rec.state ?? {}) };
    this.orig.clear();
    this.items = (rec.items ?? []).map((it) => this.shown(it));
    this.hasOlder = Boolean(rec.hasOlder);
    this.seq = rec.seq ?? null;
    this.reindex();
    this.snapshots++;
    this.loaded = true;
    this.version++;
  }

  // false: a gap in seq (the caller resyncs for a fresh snapshot).
  patch(rec) {
    if (this.seq != null && rec.seq != null && rec.seq !== this.seq + 1) return false;
    this.seq = rec.seq ?? this.seq;
    if (rec.state) {
      const next = { ...this.state };
      for (const [k, v] of Object.entries(rec.state)) next[k] = v;
      this.state = next;
    }
    for (const raw of rec.upsert ?? []) {
      const it = this.shown(raw);
      const i = this.index.get(it.id);
      if (i === undefined) {
        this.index.set(it.id, this.items.length);
        this.items.push(it);
      } else this.items[i] = it;
    }
    if (rec.remove?.length) {
      const gone = new Set(rec.remove);
      for (const id of gone) this.orig.delete(id);
      this.items = this.items.filter((it) => !gone.has(it.id));
      this.reindex();
    }
    this.version++;
    return true;
  }

  // Older items from `history`, in front.
  prepend(items, hasOlder) {
    const known = new Set(this.items.map((it) => it.id));
    this.items = [...items.filter((it) => !known.has(it.id)).map((it) => this.shown(it)), ...this.items];
    this.hasOlder = Boolean(hasOlder);
    this.reindex();
    this.version++;
  }

  get(id) {
    const i = this.index.get(id);
    return i === undefined ? null : this.items[i];
  }

  working() {
    return this.state.phase === "working" || this.state.phase === "compacting";
  }

  // The prompts the user sent from the composer, newest first (for Up).
  sentPrompts() {
    const out = [];
    for (let i = this.items.length - 1; i >= 0; i--) {
      const it = this.items[i];
      const text = it.kind === "user" ? typedText(it) : "";
      if (it.kind === "user" && (it.source === "composer" || it.source === "queued") && text && out[out.length - 1] !== text) out.push(text);
    }
    return out;
  }

  lastAssistantText() {
    for (let i = this.items.length - 1; i >= 0; i--) if (this.items[i].kind === "assistant" && this.items[i].text) return this.items[i].text;
    return null;
  }
}
