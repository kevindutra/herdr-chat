// A chat on another computer (`hc machine`, e.g. "air"): its host, its agent and its session run
// there, and this window draws it. Everything that assumed "same computer" goes through here:
//
//   - ids: the app names another machine's spaces, tabs, panes and terminals "air/<id>"; that
//     machine's core (its layout document, its labels) names them bare. qualify/bare convert.
//   - files: the registry, the install's config.json and the host's images live there. Text is
//     read with `hc exec --on <m> cat`; images are copied into a local mirror under the app home
//     (image() takes only app-home files), at `data/herdr-chat/remote/<m>/<the remote absolute
//     path>`, so the way back to the host's path is the prefix off.
//   - the core: the layout document (hostpane.js) is that machine's, over `hc exec -i --on <m> hc connect`.
//   - the socket: the host listens on that machine's 127.0.0.1. An `ssh -L` per chat, run in a
//     hidden local hc terminal (labels herdr-chat.tunnel*), brings its WebSocket here.
//
// `m` null everywhere means this computer: every function then does what the chat always did.

import { appHome, exec, hc, terminals } from "herdr";

/** The machine of an address or id ("air" for "air/t7"), null for this computer's. */
export function machineOf(address) {
  const s = String(address ?? ""), at = s.indexOf("/");
  return at > 0 ? s.slice(0, at) : null;
}

/** An id of machine `m`'s core as the app names it ("t7" → "air/t7"). */
export const qualify = (m, id) => (m && id != null && id !== "" && !String(id).includes("/") ? `${m}/${id}` : id);

/** An id as the app names it → as machine `m`'s core does ("air/t7" → "t7"). */
export const bare = (m, id) => (m && String(id ?? "").startsWith(`${m}/`) ? String(id).slice(m.length + 1) : id);

// ---- remote files --------------------------------------------------------------

/** A text file of machine `m` (null: this one), or null when it can't be read. */
export async function readText(m, path, readLocal) {
  if (!m) return readLocal(path);
  const r = await hc(["exec", "--on", m, "/bin/cat", path]);
  return r.code === 0 ? r.stdout : null;
}

const INFO = new Map(); // machine → Promise<{home, appHome, stateDir}>

/** Where machine `m` keeps herdr-chat: {home, appHome, stateDir}. Its app home is ~/.config/herdr-app
 *  there (install/machine.sh writes mods/chat/config.json in it), whether or not Herdr runs there. */
export function remoteHome(m) {
  if (!INFO.has(m)) {
    const p = (async () => {
      const r = await hc(["exec", "--on", m, "/bin/sh", "-c", 'printf %s "${HERDR_APP_HOME:-$HOME/.config/herdr-app}|$HOME"']);
      if (r.code !== 0) throw new Error(`${m}: ${(r.stderr || r.stdout).trim() || "hc exec failed"}`);
      const [app, home] = r.stdout.trim().split("|");
      return { home, appHome: app, stateDir: `${app}/data/herdr-chat` };
    })();
    p.catch(() => INFO.delete(m)); // a machine that was down: ask again next time
    INFO.set(m, p);
  }
  return INFO.get(m);
}

const HCS = new Map(); // machine → Promise<its hc's path>

/** The hc of machine `m`, as its install recorded it (a core terminal there lacks the login PATH). */
export function remoteHc(m) {
  if (!HCS.has(m)) {
    const p = (async () => {
      const { appHome: app } = await remoteHome(m);
      const r = await hc(["exec", "--on", m, "/bin/cat", `${app}/mods/chat/config.json`]);
      let cfg = {};
      try { cfg = r.code === 0 ? JSON.parse(r.stdout) : {}; } catch {}
      return cfg.hc || "hc";
    })();
    p.catch(() => HCS.delete(m));
    HCS.set(m, p);
  }
  return HCS.get(m);
}

// ---- the local mirror of a machine's files ---------------------------------------

/** The local folder that mirrors machine `m`'s absolute paths. */
export const mirrorRoot = (m) => `${appHome()}/data/herdr-chat/remote/${m}`;

