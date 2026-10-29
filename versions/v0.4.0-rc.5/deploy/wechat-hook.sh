#!/bin/sh
# Muse adapts plain wake/silent to its actual platform protocol exactly once.
set -eu
PATROL="${MUSE_LINK_PATROL:-$HOME/.local/share/muse-link/current/deploy/patrol.sh}"
# Shared with scheduled patrol: no legacy CLI fallback or bridge database lock.
exec bash "$PATROL" --format hook \
    --config "${MUSE_LINK_CONFIG:-$HOME/.config/muse-link/config.json}" \
    --job-dir "${MUSE_LINK_JOB_DIR:-$HOME/.local/state/muse-link-worker/jobs}"
