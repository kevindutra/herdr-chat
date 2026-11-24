// Open a file a tool touched (visual-v2.md §6, "clickable file paths"):
// 1. herdr-nvim installed (mods/herdr-nvim/bin/herdr-nvim, as gitview's
//    nvim.js finds it): `herdr-nvim open --tab <tab> --space <space> <file>:<line>`;
// 2. else $EDITOR (the login shell's; vi without one) in a terminal pane
//    of the chat's tab (beside it, like the TUI hand-off), in the chat's folder.

import { appHome, exec, hc, readTextFile } from "herdr";

let editorCache = null;

async function herdrNvim() {
  const bin = `${appHome()}/mods/herdr-nvim/bin/herdr-nvim`;
  try {
    return (await readTextFile(bin)) !== null ? bin : null;
  } catch {
    return null;
  }
}

async function editorArgv() {
  if (editorCache) return editorCache;
  let ed = "";
  try {
    ed = (await exec("/bin/sh", ["-lc", 'printf %s "${VISUAL:-$EDITOR}"'])).stdout.trim();
  } catch {}
  editorCache = (ed || "vi").split(/\s+/).filter(Boolean);
  return editorCache;
}

// {path (absolute), line, cwd, tab, space, machine?} → {how: "herdr-nvim" | "editor", terminal?}
// `machine`: the chat's (machine.js): the file is there, so the editor runs there ($VISUAL/$EDITOR of
// its login shell, else vi), in a pane of the chat's tab (labels as that machine's core names them).
export async function openFile(o) {
  if (o.machine) return openRemote(o);
  const nvim = await herdrNvim();
  if (nvim && o.tab) {
    const args = ["open", "--tab", String(o.tab)];
    if (o.space) args.push("--space", String(o.space));
    args.push(`${o.path}:${o.line || 1}`);
    const r = await exec(nvim, args, { cwd: o.cwd });
    if (r.code === 0) return { how: "herdr-nvim" };
  }
  const ed = await editorArgv();
  const argv = /(^|\/)(n?vim?|vi|hx|helix|kak|micro|nano|emacs)$/.test(ed[0]) ? [...ed, `+${o.line || 1}`, o.path] : [...ed, o.path];
  if (!o.space || !o.tab) throw new Error("no tab to open the editor in");
  const r = await hc(["run", "--bg", "--json", "--no-parent", "--cwd", o.cwd ?? "/", "--label", `herdr.space=${o.space}`,
    "--label", `herdr.tab=${o.tab}`, "--label", "herdr-chat.editor=1", "--", ...argv]);
  if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim() || "hc run failed");
  return { how: "editor", terminal: JSON.parse(r.stdout).address, argv };
}

const strip = (m, id) => (String(id ?? "").startsWith(`${m}/`) ? String(id).slice(m.length + 1) : id);

async function openRemote(o) {
  const m = o.machine;
  if (!o.space || !o.tab) throw new Error("no tab to open the editor in");
  // Its login shell picks the editor and opens it (+line for the vi family), so its PATH is there too.
  const script = 'ed="${VISUAL:-${EDITOR:-vi}}"; case "${ed%% *}" in *vi|*vim|*nvim|*hx|*helix|*kak|*micro|*nano|*emacs) exec $ed "+$2" "$1" ;; *) exec $ed "$1" ;; esac';
  const r = await hc(["run", "--bg", "--json", "--no-parent", "--on", m, "--cwd", o.cwd ?? "/", "--label", `herdr.space=${strip(m, o.space)}`,
    "--label", `herdr.tab=${strip(m, o.tab)}`, "--label", "herdr-chat.editor=1", "--", "/bin/sh", "-lc", script, "sh", o.path, String(o.line || 1)]);
  if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim() || "hc run failed");
  return { how: "editor", terminal: JSON.parse(r.stdout).address, argv: ["$EDITOR", o.path] };
}
