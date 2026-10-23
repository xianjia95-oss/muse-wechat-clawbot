#!/usr/bin/env bash
# Detached first-login flow: lets Muse display QR images while login is waiting.
set -euo pipefail
umask 077
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
as_root() { if [ "$(id -u)" -eq 0 ]; then "$@"; else sudo -n "$@"; fi; }
[[ "$HOME" =~ ^/[a-zA-Z0-9_./-]+$ ]] || die 'Unsupported HOME path.'
[ "$(uname -s)" = Linux ] && [ "$(stat -c %u "$HOME")" = "$(id -u)" ] || die 'Run as the Muse Linux HOME owner.'
for tool in node systemctl setsid nohup flock; do command -v "$tool" >/dev/null || die "Missing $tool"; done
bin="$HOME/.local/bin/muse-link"
self="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/activate.sh"
[ -x "$bin" ] || die 'Install Muse Link first.'
[ -d /run/systemd/system ] || die 'A running system systemd manager is required.'
if [ "$(id -u)" -ne 0 ]; then sudo -n true || die 'Noninteractive sudo is required.'; fi
root="$HOME/.local/state/muse-link-setup"
[ ! -L "$root" ] || die 'Setup state must not be a symbolic link.'
mkdir -p "$root"
chmod 0700 "$root"
if [ "$#" -eq 0 ]; then
    run="$(mktemp -d "$root/attempt.XXXXXXXX")"
    setsid nohup bash "$self" --run "$run" > "$run/setup.log" 2>&1 < /dev/null &
    printf '%s\n' "$!" > "$run/pid"
    printf '\nQR login flow submitted in background (not yet logged in).\nPrivate log: %s/setup.log\nState: %s/state.json\n' "$run" "$run"
    printf 'Muse: read the log now and display the current event=qr PNG; follow verification_required if present.\n'
    printf 'The bridge starts only after login succeeds. Then execute:\n%s\n' "$HOME/.local/share/muse-link/current/docs/给Muse恢复常驻worker的指令.txt"
    printf 'Installation alone does not create the six native Muse workers. See docs/QUICKSTART.md.\n'
    exit 0
fi
[ "$#" -eq 2 ] && [ "$1" = --run ] || die 'Usage: bash deploy/activate.sh'
run=$2
[[ "$run" =~ ^"$root"/attempt\.[a-zA-Z0-9]+$ ]] && [ -d "$run" ] && [ ! -L "$run" ] || die 'Invalid private setup directory.'
[ "$(stat -c %u "$run")" = "$(id -u)" ] && [ "$(stat -c %a "$run")" = 700 ] || die 'Setup directory must be private and owned by the current user.'
write_state() {
    printf '{"stage":"%s","exit_code":%s,"at":"%s","native_workers_created":false}\n' \
        "$1" "${2:-0}" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$run/state.json.tmp"
    mv -f "$run/state.json.tmp" "$run/state.json"
}
on_exit() {
    code=$?
    if [ "$code" -ne 0 ]; then
        write_state failed "$code"
        printf 'Setup stopped (exit=%s); keep this private log. No worker pool has been created.\n' "$code" >&2
    fi
}
trap on_exit EXIT
exec 9> "$root/activation.lock"
flock -n 9 || die 'Another login/setup flow is running; use its existing private log and QR.'
if systemctl is-active --quiet muse-link.service; then
    write_state bridge_already_running
    printf 'Bridge already running; no restart or new login performed. Check status/health and create missing workers separately.\n'
    exit 0
fi
write_state waiting_for_scan
"$bin" login --qr-dir "$run" --timeout 10m
write_state starting_bridge
as_root systemctl enable --now muse-link.service
deadline=$((SECONDS + 75))
while [ "$SECONDS" -lt "$deadline" ]; do
    if "$bin" health > "$run/health.json" 2> "$run/health.stderr"; then
        "$bin" status
        write_state bridge_ready
        printf 'Bridge is healthy. Setup is not complete until Muse creates the native resident worker pool and a phone reply is verified.\n'
        exit 0
    fi
    sleep 2
done
write_state bridge_started_check_needed 3
printf 'Service start requested but readiness was not confirmed. Inspect private health.json/health.stderr and journalctl; do not reinstall or rescan blindly.\n' >&2
# Preserve the more specific state instead of replacing it with a generic failure.
trap - EXIT
exit 3