/** A remote absolute path's place in the local mirror. */
export const mirrorOf = (m, path) => `${mirrorRoot(m)}${path}`;

/** A path the chat holds → the host's: a mirror copy's remote original, anything else as it is. */
export function toHost(m, path) {
  if (!m || typeof path !== "string") return path;
  const root = mirrorRoot(m);
  return path.startsWith(root + "/") ? path.slice(root.length) : path;
}

/** An op's arguments with every mirror path turned back into the host's (images, path, paths). */
export function argsToHost(m, args) {
  if (!m || !args) return args;
  const out = { ...args };
  for (const k of Object.keys(out)) {
    const v = out[k];
    if (typeof v === "string") out[k] = toHost(m, v);
    else if (Array.isArray(v)) out[k] = v.map((x) => toHost(m, x));
  }
  return out;
}

const FETCH = `set -e
mkdir -p "$(dirname "$3")"
hc exec --on "$1" /bin/cat "$2" > "$3.part"
[ -s "$3.part" ] || { rm -f "$3.part"; exit 1; }
mv "$3.part" "$3"`;

/**
 * Remote files copied into the local mirror, once each. `want(path)`: the mirror path when the copy is
 * there, else null (and the path is queued); `pump(cx)` starts the queued copies, and `onDone(cx)` is
 * called after each lands, so the caller can swap the paths in. A failed copy is tried again after a minute.
 */
export class Mirror {
  constructor(m, onDone, log) {
    this.m = m;
    this.onDone = onDone;
    this.log = log;
    this.state = new Map(); // remote path → "ok" | "queued" | "busy" | failedAt (ms)
  }

  want(path) {
    if (!this.m || typeof path !== "string" || !path.startsWith("/") || path.startsWith(mirrorRoot(this.m) + "/")) return path;
    const s = this.state.get(path);
    if (s === "ok") return mirrorOf(this.m, path);
    if (s === "busy" || s === "queued" || (typeof s === "number" && Date.now() - s < 60000)) return null;
    this.state.set(path, "queued");
    return null;
  }

  pump(cx) {
    for (const [path, s] of this.state) {
      if (s !== "queued") continue;
      this.state.set(path, "busy");
      cx.spawn(async (cx) => {
        const r = await exec("/bin/sh", ["-c", FETCH, "sh", this.m, path, mirrorOf(this.m, path)]).catch((e) => ({ code: 1, stderr: String(e) }));
        if (r.code === 0) this.state.set(path, "ok");
        else {
          this.state.set(path, Date.now());
          this.log?.(`copy ${this.m}:${path}: ${(r.stderr || "").trim() || `exit ${r.code}`}`);
        }
        this.onDone?.(cx);
      });
    }
  }
}

/** An item with its image paths (user images, tool images, diagrams) as `want` gives them; a path not
 *  copied yet stays the host's (the chat shows its file chip until the copy lands). */
export function mapPaths(it, want) {
  const one = (p) => want(p) ?? p;
  let out = it;
  const set = (k, v) => { if (out === it) out = { ...it }; out[k] = v; };
  if (Array.isArray(it.imagePaths) && it.imagePaths.length) set("imagePaths", it.imagePaths.map(one));
  if (Array.isArray(it.images) && it.images.length) set("images", it.images.map(one));
  if (Array.isArray(it.blocks) && it.blocks.some((b) => b?.svg)) set("blocks", it.blocks.map((b) => (b?.svg ? { ...b, svg: one(b.svg) } : b)));
  return out;
}

const UPLOAD = `exec hc exec -i --on "$1" /bin/sh -c 'mkdir -p "$(dirname "$1")" && cat > "$1"' sh "$2" < "$3"`;

/** A local file copied to machine `m` at `remotePath` (its folders made). Throws with hc's message. */
export async function upload(m, localPath, remotePath) {
  const r = await exec("/bin/sh", ["-c", UPLOAD, "sh", m, remotePath, localPath]);
  if (r.code !== 0) throw new Error(`copying to ${m}: ${(r.stderr || r.stdout).trim() || `exit ${r.code}`}`);
  return remotePath;
}

