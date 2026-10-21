#!/usr/bin/env bash
# Run only in a disposable Linux container; no real system manager is used.
set -euo pipefail
[ -e /.dockerenv ] && [ "$(id -u)" -eq 0 ] || exit 1
export HOME="$(mktemp -d /tmp/muse-link-install.XXXXXXXX)"
mkdir -p "$HOME/tools" /etc/systemd/system /run/systemd/system
export TEST_CALLS="$HOME/systemctl.calls"
cat > "$HOME/tools/systemctl" <<'SH'
#!/bin/sh
printf '%s\n' "$*" >> "$TEST_CALLS"
case "$1" in show) echo test ;; daemon-reload) exit 0 ;; *) exit 99 ;; esac
SH
cat > "$HOME/tools/npm" <<'SH'
#!/bin/sh
# Dependencies are the already installed pure-JS packages in the read-only workspace.
ln -s /work/node_modules "$HOME/.local/share/muse-link/node_modules"
SH
chmod 755 "$HOME/tools/systemctl" "$HOME/tools/npm"
export PATH="$HOME/tools:$PATH"
bash /work/deploy/install.sh
[ -f "$HOME/.config/muse-link/config.json" ]
[ "$(stat -c %a "$HOME/.config/muse-link/config.json")" = 600 ]
[ "$("$HOME/.local/bin/muse-link" inbox count)" = 0 ]
first="$(sh "$HOME/hooks/scripts/muse-link-wechat.sh")"
case "$first" in 'wake: Muse 微信桥异常：muse-link service is unreachable') ;; *) echo "$first"; exit 1 ;; esac
[ "$(sh "$HOME/hooks/scripts/muse-link-wechat.sh")" = silent ]
[ "$(wc -l < "$TEST_CALLS")" -eq 2 ]
grep -q '^daemon-reload$' "$TEST_CALLS"
grep -q '^ExecStart=/usr/local/bin/node ' /etc/systemd/system/muse-link.service
printf 'PASS: Linux installer, actual CLI, private config, real hook, no service start\n'
