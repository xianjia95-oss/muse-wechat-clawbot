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

if systemctl is-active --quiet muse-link.service; then die 'Stop muse-link.service and pause the Muse hook before upgrading.'; fi
mkdir -p "$TARGET/releases" "$HOME/.local/bin" "$HOME/hooks/scripts" "$HOME/.config/muse-link"
chmod 0700 "$HOME/.config/muse-link"
if [ -e "$TARGET/current" ] || [ -L "$TARGET/current" ]; then
    [ -L "$TARGET/current" ] || die 'Current release must be a managed symbolic link.'
    previous="$(readlink -f "$TARGET/current")"
    [[ "$previous" == "$TARGET/releases/"* ]] && [ -f "$previous/src/cli.mjs" ] || die 'Current release is outside managed releases or incomplete.'
fi
VERSION="$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).version' "$SOURCE/package.json")"
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+([a-zA-Z0-9.-]*)$ ]] || die 'Invalid package version.'
stage="$(mktemp -d "$TARGET/releases/$VERSION.XXXXXXXX")"
keep_stage=0
work=''
cleanup() {
    if [ -n "$work" ]; then rm -rf -- "$work"; fi
    if [ "$keep_stage" -eq 0 ] && [[ "$stage" == "$TARGET/releases/"* ]]; then rm -rf -- "$stage"; fi
}
trap cleanup EXIT
cp -R "$SOURCE/src" "$SOURCE/deploy" "$SOURCE/docs" "$SOURCE/scripts" "$stage/"
cp "$SOURCE/package.json" "$SOURCE/package-lock.json" "$SOURCE/config.example.json" "$SOURCE/README.md" "$SOURCE/THIRD-PARTY.md" "$SOURCE"/LICENSE* "$stage/"
npm ci --omit=dev --no-fund --prefix "$stage"
"$NODE" "$stage/src/cli.mjs" --help >/dev/null
"$NODE" "$stage/src/cli.mjs" init
state_dir="$("$NODE" -e 'const f=require("fs"),p=require("path"),o=require("os"); const v=JSON.parse(f.readFileSync(process.argv[1],"utf8")).state_dir; console.log(p.resolve(v.startsWith("~/")?p.join(o.homedir(),v.slice(2)):v))' "$HOME/.config/muse-link/config.json")"
if [ -f "$state_dir/bridge.sqlite" ]; then
    "$NODE" "$stage/src/cli.mjs" backup --output "$TARGET/backups/pre-upgrade-$(date -u +%Y%m%dT%H%M%S)-$$"
fi
cp "$SOURCE/deploy/wechat-hook.sh" "$stage/hook.sh"

work="$(mktemp -d "$HOME/.config/muse-link/install.XXXXXXXX")"
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
replace_hook=1
if [ -e "$hook" ] || [ -L "$hook" ]; then
    [ -f "$hook" ] && [ ! -L "$hook" ] || die 'Hook must be a regular file, not a symbolic link.'
    # Only an unchanged detector from the prior managed release is replaceable.
    # A platform wrapper may contain HATCH_HOOK_RESULT adaptation; preserving it
    # is required for wake delivery. Never guess its format from a substring.
    if ! cmp -s "$SOURCE/deploy/wechat-hook.sh" "$hook" &&
       { [ -z "${previous:-}" ] || ! cmp -s "$previous/deploy/wechat-hook.sh" "$hook"; }; then
        replace_hook=0
    fi
fi
if [ -f "$hook" ] && [ "$replace_hook" -eq 1 ] && ! cmp -s "$SOURCE/deploy/wechat-hook.sh" "$hook"; then
    hook_backup="$hook.bak.$(date -u +%Y%m%dT%H%M%S).$$"
    cp -p "$hook" "$hook_backup"
fi
if [ "$replace_hook" -eq 1 ]; then
    install -m 0700 "$SOURCE/deploy/wechat-hook.sh" "$hook"
else
    printf 'Preserved custom platform hook. Merge the new detector and dry_run its one-result output before enabling.\n'
fi
# Snapshot the actual adapter for inspection/rollback, separately from the
# versioned detector template used to recognize managed files on later upgrades.
cp -p "$hook" "$stage/hook.sh"
if [ -L "$TARGET/current" ]; then
    previous="$(readlink -f "$TARGET/current")"
    [[ "$previous" == "$TARGET/releases/"* ]] || die 'Current release is outside managed releases.'
    ln -s "$previous" "$TARGET/.previous.$$"
    mv -Tf "$TARGET/.previous.$$" "$TARGET/previous"
elif [ -d "$TARGET/src" ]; then
    legacy="$(mktemp -d "$TARGET/releases/legacy.XXXXXXXX")"
    cp -R "$TARGET/src" "$legacy/"
    cp "$TARGET/package.json" "$TARGET/package-lock.json" "$legacy/"
    if [ -d "$TARGET/node_modules" ]; then cp -R "$TARGET/node_modules" "$legacy/"; fi
    if [ -n "${hook_backup:-}" ]; then cp "$hook_backup" "$legacy/hook.sh"; fi
    ln -s "$legacy" "$TARGET/previous"
fi
ln -s "$stage" "$TARGET/.current.$$"
mv -Tf "$TARGET/.current.$$" "$TARGET/current"
keep_stage=1
printf '#!/bin/sh\nexec "%s" --disable-warning=ExperimentalWarning "%s/current/src/cli.mjs" "$@"\n' "$NODE" "$TARGET" > "$HOME/.local/bin/muse-link"
chmod 0755 "$HOME/.local/bin/muse-link"
install -m 0700 "$SOURCE/deploy/rollback.sh" "$TARGET/rollback.sh"
as_root systemctl daemon-reload
printf '\nInstalled %s. Service remains stopped. Read docs/PRODUCTION.md and update the hook lease-token protocol before start.\n' "$VERSION"
