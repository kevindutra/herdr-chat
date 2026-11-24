// Where a chat lives, for certain. `props()` names no pane and `panes()`
// lists mod panes without their props, so `focused()` was the only clue,
// and a chat that started while another tab had focus took that tab (two
// hosts in one tab, a Pi tab with Claude's icon). The core's layout
// document ("herdr-app", the one the app saves) has every mod pane with its
// props: the pane whose props name this chat is this chat's.
//
// A chat in another machine's space is in that machine's document (machine.js), under
// bare ids: modPanes gives them as the app names them ("air/p…").

import { getDoc } from "./hostpane.js";
import { qualify } from "./machine.js";

// Machine `m`'s layout document (null: this computer's), or null (no hc, no core).
export async function readDoc(m = null) {
  return (await getDoc(m)).value;
}

// Every mod pane of `mod` in machine `m`'s document: [{pane, tab, space, props}], ids as the app names them.
export function modPanes(doc, mod, m = null) {
  const out = [];
  const walk = (space, tab, n) => {
    const c = n?.content;
    if (c?.mod === mod) out.push({ pane: qualify(m, n.id), tab: qualify(m, tab), space: qualify(m, space), props: c.props ?? {} });
    for (const ch of n?.children ?? []) walk(space, tab, ch);
  };
  for (const s of doc?.spaces ?? []) for (const t of s.tabs ?? []) walk(s.id, t.id, t.root);
  return out;
}
