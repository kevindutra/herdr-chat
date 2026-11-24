#!/bin/sh
# Install herdr-chat's host on another machine (`hc machine ls`), so chats in that machine's spaces
# run there: their host, agent and session (herdr-app/mods/chat/machine.js).
#
#   install/machine.sh <machine>     from a clone, on the computer with the Herdr app
#
# It builds the release here (scripts/build.mjs, Node 20+ with the dev dependencies), copies the
# archive over hc, unpacks it to ~/.local/share/herdr-chat/<version> there, points `current` at it,
# and runs install/machine-setup.sh in that machine's login shell, which writes
# ~/.config/herdr-app/mods/chat/config.json there (the host, node, hc, the agents and the login
# PATH: a core terminal there lacks it). No Herdr app is needed on that machine, only herdr-core
# (hc machine add) and an agent. Run it again after changing the host, as ./install.sh here.
set -eu

die() { echo "herdr-chat: $*" >&2; exit 1; }
say() { echo "herdr-chat: $*"; }

m=${1:-}
[ -n "$m" ] || die "usage: install/machine.sh <machine>   (a name from hc machine ls)"
root=$(cd "$(dirname "$0")/.." && pwd)
command -v hc >/dev/null 2>&1 || die "hc not on PATH"
command -v node >/dev/null 2>&1 || die "node not on PATH (the build needs Node 20+)"

hc exec --on "$m" /usr/bin/true >/dev/null 2>&1 || die "can't reach $m over hc (hc machine ls)"

say "building the release"
tgz=$(cd "$root" && node scripts/build.mjs | tail -1)
[ -f "$tgz" ] || die "the build wrote no archive"
name=$(basename "$tgz" .tar.gz)
version=${name#herdr-chat-}

say "copying $name.tar.gz to $m"
hc exec -i --on "$m" /bin/sh -c 'mkdir -p "${XDG_DATA_HOME:-$HOME/.local/share}/herdr-chat" && cat > "${XDG_DATA_HOME:-$HOME/.local/share}/herdr-chat/incoming.tar.gz"' < "$tgz" ||
  die "copying to $m failed"

say "unpacking on $m"
# shellcheck disable=SC2016
hc exec --on "$m" /bin/sh -c '
set -e
base="${XDG_DATA_HOME:-$HOME/.local/share}/herdr-chat"; v="$1"
rm -rf "$base/.unpack"; mkdir -p "$base/.unpack"
tar -xzf "$base/incoming.tar.gz" -C "$base/.unpack"
rm -rf "$base/$v"; mv "$base/.unpack/herdr-chat-$v" "$base/$v"
rm -rf "$base/.unpack" "$base/incoming.tar.gz"
ln -sfn "$v" "$base/current"
' sh "$version" || die "unpacking on $m failed"

say "recording the host on $m (its login shell)"
# The login shell, interactive: the PATH its terminals and agents normally have (asdf, ~/.local/bin…).
# shellcheck disable=SC2016
ok=0
out=$(hc exec --on "$m" /bin/sh -c 'exec "${SHELL:-/bin/sh}" -lic "sh \"\$0\"" "${XDG_DATA_HOME:-$HOME/.local/share}/herdr-chat/current/install/machine-setup.sh" </dev/null' 2>/dev/null) || ok=$?
printf '%s\n' "$out" | grep '^herdr-chat:' || true
[ "$ok" = 0 ] || die "the setup on $m failed (run it there: sh ~/.local/share/herdr-chat/current/install/machine-setup.sh)"
say "done: chats in $m's spaces run there (New chat in one of its spaces, or Continue as chat on its agents)"
