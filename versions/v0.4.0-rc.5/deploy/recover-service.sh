#!/usr/bin/env bash
# Keep one OS lock across inspection, unit repair, startup and durable result.
set -euo pipefail
umask 077
mode="${1:---check}"
if [ "$mode" = --help ]; then
    printf 'Usage: bash deploy/recover-service.sh [--check|--apply]\n'
    exit 0
fi
die() { printf '{"ok":false,"reason":"recovery_preflight_failed"}\n' >&2; exit 1; }
[ "$#" -le 1 ] && { [ "$mode" = --check ] || [ "$mode" = --apply ]; } || die
[ "$(uname -s)" = Linux ] || die
for tool in node flock stat readlink; do command -v "$tool" >/dev/null || die; done
[[ "$HOME" =~ ^/[a-zA-Z0-9_./-]+$ ]] || die
[ "$(stat -c %u "$HOME")" = "$(id -u)" ] || die
directory="$HOME/.local/state/muse-link-recovery"
mkdir -p "$directory"
[ ! -L "$directory" ] && [ "$(stat -c %u "$directory")" = "$(id -u)" ] || die
[ "$(readlink -f "$directory")" = "$directory" ] || die
chmod 0700 "$directory"
[ ! -L "$directory/recovery.lock" ] || die
exec 9>"$directory/recovery.lock"
if ! flock -n 9; then
    printf '{"ok":false,"reason":"recovery_locked","exit_code":2}\n'
    exit 2
fi
# The shell retains fd 9 until Node and all its bounded operations finish.
source_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
node "$source_root/scripts/recover-service.mjs" "$mode"
