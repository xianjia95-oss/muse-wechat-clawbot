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
probe_output="$(sh "$hook")"
case "$probe_output" in 'wake: Muse 微信桥 readiness: bridge_probe_unavailable'*) ;; *) printf '%s\n' "$probe_output" >&2; exit 1 ;; esac
[ "$(sh "$hook")" = silent ]
node -e 'const fs=require("fs"),p=process.env.HOME+"/.cache/muse-link/hook-alert-state.json",v=JSON.parse(fs.readFileSync(p)); if (!v.problems.includes("bridge_probe_unavailable") || (fs.statSync(p).mode & 0o777)!==0o600) process.exit(1)'
# Even a missing-helper alert must retain its detection time and one-result format.
MUSE_LINK_HOOK_FORMAT=hatch MUSE_LINK_HOOK_HELPER="$HOME/missing-helper.mjs" sh "$hook" | node -e '
let input=""; for await (const chunk of process.stdin) input+=chunk;
const lines=input.trim().split("\n"); if(lines.length!==1) process.exit(1);
const value=JSON.parse(lines[0].slice("HATCH_HOOK_RESULT:".length));
if(value.decision!=="wake" || !/hook_detector_missing; detected_at=\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ; recheck current status/.test(value.reason)) process.exit(1);
' --input-type=module
# Job-result wakeups must bypass the health alert cooldown, even with no inbox.
job_root="$HOME/.local/state/muse-link-worker/jobs"
mkdir -p "$job_root/complete"
chmod 700 "$job_root" "$job_root/complete"
printf '%s\n' '{"id":"complete","state":"succeeded","settled_at":null}' > "$job_root/complete/job.json"
[ "$(sh "$hook")" = 'wake: Muse 有 1 个后台任务或结果待处理' ]
node "$target/current/scripts/tool-job.mjs" settle --dir "$job_root" --id complete --reviewed
[ "$(sh "$hook")" = silent ]
# Runnable durable queue entries also wake without dispatching from the detector.
mkdir -m 700 "$job_root/queued"
node --input-type=module - "$job_root/queued/job.json" <<'JS'
import { writeFileSync } from 'node:fs';
writeFileSync(process.argv[2], JSON.stringify({ id: 'queued', kind: 'io', state: 'queued', queue_sequence: 1,
  created_at: new Date().toISOString(), start_before: new Date(Date.now() + 60000).toISOString() }), { mode: 0o600 });
JS
[ "$(sh "$hook")" = 'wake: Muse 有 1 个后台任务或结果待处理' ]
node --input-type=module - "$job_root/queued/job.json" <<'JS'
import { readFileSync } from 'node:fs';
if (JSON.parse(readFileSync(process.argv[2])).state !== 'queued') process.exit(1);
JS
node "$target/current/scripts/tool-job.mjs" cancel --dir "$job_root" --id queued
node "$target/current/scripts/tool-job.mjs" settle --dir "$job_root" --id queued --reviewed
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
# Custom platform adaptation survives both upgrade and subsequent rollback.
# In particular rollback must not restore an old plain detector over it.
cat > "$hook" <<'SH'
#!/bin/sh
printf '%s\n' 'HATCH_HOOK_RESULT:{"decision":"silent","reason":"platform adapter retained"}'
SH
custom_hash="$(sha256sum "$hook")"
bash /work/deploy/install.sh
[ "$(sha256sum "$hook")" = "$custom_hash" ]
cmp -s "$hook" "$target/current/hook.sh"
printf '# local platform adjustment\n' >> "$hook"
custom_hash="$(sha256sum "$hook")"
bash "$target/rollback.sh"
[ "$(sha256sum "$hook")" = "$custom_hash" ]
[ "$(sh "$hook")" = 'HATCH_HOOK_RESULT:{"decision":"silent","reason":"platform adapter retained"}' ]
if grep -Eq '^(start|restart|enable)' "$TEST_CALLS"; then exit 1; fi
printf 'PASS: Linux install, failure isolation, upgrade backup, rollback, private config, bounded hook and custom adapter preservation\n'
