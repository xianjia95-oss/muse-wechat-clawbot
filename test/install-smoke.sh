#!/usr/bin/env bash
# Run only in a disposable Linux container; no real system manager is used.
set -euo pipefail
[ -e /.dockerenv ] && [ "$(id -u)" -eq 0 ] || exit 1
task_home="$(mktemp -d /tmp/muse-link-install.XXXXXXXX)"
export HOME="$task_home"
mkdir -p "$HOME/tools" /etc/systemd/system /run/systemd/system
export TEST_CALLS="$HOME/systemctl.calls"
cat > "$HOME/tools/systemctl" <<'SH'
#!/bin/sh
printf '%s\n' "$*" >> "$TEST_CALLS"
case "$1" in
 show) echo test ;;
 is-active) [ "${TEST_SERVICE_ACTIVE:-0}" = 1 ] && exit 0; exit 3 ;;
 daemon-reload) exit 0 ;;
 *) exit 99 ;;
esac
SH
cat > "$HOME/tools/npm" <<'SH'
#!/bin/sh
[ "${TEST_NPM_FAIL:-0}" = 0 ] || exit 41
while [ "$#" -gt 0 ]; do
  if [ "$1" = --prefix ]; then shift; stage="$1"; fi
  shift
done
ln -s /work/node_modules "$stage/node_modules"
SH
chmod 755 "$HOME/tools/systemctl" "$HOME/tools/npm"
export PATH="$HOME/tools:$PATH"
bash /work/deploy/install.sh
target="$HOME/.local/share/muse-link"
bin="$HOME/.local/bin/muse-link"
unit=/etc/systemd/system/muse-link.service
hook="$HOME/hooks/scripts/muse-link-wechat.sh"
[ -f "$HOME/.config/muse-link/config.json" ]
[ "$(stat -c %a "$HOME/.config/muse-link/config.json")" = 600 ]
[ "$("$bin" inbox count)" = 0 ]
# Read-only hook diagnostics must not create or migrate an offline database.
[ ! -e "$HOME/.local/state/muse-link/bridge.sqlite" ]
[ "$(sh "$hook")" = 'wake: Muse 微信桥异常：muse-link health failed; inspect poll, storage, unresolved sends and worker backlog' ]
[ "$(sh "$hook")" = silent ]
grep -q '^ExecStart=/usr/local/bin/node .*/current/src/cli.mjs run$' "$unit"
first="$(readlink -f "$target/current")"
[ -f "$first/scripts/observe.mjs" ] && [ -f "$first/docs/PRODUCTION.md" ] && [ -f "$first/config.example.json" ]
config_hash="$(sha256sum "$HOME/.config/muse-link/config.json")"
unit_hash="$(sha256sum "$unit")"
hook_hash="$(sha256sum "$hook")"
if TEST_NPM_FAIL=1 bash /work/deploy/install.sh; then exit 1; fi
[ "$(readlink -f "$target/current")" = "$first" ]
[ "$(sha256sum "$unit")" = "$unit_hash" ]
[ "$(sha256sum "$hook")" = "$hook_hash" ]
[ "$(find "$target/releases" -mindepth 1 -maxdepth 1 -type d | wc -l)" -eq 1 ]
if TEST_SERVICE_ACTIVE=1 bash /work/deploy/install.sh; then exit 1; fi
[ "$(readlink -f "$target/current")" = "$first" ]
"$bin" maintain
bash /work/deploy/install.sh
second="$(readlink -f "$target/current")"
[ "$first" != "$second" ]
[ "$(readlink -f "$target/previous")" = "$first" ]
[ "$(sha256sum "$HOME/.config/muse-link/config.json")" = "$config_hash" ]
[ "$(find "$target/backups" -name manifest.json | wc -l)" -eq 1 ]
bash "$target/rollback.sh"
[ "$(readlink -f "$target/current")" = "$first" ]
[ "$(readlink -f "$target/previous")" = "$second" ]
[ "$(find "$target/backups" -name manifest.json | wc -l)" -eq 2 ]
if grep -Eq '^(start|restart|enable)' "$TEST_CALLS"; then exit 1; fi
printf 'PASS: Linux install, failed-stage isolation, active-service refusal, upgrade backup, rollback, private config and real hook\n'
