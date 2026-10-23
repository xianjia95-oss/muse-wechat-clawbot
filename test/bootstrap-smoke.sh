#!/usr/bin/env bash
# Offline fixture: no GitHub, WeChat, real login or system manager is contacted.
set -euo pipefail
[ -e /.dockerenv ] && [ "$(id -u)" -eq 0 ] || exit 1
test_root="$(mktemp -d /tmp/muse-link-bootstrap-test.XXXXXXXX)"
export TEST_ROOT="$test_root"
export TEST_REAL_NODE="$(command -v node)"
mkdir -p "$test_root/tools" /run/systemd/system /etc/systemd/system
node -e 'for (const path of require("/work/scripts/public-files.json")) console.log(path)' > "$test_root/public-files"
tar -czf "$test_root/source.tar.gz" --transform='s|^|repository-fixture/|' -C /work -T "$test_root/public-files"
cat > "$test_root/tools/curl" <<'SH'
#!/usr/bin/env bash
set -eu
out='' url=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    --output) out=$2; shift 2 ;;
    https://*) url=$1; shift ;;
    *) shift ;;
  esac
done
printf '%s\n' "$url" >> "$TEST_ROOT/download.calls"
case "$url" in
  https://api.github.com/repos/xianjia95-oss/muse-wechat-clawbot/commits/*)
    if [ "${TEST_BAD_METADATA:-0}" = 1 ]; then printf '{"sha":"not-a-commit"}' > "$out"
    else printf '{"sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}' > "$out"; fi ;;
  https://codeload.github.com/xianjia95-oss/muse-wechat-clawbot/tar.gz/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa)
    [ "${TEST_DOWNLOAD_FAIL:-0}" = 0 ] || exit 22
    cp "$TEST_ROOT/source.tar.gz" "$out" ;;
  *) exit 81 ;;
esac
SH
cat > "$test_root/tools/systemctl" <<'SH'
#!/usr/bin/env bash
set -eu
printf '%s\n' "$*" >> "$HOME/systemctl.calls"
case "$1" in
  show) printf 'fixture\n' ;;
  is-active) [ "${TEST_FORCE_ACTIVE:-0}" = 1 ] || [ -f "$HOME/service.active" ] ;;
  daemon-reload) exit 0 ;;
  enable)
    [ "$*" = 'enable --now muse-link.service' ]
    [ "${TEST_START_FAIL:-0}" = 0 ] || exit 12
    touch "$HOME/service.active" ;;
  *) exit 82 ;;
esac
SH
cat > "$test_root/tools/npm" <<'SH'
#!/usr/bin/env bash
set -eu
[ "${TEST_NPM_FAIL:-0}" = 0 ] || exit 41
stage=''
while [ "$#" -gt 0 ]; do
  if [ "$1" = --prefix ]; then shift; stage=$1; fi
  shift
done
ln -s /work/node_modules "$stage/node_modules"
SH
cat > "$test_root/tools/node" <<'SH'
#!/usr/bin/env bash
set -eu
args=("$@")
for ((i=0; i<${#args[@]}-1; i++)); do
  if [[ "${args[i]}" == */src/cli.mjs ]]; then
    case "${args[i+1]}" in
      login)
        printf '{"event":"qr","file":"fixture-only-not-a-real-qr.png"}\n'
        [ "${TEST_LOGIN_FAIL:-0}" = 0 ] || exit 7
        if [ "${TEST_LOGIN_HOLD:-0}" = 1 ]; then
          while [ ! -f "$HOME/release-login" ]; do sleep 0.05; done
        fi
        printf '{"logged_in":true}\n'; exit 0 ;;
      health) printf '{"healthy":true}\n'; exit 0 ;;
      status) printf '{"logged_in":true,"poll":{"state":"waiting"}}\n'; exit 0 ;;
    esac
  fi
done
exec "$TEST_REAL_NODE" "$@"
SH
chmod 755 "$test_root/tools/"*
export PATH="$test_root/tools:$PATH"
new_home() { export HOME; HOME="$(mktemp -d "$test_root/home.XXXXXXXX")"; }
wait_state() {
  local run=$1 expected=$2
  for ((i=0; i<120; i++)); do
    if [ -f "$run/state.json" ] && grep -q "\"stage\":\"$expected\"" "$run/state.json"; then return; fi
    sleep 0.05
  done
  cat "$run/setup.log" >&2
  return 1
}
latest_run() { find "$HOME/.local/state/muse-link-setup" -maxdepth 1 -name 'attempt.*' -type d | sort | tail -1; }
no_start() { ! grep -Eq '^(start|restart|enable)' "$HOME/systemctl.calls"; }

# Argument validation and preflight failures leave installation untouched.
new_home
if bash /work/deploy/bootstrap.sh --ref; then exit 1; fi
if bash /work/deploy/bootstrap.sh --ref '--invalid'; then exit 1; fi
if bash /work/deploy/bootstrap.sh --unknown; then exit 1; fi
if TEST_FORCE_ACTIVE=1 bash /work/deploy/bootstrap.sh; then exit 1; fi
[ ! -e "$HOME/.local/share/muse-link" ]
[ ! -e "$test_root/download.calls" ]
mkdir -p "$HOME/.cache/muse-link-bootstrap"
exec 7> "$HOME/.cache/muse-link-bootstrap/install.lock"
flock -n 7
if bash /work/deploy/bootstrap.sh; then exit 1; fi
exec 7>&-
[ ! -e "$test_root/download.calls" ]

