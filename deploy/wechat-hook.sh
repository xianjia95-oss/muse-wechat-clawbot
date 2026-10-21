#!/bin/sh
# Muse must adapt this detector output to its actual hooks return protocol.
set -eu
BIN="${MUSE_LINK:-$HOME/.local/bin/muse-link}"
MARK="$HOME/.cache/muse-link/hook-alerted"
if count="$("$BIN" inbox count)"; then
    case "$count" in ''|*[!0-9]*) reason='invalid inbox count' ;; *) reason='' ;; esac
else
    reason='cannot read inbox; inspect muse-link status and logs'
fi
if [ -z "$reason" ] && [ "$count" -gt 0 ]; then
    printf 'wake: 微信有 %s 条新事件\n' "$count"
    exit 0
fi
if [ -z "$reason" ]; then
    if "$BIN" health >/dev/null 2>&1; then
        rm -f "$MARK"
        printf 'silent\n'
        exit 0
    fi
    reason='muse-link health failed; inspect poll, storage, unresolved sends and worker backlog'
fi
if [ -f "$MARK" ] && [ -z "$(find "$MARK" -mmin +60 2>/dev/null)" ]; then
    printf 'silent\n'
else
    mkdir -p "$(dirname "$MARK")"
    touch "$MARK"
    printf 'wake: Muse 微信桥异常：%s\n' "$reason"
fi
