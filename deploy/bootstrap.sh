#!/usr/bin/env bash
# First-time Linux installation. Existing deployments use the upgrade guide.
set -euo pipefail
umask 077
REPOSITORY='xianjia95-oss/muse-wechat-clawbot'
ref=main
variant=v0.4.0-rc.7-owner
install_only=0
required_build=''
required_recovery=''
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
usage() {
    cat <<'HELP'
Muse Link first-time setup (Linux, Node.js 24+, systemd)
Usage: bash bootstrap.sh [--version VERSION] [--ref BRANCH_TAG_OR_COMMIT] [--install-only]
                         [--require-build BUILD] [--require-recovery REVISION]
  Versions: v0.3.0, v0.4.0-rc.5, v0.4.0-rc.7-owner
  Default version: v0.4.0-rc.7-owner (compatibility with its existing guide).
  rc.7 can launch QR activation; other versions print their next steps.
  --install-only: install without login, service start or worker creation.
  --require-build / --require-recovery: reject mismatched source before installation.
  Existing installations are left unchanged; follow docs/MUSE.md to upgrade.
HELP
}
while [ "$#" -gt 0 ]; do
    case "$1" in
        --help|-h) usage; exit 0 ;;
        --version) [ "$#" -ge 2 ] || die '--version requires a value.'; variant=$2; shift 2 ;;
        --ref) [ "$#" -ge 2 ] || die '--ref requires a value.'; ref=$2; shift 2 ;;
        --require-build) [ "$#" -ge 2 ] || die '--require-build requires a value.'; required_build=$2; shift 2 ;;
        --require-recovery) [ "$#" -ge 2 ] || die '--require-recovery requires a value.'; required_recovery=$2; shift 2 ;;
        --install-only) install_only=1; shift ;;
        *) die "Unknown option: $1 (use --help)." ;;
    esac
done
case "$variant" in v0.3.0|v0.4.0-rc.5|v0.4.0-rc.7-owner) ;; *) die 'Choose one of the three retained versions.' ;; esac
[[ "$ref" =~ ^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,199}$ ]] || die 'Invalid source ref.'
for required in "$required_build" "$required_recovery"; do
    [ -z "$required" ] || [[ "$required" =~ ^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$ ]] || die 'Invalid required revision.'
done
[ "$(uname -s)" = Linux ] || die 'Use the Muse Linux runtime; Windows/macOS are not supported by this installer.'
[[ "$HOME" =~ ^/[a-zA-Z0-9_./-]+$ ]] || die 'HOME must be an absolute path without spaces or special characters.'
[ "$(stat -c %u "$HOME")" = "$(id -u)" ] || die 'Run as the HOME owner, without sudo on the whole script.'
for tool in node npm curl tar gzip systemctl setsid nohup flock; do
    command -v "$tool" >/dev/null || die "Missing $tool. See INSTALL.md for prerequisites."
done
node -e 'if (Number(process.versions.node.split(".")[0]) < 24) process.exit(1)' || die 'Install Node.js 24+ and npm, reopen the terminal, then retry.'
[ -d /run/systemd/system ] || die 'A running system systemd manager is required. See INSTALL.md.'
systemctl show --property=Version --value >/dev/null || die 'Cannot reach the system systemd manager.'
if [ "$(id -u)" -ne 0 ]; then sudo -n true || die 'Noninteractive sudo is required; run as the Muse user, not sudo bash.'; fi
target="$HOME/.local/share/muse-link"
require_first_install() {
    if systemctl is-active --quiet muse-link.service; then
        die 'muse-link.service is already running; no changes made. Use status/health and the worker recovery guide.'
    fi
    if [ -e "$target" ] || [ -L "$target" ] || [ -e "$HOME/.config/muse-link/config.json" ] || [ -e "$HOME/.local/state/muse-link/bridge.sqlite" ]; then
        die 'An existing installation or state was found; no changes made. Follow docs/MUSE.md, do not delete config or SQLite.'
    fi
}
require_first_install
lock_dir="$HOME/.cache/muse-link-bootstrap"
[ ! -L "$lock_dir" ] || die 'Installer lock directory must not be a symbolic link.'
mkdir -p "$lock_dir"
chmod 0700 "$lock_dir"
exec 8> "$lock_dir/install.lock"
flock -n 8 || die 'Another installer is already running.'
# Recheck after taking the lock: another invocation may have finished meanwhile.
require_first_install
work="$(mktemp -d)"
cleanup() { rm -rf -- "$work"; }
trap cleanup EXIT
encoded_ref="$(node -p 'encodeURIComponent(process.argv[1])' "$ref")"
printf 'Resolving %s at %s ...\n' "$REPOSITORY" "$ref"
curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' \
    --connect-timeout 10 --max-time 60 \
    "https://api.github.com/repos/$REPOSITORY/commits/$encoded_ref" --output "$work/commit.json"
commit="$(node -e 'const v=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); if (!/^[a-f0-9]{40}$/.test(v.sha)) process.exit(1); console.log(v.sha)' "$work/commit.json")" || die 'Could not resolve a full source commit.'
printf 'Downloading source commit %s ...\n' "$commit"
curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' \
    --connect-timeout 10 --max-time 120 \
    "https://codeload.github.com/$REPOSITORY/tar.gz/$commit" --output "$work/source.tar.gz"
mkdir "$work/source"
tar -xzf "$work/source.tar.gz" --strip-components=1 --no-same-owner --no-same-permissions -C "$work/source"
source="$work/source/versions/$variant"
for path in package.json package-lock.json deploy/install.sh docs/MUSE.md; do
    [ -f "$source/$path" ] && [ ! -L "$source/$path" ] || die 'The selected source does not contain this setup flow.'
done
expected_version=${variant#v}
if [ "$variant" = v0.4.0-rc.7-owner ]; then expected_version=0.4.0-rc.7; fi
node -e '
const fs = require("fs");
const [file, version, build, recovery] = process.argv.slice(1);
const pkg = JSON.parse(fs.readFileSync(file, "utf8"));
if (pkg.version !== version || (build && pkg.muse_link_build !== build) ||
    (recovery && pkg.muse_link_recovery !== recovery)) process.exit(1);
' "$source/package.json" "$expected_version" "$required_build" "$required_recovery" \
    || die 'Source version/build/recovery mismatch; installation was not started. Use the matching verified package.'
bash "$source/deploy/install.sh"
# v0.3.0 installs directly; the two candidate versions use a current symlink.
installed="$target/current"
if [ "$variant" = v0.3.0 ]; then
    installed="$target"
    cp -R "$source/docs" "$source/deploy" "$installed/"
fi
printf '%s\n' "$commit" > "$installed/source-commit.txt"
printf '\nInstalled from commit %s.\n' "$commit"
exec 8>&-
if [ "$install_only" -eq 1 ]; then
    printf 'Install-only complete. Service remains stopped.\nNext: read "%s/docs/MUSE.md" for login, service and real Muse worker setup.\n' "$installed"
    if [ -f "$installed/docs/给Muse一键部署的指令.txt" ]; then
        printf 'Muse main agent: continue "%s/docs/给Muse一键部署的指令.txt"; bridge installation is not worker activation.\n' "$installed"
    fi
elif [ -f "$installed/deploy/activate.sh" ]; then
    bash "$installed/deploy/activate.sh"
else
    printf 'Bridge installed. Follow %s/docs/MUSE.md for login, service start and real Muse worker creation.\n' "$installed"
fi
