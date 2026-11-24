#!/bin/sh
# Run by install/machine.sh on the other machine, in its login shell, from the unpacked release
# (~/.local/share/herdr-chat/<version>/install/): records the host there for the Herdr app on the
# computer that drives it, in ${HERDR_APP_HOME:-~/.config/herdr-app}/mods/chat/config.json, the same
# file a desktop install writes (the app's chat mod and the host's sub-agent launcher read it).
# Prints lines starting "herdr-chat:"; exits nonzero with the reason.
set -eu

die() { echo "herdr-chat: $*"; exit 1; }
tree=$(cd "$(dirname "$0")/.." && pwd)
base=$(dirname "$tree")
link="$base/current"
app="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"

# Node 20+: the one on PATH, else the newest one a version manager installed.
major() { "$1" -e 'process.stdout.write(process.versions.node.split(".")[0])' 2>/dev/null || echo 0; }
node=
if command -v node >/dev/null 2>&1 && [ "$(major "$(command -v node)")" -ge 20 ]; then node=$(command -v node); fi
if [ -z "$node" ]; then
  for n in $(ls -d "$HOME"/.asdf/installs/nodejs/*/bin/node "$HOME"/.nvm/versions/node/*/bin/node \
      "$HOME"/.local/share/mise/installs/node/*/bin/node /opt/homebrew/bin/node /usr/local/bin/node 2>/dev/null | sort -V -r); do
    if [ -x "$n" ] && [ "$(major "$n")" -ge 20 ]; then node=$n; break; fi
  done
fi
[ -n "$node" ] || die "no Node 20 or newer on this machine (PATH, asdf, nvm, mise, Homebrew)"

hc=$(command -v hc 2>/dev/null || true)
[ -n "$hc" ] || { [ -x "$HOME/.local/bin/hc" ] && hc="$HOME/.local/bin/hc"; }
[ -n "$hc" ] || die "hc (herdr-core) not found on this machine"

found=
for p in pi claude codex; do
  path=$(command -v "$p" 2>/dev/null || true)
  eval "bin_$p=\$path"
  [ -z "$path" ] || found="$found $p"
done
[ -n "$found" ] || die "no agent on this machine's PATH (pi, claude or codex)"

version=$("$node" -e 'process.stdout.write(require(process.argv[1]).version)' "$tree/package.json")
build=$("$node" "$tree/host/main.js" build | "$node" -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(0, "utf8")).build)') ||
  die "the host couldn't say its build"

# The PATH for its core terminals: node's and hc's folders first, then this login shell's.
path="$(dirname "$node"):$(dirname "$hc"):$PATH"
mkdir -p "$app/mods/chat" "$app/data/herdr-chat"
"$node" -e 'const [file, host, node, hc, version, build, path, pi, claude, codex] = process.argv.slice(1);
const agents = Object.fromEntries(Object.entries({ pi, claude, codex }).filter(([, v]) => v));
require("fs").writeFileSync(file, JSON.stringify({ host, node, hc, version, build, installedAt: Date.now(), channel: "machine", update: null, path, ...agents }, null, 2) + "\n")' \
  "$app/mods/chat/config.json" "$link/bin/herdr-chat-host" "$node" "$hc" "$version" "$build" "$path" "$bin_pi" "$bin_claude" "$bin_codex"
echo "herdr-chat: $version on $(hostname -s): host $link/bin/herdr-chat-host, node $("$node" --version), agents:$found"
echo "herdr-chat: wrote $app/mods/chat/config.json"
