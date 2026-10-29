#!/bin/sh
# Detector only. A custom platform adapter must emit exactly one result.
# Set MUSE_LINK_HOOK_FORMAT=hatch only when this script is not already wrapped.
set -eu
PROBE="${MUSE_LINK_HOOK_HELPER:-$HOME/.local/share/muse-link/current/scripts/hook-check.mjs}"
if [ -f "$PROBE" ]; then
    exec node "$PROBE"
fi
detected_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
if [ "${MUSE_LINK_HOOK_FORMAT:-plain}" = hatch ]; then
    printf 'HATCH_HOOK_RESULT:{"decision":"wake","reason":"hook_detector_missing; detected_at=%s; recheck current status before acting; inspect installation"}\n' "$detected_at"
else
    printf 'wake: hook_detector_missing; detected_at=%s; recheck current status before acting; inspect installation\n' "$detected_at"
fi
