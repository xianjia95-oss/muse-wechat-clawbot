// Copy to a private directory and implement the real Muse platform interface.
// stdin: a single muse-link-owner-watchdog/v1 request (inspect or ensure).
// inspect must enumerate the canonical slot and query tracked_handle explicitly.
// ensure must atomically validate expected_previous_handle, enforce one live
// owner, and persist recovery_id -> native handle BEFORE replying. Repeated IDs
// must resolve the original task, including after a timeout or runtime refresh.
// Only a native task startup/query API qualifies; shell background processes,
// hook wake messages and model promises do not implement this contract.
// See docs/OWNER_WATCHDOG.md for exact JSON and recovery restrictions.
process.stdin.resume();
process.stdin.on('end', () => {
  console.error(JSON.stringify({ error: 'platform_adapter_not_connected' }));
  process.exitCode = 1;
});
