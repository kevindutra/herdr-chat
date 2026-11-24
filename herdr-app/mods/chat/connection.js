import { appHome, hc, readTextFile, terminals } from "herdr";
import { openLink } from "./transport.js";
import { DEFAULT_PROVIDER, MOD, message } from "./util.js";
import { qualify, readText, remoteHome, tunnel } from "./machine.js";

export const stateDir = () => `${appHome()}/data/herdr-chat`;
export const registryPath = (chat) => `${stateDir()}/chats/${chat}.json`;

/** Where herdr-chat lives on machine `m` (null: this computer): {appHome, stateDir}. */
export async function dirsOf(m) {
  if (!m) return { appHome: appHome(), stateDir: stateDir() };
  const r = await remoteHome(m);
  return { appHome: r.appHome, stateDir: r.stateDir };
}

async function readJson(path, m = null) {
  try {
    return JSON.parse((await readText(m, path, readTextFile)) ?? "{}") ?? {};
  } catch {
    return {};
  }
}

/** Where the person's settings live (README "Configuration"); install never writes it. */
export const settingsPath = () => `${stateDir()}/settings.json`;

/**
 * What install wrote (mods/chat/config.json: the host, node, hc and each agent
 * it found) with the person's settings over it. One agent's:
 * {command, args, env, tui}, `tui` an argv or null. `m`: another machine's
 * (install/machine.sh wrote its config.json there; its settings.json is there too).
 */
export async function readConfig(m = null) {
  const dirs = await dirsOf(m);
  const cfg = await readJson(`${dirs.appHome}/mods/${MOD}/config.json`, m);
  const mine = await readJson(`${dirs.stateDir}/settings.json`, m);
  const list = (v) => (Array.isArray(v) ? v.map(String) : typeof v === "string" && v ? [v] : null);
  const agent = (id) => {
    const a = mine[id] && typeof mine[id] === "object" ? mine[id] : {};
    return {
      command: typeof a.command === "string" && a.command ? a.command : typeof cfg[id] === "string" ? cfg[id] : null,
      args: list(a.args) ?? [],
      env: { ...(mine.env ?? {}), ...(a.env ?? {}) },
      tui: list(a.tui),
    };
  };
  return { host: cfg.host ?? null, node: cfg.node ?? null, hc: cfg.hc ?? null, path: cfg.path ?? null, version: cfg.version ?? null, build: cfg.build ?? null, installedAt: cfg.installedAt ?? null, agent };
}

/** A chat's registry entry (on machine `m`, null: this one). Its `terminal` is as the app names it
 *  ("air/t7" for another machine's: the host wrote its own $HC_TERMINAL_ID, bare). */
export async function readRegistry(chat, m = null) {
  try {
    const dirs = await dirsOf(m);
    const text = await readText(m, `${dirs.stateDir}/chats/${chat}.json`, readTextFile);
    const entry = text ? JSON.parse(text) : null;
    if (entry && m) entry.terminal = qualify(m, entry.terminal);
    return entry;
  } catch {
    return null;
  }
}

// Whether a terminal runs a host (herdr-chat-host, or herdr-chat-subagent for a
// sub-agent; a template runs it as `sh -c '…/herdr-chat-subagent …'`). After
// herdr-core restarts, it brings a kept terminal back as a login shell with
// the same labels: that shell is no host.
const HOST_BIN = /herdr-chat-(host|subagent)\b/;
export function runsHost(t) {
  return !Array.isArray(t.argv) || t.argv.some((a) => HOST_BIN.test(a));
}

// The chat's host: the live terminal its registry names (`terminal`), still
// labelled with the chat (a core restart reuses addresses). A chat has one host
// (host/claim.ts), and only that host writes the registry, so a terminal that
// only carries the chat's label (a second host from before that, one that is
// starting or refusing) is not it. new-chat/update.js pairs them the same way.
export function registeredHost(entry) {
  const a = entry?.terminal;
  return (a && terminals().find((t) => t.address === a && t.state === "live" && runsHost(t) && t.labels?.["herdr-chat.chat"] === entry.chat)) || null;
}

// hc run's error, for the person. The host starts as /usr/bin/env, which is
// always there: "No such file" from the spawn is the folder (a space whose
// worktree was deleted).
export function startError(text, cwd) {
  if (/spawn_failed/.test(text) && /No such file or directory/.test(text)) {
    return `The chat's folder ${cwd} doesn't exist (a deleted worktree?). Open the chat in a space whose folder exists.`;
  }
  return `couldn't start the host: ${text}`;
}

const BACKOFF = [250, 500, 1000, 2000, 2000];
// A host this chat started is pending (none other is started) for START_GRACE after the
// start whatever happened (terminals() lists a new terminal a moment after hc run returns;
// a host that dies at once isn't restarted in a loop), then while its terminal runs a host,
// up to START_MAX: one that never registers (hung) is given up on.
const START_GRACE = 8000;
const START_MAX = 60000;

