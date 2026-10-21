#!/usr/bin/env bash
set -euo pipefail
umask 077
SOURCE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET="$HOME/.local/share/muse-link"
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
as_root() { if [ "$(id -u)" -eq 0 ]; then "$@"; else sudo -n "$@"; fi; }
[ "$(uname -s)" = Linux ] || die 'Run this installer in the Muse Linux runtime.'
[[ "$HOME" =~ ^/[a-zA-Z0-9_./-]+$ ]] || die 'HOME must be an absolute path without spaces or special characters.'
[ "$(stat -c %u "$HOME")" = "$(id -u)" ] || die 'Run as the Muse HOME owner, without sudo on the whole script.'
for tool in node npm systemctl setsid nohup; do command -v "$tool" >/dev/null || die "Missing $tool"; done
node -e 'if (Number(process.versions.node.split(".")[0]) < 24) process.exit(1)' || die 'Node.js 24+ is required.'
NODE="$(command -v node)"
[[ "$NODE" =~ ^/[a-zA-Z0-9_./-]+$ ]] || die 'Node executable path contains unsupported characters.'
[ -d /run/systemd/system ] || die 'A running system systemd manager is required.'
systemctl show --property=Version --value >/dev/null
if [ "$(id -u)" -ne 0 ]; then sudo -n true || die 'Root or noninteractive sudo is required.'; fi

mkdir -p "$TARGET" "$HOME/.local/bin" "$HOME/hooks/scripts" "$HOME/.config/muse-link"
chmod 0700 "$HOME/.config/muse-link"
if [ "$SOURCE" != "$TARGET" ]; then
    cp -R "$SOURCE/src" "$TARGET/"
    cp "$SOURCE/package.json" "$SOURCE/package-lock.json" "$TARGET/"
fi
npm ci --omit=dev --no-fund --prefix "$TARGET"
printf '#!/bin/sh\nexec "%s" --disable-warning=ExperimentalWarning "%s/src/cli.mjs" "$@"\n' "$NODE" "$TARGET" > "$HOME/.local/bin/muse-link"
chmod 0755 "$HOME/.local/bin/muse-link"
"$HOME/.local/bin/muse-link" init

work="$(mktemp -d "$HOME/.config/muse-link/install.XXXXXXXX")"
trap 'rm -rf -- "$work"' EXIT
env_file="$HOME/.config/muse-link/env"
touch "$env_file"
chmod 0600 "$env_file"
proxy_names=()
while IFS= read -r name; do
    case "${name,,}" in http_proxy|https_proxy|all_proxy|no_proxy) proxy_names+=("$name") ;; esac
done < <(compgen -e)
if [ "${#proxy_names[@]}" -gt 0 ]; then
    awk 'tolower($0) !~ /^(http_proxy|https_proxy|all_proxy|no_proxy)=/' "$env_file" > "$work/env"
    for name in "${proxy_names[@]}"; do
        value=${!name}
        [[ "$value" != *$'\n'* && "$value" != *$'\r'* ]] || die "Invalid newline in $name"
        value=${value//\\/\\\\}
        value=${value//\"/\\\"}
        printf '%s="%s"\n' "$name" "$value" >> "$work/env"
    done
    install -m 0600 "$work/env" "$env_file"
fi
sed -e "s|__HOME__|$HOME|g" -e "s|__USER__|$(id -un)|g" -e "s|__NODE__|$NODE|g" \
    "$SOURCE/deploy/muse-link.service.in" > "$work/muse-link.service"
unit=/etc/systemd/system/muse-link.service
if [ -f "$unit" ] && ! cmp -s "$work/muse-link.service" "$unit"; then
    as_root cp -p "$unit" "$unit.bak.$(date -u +%Y%m%dT%H%M%S).$$"
fi
as_root install -m 0644 "$work/muse-link.service" "$unit"
hook="$HOME/hooks/scripts/muse-link-wechat.sh"
if [ -f "$hook" ] && ! cmp -s "$SOURCE/deploy/wechat-hook.sh" "$hook"; then
    cp -p "$hook" "$hook.bak.$(date -u +%Y%m%dT%H%M%S).$$"
fi
install -m 0700 "$SOURCE/deploy/wechat-hook.sh" "$hook"
as_root systemctl daemon-reload
printf '\nInstalled. Follow docs/MUSE.md for migration/login, service start and hook registration.\n'