# A first-time install uses an immutable commit and creates private config.
new_home
bash /work/deploy/bootstrap.sh --install-only
target="$HOME/.local/share/muse-link"
bin="$HOME/.local/bin/muse-link"
[ -L "$target/current" ] && [ -x "$bin" ]
[ "$(cat "$target/current/source-commit.txt")" = aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa ]
[ "$(stat -c %a "$HOME/.config/muse-link/config.json")" = 600 ]
[ ! -d "$HOME/.local/state/muse-link-setup" ]
grep -q '/tar.gz/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa$' "$test_root/download.calls"
no_start

# A failed QR login must never start the service; preserve the precise exit code.
TEST_LOGIN_FAIL=1 bash "$target/current/deploy/activate.sh"
run="$(latest_run)"
wait_state "$run" failed
grep -q '"exit_code":7' "$run/state.json"
no_start

# Only the owner of the activation lock may login and enable the service.
TEST_LOGIN_HOLD=1 bash "$target/current/deploy/activate.sh"
for ((i=0; i<120; i++)); do
  running_run=''
  for candidate in "$HOME/.local/state/muse-link-setup"/attempt.*; do
    if [ -f "$candidate/state.json" ] && grep -q '"stage":"waiting_for_scan"' "$candidate/state.json"; then running_run=$candidate; break; fi
  done
  [ -z "$running_run" ] || break
  sleep 0.05
done
[ -n "$running_run" ]
count_before="$(find "$HOME/.local/state/muse-link-setup" -name state.json | wc -l)"
bash "$target/current/deploy/activate.sh"
for ((i=0; i<120; i++)); do
  count_after="$(find "$HOME/.local/state/muse-link-setup" -name state.json | wc -l)"
  [ "$count_after" -gt "$count_before" ] && break
  sleep 0.05
done
grep -rl 'Another login/setup flow is running' "$HOME/.local/state/muse-link-setup"/attempt.*/setup.log >/dev/null
no_start
touch "$HOME/release-login"
wait_state "$running_run" bridge_ready
[ "$(stat -c %a "$running_run")" = 700 ] && [ "$(stat -c %a "$running_run/setup.log")" = 600 ]
grep -q '"native_workers_created":false' "$running_run/state.json"
[ "$(grep -c '^enable --now muse-link.service$' "$HOME/systemctl.calls")" = 1 ]

# Already-running activation does not log in or restart. Existing bootstrap
# refuses before download and preserves the original private configuration.
before="$(sha256sum "$HOME/.config/muse-link/config.json")"
downloads="$(wc -l < "$test_root/download.calls")"
if bash /work/deploy/bootstrap.sh; then exit 1; fi
[ "$(sha256sum "$HOME/.config/muse-link/config.json")" = "$before" ]
[ "$(wc -l < "$test_root/download.calls")" = "$downloads" ]
bash "$target/current/deploy/activate.sh"
for ((i=0; i<120; i++)); do
  if grep -rl '"stage":"bridge_already_running"' "$HOME/.local/state/muse-link-setup"/attempt.*/state.json >/dev/null; then break; fi
  sleep 0.05
done
grep -rl '"stage":"bridge_already_running"' "$HOME/.local/state/muse-link-setup"/attempt.*/state.json >/dev/null
[ "$(grep -c '^enable --now muse-link.service$' "$HOME/systemctl.calls")" = 1 ]

# A service start failure must not turn a successful QR login into bridge_ready.
rm -f "$HOME/service.active"
TEST_START_FAIL=1 bash "$target/current/deploy/activate.sh"
for ((i=0; i<120; i++)); do
  if grep -rl '"exit_code":12' "$HOME/.local/state/muse-link-setup"/attempt.*/state.json >/dev/null; then break; fi
  sleep 0.05
done
grep -rl '"exit_code":12' "$HOME/.local/state/muse-link-setup"/attempt.*/state.json >/dev/null
[ ! -f "$HOME/service.active" ]

new_home
mkdir -p "$HOME/.config/muse-link"
printf 'preserve-existing-config\n' > "$HOME/.config/muse-link/config.json"
if bash /work/deploy/bootstrap.sh; then exit 1; fi
[ "$(cat "$HOME/.config/muse-link/config.json")" = preserve-existing-config ]
[ ! -e "$HOME/.local/share/muse-link" ]

# Source metadata/download failures never execute install or create config.
new_home
if TEST_BAD_METADATA=1 bash /work/deploy/bootstrap.sh; then exit 1; fi
[ ! -e "$HOME/.config/muse-link/config.json" ]
new_home
if TEST_DOWNLOAD_FAIL=1 bash /work/deploy/bootstrap.sh; then exit 1; fi
[ ! -e "$HOME/.config/muse-link/config.json" ]
new_home
if TEST_NPM_FAIL=1 bash /work/deploy/bootstrap.sh; then exit 1; fi
[ ! -e "$HOME/.local/share/muse-link/current" ]
no_start

# Default command submits the real activation flow after installation.
new_home
bash /work/deploy/bootstrap.sh
for ((i=0; i<120; i++)); do
  run="$(latest_run)"
  if [ -n "$run" ] && [ -f "$run/state.json" ] && grep -q '"stage":"bridge_ready"' "$run/state.json"; then break; fi
  sleep 0.05
done
wait_state "$run" bridge_ready
[ -f "$HOME/service.active" ]
printf 'PASS: immutable-source bootstrap, install-only, failure isolation, existing deployment protection, private login, single login owner and login-before-start\n'