export class Connection {
  // opts: {chat, cwd, attachOnly (never start a host), place: () => ({space, tab}) | null (a host starts only once the chat's tab is known), session, hostEnv, handOver ({pid, model, thinking} | null), onRecord(rec, cx), onChange(cx), log}
  constructor(opts) {
    this.o = opts;
    this.status = "connecting"; // connecting | starting | connected | reconnecting | stopped | failed
    this.error = null;
    this.link = null;
    this.pending = new Map();
    this.nextId = 1;
    this.closed = false;
    this.attempt = 0;
    this.entry = null; // the chat's registry entry as of the last connection attempt (hostTerminal)
    this.started = null; // {address, at}: the host this connection started last (address null while hc run is out)
    this.welcome = null;
    this.connects = 0;
    // Start a host when none runs: on open, and after Restart. Once a host
    // answered, its going away shows "host stopped" instead (main.js).
    this.autoStart = true;
  }

  // Start a host when none runs (after Restart, or the old host of a replacement ended).
  // A start already under way is not reset: it stays pending (startPending).
  restart() {
    this.startFailed = false;
    this.autoStart = true;
    this.attempt = 0;
  }

  /** The chat's host terminal (the registry's, as of the last connection attempt), while it runs; null otherwise. */
  hostTerminal() {
    return registeredHost(this.entry);
  }

  /** Whether a host this connection started may still become the chat's (not in the registry or terminals() yet). */
  startPending() {
    const s = this.started;
    if (!s) return false;
    const age = Date.now() - s.at;
    if (age < START_GRACE) return true;
    const runs = !s.address || terminals().some((t) => t.address === s.address && t.state === "live" && runsHost(t));
    return runs && age < START_MAX;
  }

  set(status, error, cx) {
    if (this.status === status && this.error === error) return;
    this.status = status;
    this.error = error ?? null;
    this.o.onChange?.(cx);
  }

  start(cx) {
    cx.spawn(async (cx) => {
      while (!this.closed) {
        try {
          await this.once(cx);
        } catch (e) {
          this.o.log?.(`connection: ${message(e)}`);
          if (!this.closed) this.set(this.connects ? "reconnecting" : "connecting", message(e), cx);
        }
        this.failPending("disconnected");
        if (this.closed) return;
        await cx.sleep(BACKOFF[Math.min(this.attempt++, BACKOFF.length - 1)]);
      }
    });
    // Requests nobody answered within their time: fail them, keep the loop.
    cx.timer.every(1000, () => {
      const now = Date.now();
      for (const [id, p] of this.pending) {
        if (now > p.deadline) {
          this.pending.delete(id);
          p.reject(new Error(`${p.op}: no reply from the host`));
        }
      }
    });
  }

  // One connection attempt and, when it works, its whole read loop.
  async once(cx) {
    const m = this.o.machine ?? null;
    const entry = await readRegistry(this.o.chat, m);
    this.entry = entry;
    if (!entry?.port || !entry?.pid) {
      await this.ensureHost(cx, entry);
      return;
    }
    let link;
    try {
      // Another machine's host listens on its own 127.0.0.1: reach it through the chat's tunnel.
      link = await openLink(m ? { wsPort: await tunnel(m, this.o.chat, entry.wsPort, this.o.log) } : entry);
    } catch (e) {
      this.o.log?.(`link: ${message(e)}`);
      await this.ensureHost(cx, entry);
      return;
    }
    this.link = link;
    try {
      await link.send({ t: "hello", v: 1, token: entry.token, client: "mod" });
      let welcomed = false;
      for (let texts; (texts = await link.next()) !== null; ) {
        const recs = [];
        for (const text of texts) {
          try {
            recs.push(JSON.parse(text));
          } catch {
            this.o.log?.(`bad record: ${text.slice(0, 200)}`);
          }
        }
        for (const rec of recs) {
          if (rec.t === "welcome") {
            welcomed = true;
            this.welcome = rec;
            this.connects++;
            this.attempt = 0;
            this.autoStart = false;
            this.set("connected", null, cx);
          } else if (rec.t === "res") {
            const p = this.pending.get(rec.id);
            if (p) {
              this.pending.delete(rec.id);
              if (rec.ok) p.resolve(rec.data ?? {});
              else p.reject(new Error(rec.error ?? "failed"));
            }
          }
          if (welcomed && rec.t !== "ping") this.o.onRecord(rec, cx); // ping: the host's keepalive
        }
        if (recs.length) this.o.onFlush?.(cx);
      }
      if (!welcomed) {
        // A wrong token (a newer host wrote the registry) closes without a reply.
        this.o.log?.("closed before welcome");
      }
    } finally {
      this.link = null;
      link.close();
      if (!this.closed) this.set("reconnecting", null, cx);
    }
  }

