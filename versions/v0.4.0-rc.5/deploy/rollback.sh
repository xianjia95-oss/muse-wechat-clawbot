#!/usr/bin/env bash
set -euo pipefail
umask 077
TARGET="$HOME/.local/share/muse-link"
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
as_root() { if [ "$(id -u)" -eq 0 ]; then "$@"; else sudo -n "$@"; fi; }
[ "$(uname -s)" = Linux ] || die 'Linux is required.'
if systemctl is-active --quiet muse-link.service; then die 'Stop the service and pause its hook first.'; fi
[ -L "$TARGET/current" ] && [ -L "$TARGET/previous" ] || die 'No managed previous release.'
current="$(readlink -f "$TARGET/current")"
previous="$(readlink -f "$TARGET/previous")"
for release in "$current" "$previous"; do
    [[ "$release" == "$TARGET/releases/"* ]] && [ -f "$release/src/cli.mjs" ] && [ -f "$release/package.json" ] || die 'Invalid release target.'
done
stamp="$(date -u +%Y%m%dT%H%M%S)-$$"
# Older workers cannot enforce the new execution journal. Refuse rollback while
# work or uncertain outcomes still need reconciliation.
node --input-type=module - "$HOME/.config/muse-link/config.json" <<'JS'
import { readFileSync, existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
const value = JSON.parse(readFileSync(process.argv[2], 'utf8')).state_dir;
const file = join(resolve(value.startsWith('~/') ? join(homedir(), value.slice(2)) : value), 'bridge.sqlite');
if (existsSync(file)) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const pending = db.prepare('SELECT count(*) AS n FROM events WHERE acked_ms IS NULL').get().n;
    const unknown = db.prepare("SELECT count(*) AS n FROM sends WHERE state='unknown' AND coalesce(json_extract(result,'$.reviewed'),0)=0").get().n;
    const hasSteps = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='task_steps'").get();
    const steps = hasSteps ? db.prepare("SELECT count(*) AS n FROM task_steps WHERE state='started'").get().n : 0;
    if (pending || unknown || steps) throw new Error('Drain tasks and reconcile unknown sends/tool steps before rolling back.');
  } finally { db.close(); }
}
JS
node "$current/src/cli.mjs" backup --output "$TARGET/backups/pre-rollback-$stamp"
if [ -f "$previous/hook.sh" ]; then
    cp -p "$HOME/hooks/scripts/muse-link-wechat.sh" "$HOME/hooks/scripts/muse-link-wechat.sh.bak.$stamp"
    install -m 0700 "$previous/hook.sh" "$HOME/hooks/scripts/muse-link-wechat.sh"
fi
ln -s "$previous" "$TARGET/.rollback-current.$$"
ln -s "$current" "$TARGET/.rollback-previous.$$"
mv -Tf "$TARGET/.rollback-current.$$" "$TARGET/current"
mv -Tf "$TARGET/.rollback-previous.$$" "$TARGET/previous"
as_root systemctl daemon-reload
printf 'Rolled back code only; state/config preserved, service remains stopped. Match the Muse worker instructions to this version before starting.\n'
