#!/usr/bin/env bash
# First-time Linux installation. Existing deployments use the upgrade guide.
set -euo pipefail
umask 077
REPOSITORY='xianjia95-oss/muse-wechat-clawbot'
ref=main
install_only=0
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
usage() {
    cat <<'HELP'
Muse Link first-time setup (Linux, Node.js 24+, systemd)
Usage: bash bootstrap.sh [--ref BRANCH_TAG_OR_COMMIT] [--install-only]
  Default: install, launch a private QR login, then start the bridge on login.
  --install-only: install without login, service start or worker creation.
  Existing installations are left unchanged; follow docs/MUSE.md to upgrade.
HELP
}
while [ "$#" -gt 0 ]; do
    case "$1" in
        --help|-h) usage; exit 0 ;;
        --ref) [ "$#" -ge 2 ] || die '--ref requires a value.'; ref=$2; shift 2 ;;
        --install-only) install_only=1; shift ;;
        *) die "Unknown option: $1 (use --help)." ;;
    esac
done
[[ "$ref" =~ ^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,199}$ ]] || die 'Invalid source ref.'
[ "$(uname -s)" = Linux ] || die 'Use the Muse Linux runtime; Windows/macOS are not supported by this installer.'
[[ "$HOME" =~ ^/[a-zA-Z0-9_./-]+$ ]] || die 'HOME must be an absolute path without spaces or special characters.'
[ "$(stat -c %u "$HOME")" = "$(id -u)" ] || die 'Run as the HOME owner, without sudo on the whole script.'
for tool in node npm curl tar gzip systemctl setsid nohup flock; do
    command -v "$tool" >/dev/null || die "Missing $tool. See docs/QUICKSTART.md for prerequisites."
done
node -e 'if (Number(process.versions.node.split(".")[0]) < 24) process.exit(1)' || die 'Install Node.js 24+ and npm, reopen the terminal, then retry.'
[ -d /run/systemd/system ] || die 'A running system systemd manager is required. See docs/QUICKSTART.md.'
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
# Current catalog layout; retain support for historical single-project commits.
source="$work/source"
if [ -d "$source/versions" ]; then
    source="$source/versions/v0.4.0-rc.7-owner"
fi
[ -d "$source" ] && [ ! -L "$source" ] || die 'The selected rc.7 source is missing or symbolic.'
for path in package.json package-lock.json deploy/install.sh deploy/activate.sh docs/QUICKSTART.md; do
    [ -f "$source/$path" ] && [ ! -L "$source/$path" ] || die 'The selected source does not contain this setup flow.'
done
node -e 'const fs=require("fs"); const pkg=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); if(pkg.version!=="0.4.0-rc.7") process.exit(1)' \
    "$source/package.json" || die 'Source version mismatch; rc.7 installation was not started.'
bash "$source/deploy/install.sh"
printf '%s\n' "$commit" > "$target/current/source-commit.txt"
printf '\nInstalled from commit %s.\n' "$commit"
exec 8>&-
if [ "$install_only" -eq 1 ]; then
    printf 'Install-only complete. Service remains stopped.\nNext: bash "%s/current/deploy/activate.sh"\n' "$target"
else
    bash "$target/current/deploy/activate.sh"
fi
