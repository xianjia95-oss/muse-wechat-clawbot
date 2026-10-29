#!/bin/bash
# Shared monitor lock, never the live bridge database lock.
set -euo pipefail
umask 077
if [ "${1:-}" = --help ]; then
    printf 'Usage: bash deploy/patrol.sh [--check] [--config FILE] [--job-dir DIR] [--format json|hook]\n'
    exit 0
fi
directory="${MUSE_LINK_PATROL_STATE_DIR:-$HOME/.local/state/muse-link-patrol}"
[[ "$directory" = /* ]] || exit 2
[[ ! -L "$directory" ]] || exit 2
mkdir -p -- "$directory"
[[ "$(realpath -- "$directory")" = "$directory" ]] || exit 2
[[ "$(stat -c %u -- "$directory")" = "$(id -u)" ]] || exit 2
# mkdir inherits a parent's setgid bit even with umask 077. Normalize only this
# canonical, owned, dedicated monitor directory before opening any state files.
# GNU chmod preserves directory setgid with 0700; explicitly clear special bits.
chmod u=rwx,go=,u-s,g-s,o-t -- "$directory"
[[ "$(stat -c %a -- "$directory")" = 700 ]] || exit 2
lock="$directory/patrol.lock"
[[ ! -L "$lock" && ( ! -e "$lock" || -f "$lock" ) ]] || exit 2
exec 9>>"$lock"
[[ "$(stat -c %u -- "$lock")" = "$(id -u)" && "$(stat -c %a -- "$lock")" = 600 && "$(stat -c %h -- "$lock")" = 1 ]] || exit 2
if ! flock -n 9; then
    if [[ " $* " = *' --format hook '* ]]; then printf 'silent\n';
    else printf '{"mode":"patrol","decision":"silent","skipped":"patrol_locked","notification":{"notify_user":false}}\n'; fi
    exit 0
fi
source_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
NODE="${MUSE_LINK_NODE:-$(command -v node)}"
[[ "$NODE" = /* && -x "$NODE" ]] || exit 2
"$NODE" "$source_root/scripts/patrol.mjs" "$@"
