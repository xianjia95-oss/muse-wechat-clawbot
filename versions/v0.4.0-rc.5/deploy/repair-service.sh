#!/usr/bin/env bash
# Rebuild only a missing unit from the installed rc.5; never reinstall or start.
set -euo pipefail
umask 077
mode="${1:---check}"
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
as_root() { if [ "$(id -u)" -eq 0 ]; then "$@"; else sudo -n "$@"; fi; }
[ "$#" -le 1 ] && { [ "$mode" = --check ] || [ "$mode" = --apply ]; } || die 'Use --check or --apply.'
[ "$(uname -s)" = Linux ] || die 'Linux with system systemd is required.'
[[ "$HOME" =~ ^/[a-zA-Z0-9_./-]+$ ]] || die 'Unsupported HOME path.'
[ "$(stat -c %u "$HOME")" = "$(id -u)" ] || die 'Run as the HOME owner.'
for tool in node systemctl flock readlink sed cmp install; do command -v "$tool" >/dev/null || die "Missing $tool"; done
node -e 'if (Number(process.versions.node.split(".")[0]) < 24) process.exit(1)' || die 'Node.js 24+ is required.'
[ -d /run/systemd/system ] || die 'A running system systemd manager is required.'
systemctl show --property=Version --value >/dev/null
target="$HOME/.local/share/muse-link"
[ -L "$target/current" ] || die 'Missing managed current release.'
release="$(readlink -f "$target/current")"
[[ "$release" == "$target/releases/"* ]] || die 'Release is outside the managed installation.'
for file in package.json src/cli.mjs deploy/muse-link.service.in; do [ -f "$release/$file" ] || die 'Incomplete installation.'; done
[ "$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).version' "$release/package.json")" = 0.4.0-rc.5 ] || die 'Installed version must be rc.5.'
node_path="$(command -v node)"
[[ "$node_path" =~ ^/[a-zA-Z0-9_./-]+$ ]] || die 'Unsupported Node path.'
user_name="$(id -un)"
[[ "$user_name" =~ ^[a-zA-Z0-9_.-]+$ ]] || die 'Unsupported user name.'
config_dir="$HOME/.config/muse-link"
[ -d "$config_dir" ] && [ ! -L "$config_dir" ] || die 'Missing private configuration directory.'
[ -f "$config_dir/config.json" ] && [ ! -L "$config_dir/config.json" ] || die 'Missing configuration; do not initialize over lost state.'
[ -f "$config_dir/env" ] && [ ! -L "$config_dir/env" ] || die 'Missing private service environment; verify it before repair.'
work="$(mktemp -d "$config_dir/service-repair.XXXXXXXX")"
trap 'rm -f -- "$work/muse-link.service"; rmdir -- "$work"' EXIT
sed -e "s|__HOME__|$HOME|g" -e "s|__USER__|$user_name|g" -e "s|__NODE__|$node_path|g" \
    "$release/deploy/muse-link.service.in" > "$work/muse-link.service"
if grep -Eq '__[A-Z_]+__' "$work/muse-link.service"; then die 'Unrendered service template.'; fi
unit=/etc/systemd/system/muse-link.service
if [ "$mode" = --apply ]; then
    [ "$(id -u)" -eq 0 ] || sudo -n true || die 'Noninteractive service-install permission is required.'
    # flock is released by the OS, including after a crash; never delete its file.
    exec 9>"$config_dir/service-repair.lock"
    flock -n 9 || die 'Another service repair is in progress.'
fi
[ ! -L "$unit" ] || die 'Existing service is a symlink; preserve it for review.'
if [ -e "$unit" ]; then
    cmp -s "$work/muse-link.service" "$unit" || die 'Existing service differs; preserve it for review.'
    if [ "$mode" = --apply ]; then as_root systemctl daemon-reload; fi
    printf '{"service_unit":"present","changed":false,"service_started":false}\n'
elif [ "$mode" = --check ]; then
    printf '{"service_unit":"missing","repair_available":true,"changed":false,"service_started":false}\n'
else
    as_root install -m 0644 "$work/muse-link.service" "$unit"
    as_root systemctl daemon-reload
    printf '{"service_unit":"restored","changed":true,"service_started":false}\n'
fi
