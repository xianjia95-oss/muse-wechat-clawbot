// Return metadata only, never a token or task content. Keep the compatibility
// error code stale_lease while distinguishing its actual rejection reasons.
export function inspectLease(row, token, now = Date.now()) {
  const lease_reason = typeof token !== 'string' || !token ? 'missing_token'
    : !row ? 'event_not_found'
      : row.acked_ms !== null ? 'event_acknowledged'
        : row.lease_until <= now ? 'lease_expired'
          : row.lease_token !== token ? 'token_mismatch' : null;
  return { lease_reason, lease_until: row?.lease_until ?? null, acked_ms: row?.acked_ms ?? null, server_time: now };
}