const PASTE = (path) => [
  "set png to (the clipboard as «class PNGf»)",
  `set f to open for access (POSIX file ${JSON.stringify(path)}) with write permission`,
  "set eof f to 0",
  "write png to f",
  "close access f",
].flatMap((l) => ["-e", l]);

/** This computer's clipboard image as a PNG at `path` (its folder made): true, or false when it holds none. */
export async function clipboardPng(path) {
  await exec("/bin/mkdir", ["-p", path.replace(/\/[^/]*$/, "")]);
  const r = await exec("osascript", PASTE(path)).catch(() => ({ code: 1 }));
  if (r.code !== 0) return false;
  const s = await exec("/bin/test", ["-s", path]);
  return s.code === 0;
}

// ---- the tunnel to a remote host's WebSocket ---------------------------------------

const TARGETS = new Map(); // machine → Promise<ssh target>

/** How ssh reaches machine `m`: its `hc machine` target (the host it was added with). */
function sshTarget(m) {
  if (!TARGETS.has(m)) {
    const p = (async () => {
      const r = await hc(["machine", "ls", "--json"]);
      const list = r.code === 0 ? JSON.parse(r.stdout).machines ?? [] : [];
      const x = list.find((y) => y.name === m);
      if (x?.via) throw new Error(`${m} is reached through --via, not ssh: a chat there needs ssh`);
      return x?.target || m;
    })();
    p.catch(() => TARGETS.delete(m));
    TARGETS.set(m, p);
  }
  return TARGETS.get(m);
}

const tunnelsOf = (chat) => terminals().filter((t) => t.state === "live" && t.labels?.["herdr-chat.tunnel"] === chat);

/**
 * A local port that reaches 127.0.0.1:`port` on machine `m`, for `chat`: its tunnel's, started when
 * it has none for that port (an older one, to a host that has gone, ends). The ssh may still be
 * connecting: the caller's connect fails then, and its retry finds it ready.
 */
export async function tunnel(m, chat, port, log) {
  const to = `${m}:${port}`;
  for (const t of tunnelsOf(chat)) {
    if (t.labels?.["herdr-chat.tunnel.to"] === to && t.labels?.["herdr-chat.tunnel.port"]) return Number(t.labels["herdr-chat.tunnel.port"]);
    log?.(`tunnel ${t.address} goes to ${t.labels?.["herdr-chat.tunnel.to"]}, not ${to}: ending it`);
    await hc(["kill", t.address]);
  }
  const target = await sshTarget(m);
  const local = 20000 + Math.floor(Math.random() * 30000);
  const r = await hc(["run", "--bg", "--json", "--no-parent", "--no-notify",
    "--label", `herdr-chat.tunnel=${chat}`, "--label", `herdr-chat.tunnel.to=${to}`, "--label", `herdr-chat.tunnel.port=${local}`,
    "--", "ssh", "-N", "-o", "BatchMode=yes", "-o", "ExitOnForwardFailure=yes", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3",
    "-L", `127.0.0.1:${local}:127.0.0.1:${port}`, target]);
  if (r.code !== 0) throw new Error(`tunnel to ${m}: ${(r.stderr || r.stdout).trim()}`);
  log?.(`tunnel to ${to} on 127.0.0.1:${local} (${JSON.parse(r.stdout).address})`);
  return local;
}

/** Ends `chat`'s tunnels (its view closed). */
export function closeTunnels(chat) {
  for (const t of tunnelsOf(chat)) hc(["kill", t.address]).catch(() => {});
}

/** Every live tunnel: [{address, chat}] (the orphan sweep ends those whose chat has no pane). */
export function allTunnels() {
  return terminals().filter((t) => t.state === "live" && t.labels?.["herdr-chat.tunnel"]).map((t) => ({ address: t.address, chat: t.labels["herdr-chat.tunnel"] }));
}