  // No host answered: start one, unless the registry's host still runs (it may
  // be starting, or between clients) or the one we started may not be in yet.
  // Two starts at once can still happen (two windows on one core): the host
  // refuses to be a chat's second (host/claim.ts), so this only saves a process.
  async ensureHost(cx, entry) {
    // A sub-agent's chat only attaches: its host is the parent's to start and end.
    if (this.o.attachOnly) {
      if (this.hostTerminal()) this.set(this.connects ? "reconnecting" : "starting", null, cx);
      else this.set("stopped", "The sub-agent ended", cx);
      return;
    }
    // A start that failed stays failed (its error shown) until Retry (restart).
    if (this.startFailed) return;
    if (this.hostTerminal() || this.startPending()) {
      this.set(this.connects ? "reconnecting" : "starting", null, cx);
      return;
    }
    this.started = null;
    if (!this.autoStart) {
      this.set("stopped", "The chat's host stopped", cx);
      return;
    }
    const place = this.o.place?.();
    if (!place) {
      this.set("connecting", "waiting for the chat's tab", cx);
      return;
    }
    const started = (this.started = { address: null, at: Date.now() });
    this.set("starting", null, cx);
    const m = this.o.machine ?? null;
    let cfg, dirs;
    try {
      [cfg, dirs] = await Promise.all([readConfig(m), dirsOf(m)]);
      if (!this.o.cwd) this.o.cwd = m ? (await remoteHome(m)).home : ".";
    } catch (e) {
      this.started = null;
      this.set("connecting", `can't reach ${m}: ${message(e)}`, cx); // a machine that's down: tried again
      return;
    }
    // The chat's agent: its props, else what the registry recorded (a reopened chat keeps it).
    const provider = this.o.provider ?? entry?.provider ?? DEFAULT_PROVIDER;
    this.provider = provider;
    const host = cfg.host;
    const agent = cfg.agent(provider);
    if (!host) {
      this.started = null;
      this.startFailed = true;
      this.set("failed", m ? `herdr-chat isn't installed on ${m}: run install/machine.sh ${m} from your herdr-chat folder` : `mods/${MOD}/config.json has no "host"`, cx);
      return;
    }
    const env = { ...agent.env, ...(this.o.hostEnv ?? {}) };
    if (cfg.node) env.HERDR_CHAT_NODE = cfg.node;
    // Another machine's core terminals don't get its login PATH (a core started over ssh):
    // the install recorded it, and the hc there, for the host and the agent's tools.
    if (m && cfg.hc) env.HERDR_CHAT_HC = cfg.hc;
    if (m && cfg.path) env.PATH = cfg.path;
    const session = this.o.session ?? entry?.sessionFile ?? null;
    const args = [
      // No --name: the registry and the herdr-chat.chat label identify it, and
      // Herdr's toasts then show the title the host sets (OSC 0). No herdr.*
      // labels yet: the app would adopt it as a visible pane. The chat adds
      // its pane, hidden, to the layout document, then labels it (main.js
      // keepHostHidden). --keep: the core keeps it, as adoption would.
      "run", "--bg", "--json", "--keep", "--no-parent", ...(m ? ["--on", m] : []), "--cwd", this.o.cwd,
      "--label", `herdr-chat.chat=${this.o.chat}`, "--label", "herdr-chat.role=host",
      "--", "/usr/bin/env", ...Object.entries(env).map(([k, v]) => `${k}=${v}`),
      host, "serve", "--chat", this.o.chat, "--cwd", this.o.cwd, "--state-dir", dirs.stateDir, "--app-home", dirs.appHome, "--provider", provider,
      ...(session ? ["--session", session] : []),
      // A Pi TUI this chat takes over: the host waits for its pid, then uses its model and
      // thinking (only while that pid lives: a later restart of the chat ignores them).
      ...(session && this.o.handOver?.pid ? ["--after-pid", String(this.o.handOver.pid),
        ...(this.o.handOver.model ? ["--model", this.o.handOver.model] : []),
        ...(this.o.handOver.thinking ? ["--thinking", this.o.handOver.thinking] : [])] : []),
      // The agent's command and arguments (readConfig).
      ...(agent.command ? [`--${provider}`, agent.command] : []),
      ...(agent.args.length ? ["--", ...agent.args] : []),
    ];
    const r = await hc(args);
    this.o.log?.(`hc run host: code ${r.code} ${r.stdout.trim()} ${r.stderr.trim()}`);
    if (r.code !== 0) {
      if (this.started === started) this.started = null;
      this.startFailed = true;
      this.set("failed", startError((r.stderr || r.stdout).trim(), this.o.cwd), cx);
      return;
    }
    try {
      started.address = JSON.parse(r.stdout).address ?? null;
    } catch {}
    if (!started.address) started.at = Date.now(); // no address to watch: the grace from now
  }

  req(op, args = {}, { timeout = 30000 } = {}) {
    const link = this.link;
    if (!link || this.status !== "connected") return Promise.reject(new Error("not connected to the host"));
    const id = `m${this.nextId++}`;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, op, deadline: Date.now() + timeout });
      link.send({ t: "req", id, op, ...args }).catch((e) => {
        this.pending.delete(id);
        reject(e);
      });
    });
  }

  failPending(why) {
    for (const [, p] of this.pending) p.reject(new Error(why));
    this.pending.clear();
  }

  resync() {
    this.link?.close();
  }

  close() {
    this.closed = true;
    this.resync();
  }
}
