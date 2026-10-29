import { readdir, lstat, rm, rmdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { operational } from './config.mjs';
import { removeSnapshot } from './media.mjs';

const day = 86400000;
export async function maintain(bridge, now = Date.now()) {
  if (bridge.inflight.size || bridge.inbound.active.size || bridge.maintaining || bridge.stopping) return { skipped: 'busy' };
  bridge.maintaining = true;
  try {
    // Also rejects symlinks before traversing any state paths.
    bridge.resources.inspect();
    const { config, store } = bridge;
    const policy = operational(config);
    let media = 0, orphans = 0;
    const expired = store.db.prepare("SELECT m.request_id,m.part,m.body,s.state FROM media_jobs m JOIN sends s ON s.id=m.request_id WHERE s.created_ms<? AND s.state<>'pending' LIMIT 500").all(now - policy.failed_media_retention_days * day);
    for (const row of expired) {
      // Freeze failed intents before deleting their immutable retry snapshot.
      if (row.state === 'failed') {
        const prior = store.send(row.request_id);
        store.finish(row.request_id, 'unknown', { ...prior.result, state: 'unknown', retryable: false, error: 'media_retention_expired' });
      }
      await removeSnapshot(config, row.request_id, JSON.parse(row.body));
      store.deleteMedia(row.request_id, row.part);
      media++;
    }
    const referenced = new Set(store.db.prepare('SELECT body FROM media_jobs').all().map((row) => resolve(JSON.parse(row.body).cipher_path)));
    const walk = async (directory, root = false) => {
      let entries;
      try { entries = await readdir(directory, { withFileTypes: true }); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
      for (const entry of entries) {
        const path = join(directory, entry.name);
        const info = await lstat(path);
        if (info.isSymbolicLink()) throw new Error('Unsafe symlink in outbox');
        if (info.isDirectory()) await walk(path);
        else if (!referenced.has(resolve(path)) && info.mtimeMs < now - day) { await rm(path); orphans++; }
      }
      if (!root) { try { await rmdir(directory); } catch (error) { if (!['ENOTEMPTY', 'ENOENT'].includes(error.code)) throw error; } }
    };
    await walk(join(config.state_dir, 'outbox'), true);
    const expiredEvents = store.db.prepare("SELECT id FROM events e WHERE acked_ms IS NOT NULL AND acked_ms<? AND NOT EXISTS(SELECT 1 FROM task_steps t WHERE t.event_id=e.id AND t.state='started') LIMIT 500")
      .all(now - policy.event_retention_days * day);
    for (const { id } of expiredEvents) await bridge.inbound.remove(id);
    const pruned = store.transaction(() => {
      // Reply content is private and has the shorter event retention. Receipt
      // deduplication outlives it, including unknown and unfinished requests.
      let replyContents = store.db.prepare(`DELETE FROM reply_history WHERE request_id IN
        (SELECT request_id FROM reply_history WHERE recorded_ms<? ORDER BY recorded_ms,request_id LIMIT 500)`)
        .run(now - policy.event_retention_days * day).changes;
      const memories = store.db.prepare('DELETE FROM conversation_memory WHERE (binding,sender) IN (SELECT binding,sender FROM conversation_memory WHERE updated_ms<? LIMIT 500)')
        .run(now - policy.event_retention_days * day).changes;
      const events = store.db.prepare("SELECT id FROM events e WHERE acked_ms IS NOT NULL AND acked_ms<? AND NOT EXISTS(SELECT 1 FROM task_steps t WHERE t.event_id=e.id AND t.state='started') LIMIT 500").all(now - policy.event_retention_days * day);
      for (const { id } of events) {
        store.db.prepare('DELETE FROM inbound_media WHERE event_id=?').run(id);
        replyContents += store.db.prepare('DELETE FROM reply_history WHERE request_id IN (SELECT request_id FROM send_events WHERE event_id=?)').run(id).changes;
        store.db.prepare('DELETE FROM conversation_tasks WHERE event_id=?').run(id);
        store.db.prepare('DELETE FROM task_steps WHERE event_id=?').run(id); store.db.prepare('DELETE FROM events WHERE id=?').run(id);
      }
      // v0.3 replies have no event relation, and progress IDs are irreversible
      // hashes. Keep them while any task is pending so recovery can see the
      // prior receipt instead of executing the task or sending it again.
      const sends = store.db.prepare(`SELECT id FROM sends s WHERE created_ms<?
        AND (state IN ('accepted','rejected','failed') OR (state='unknown' AND json_extract(result,'$.reviewed')=1))
        AND NOT EXISTS(SELECT 1 FROM events e JOIN send_events x ON x.event_id=e.id WHERE x.request_id=s.id AND e.acked_ms IS NULL)
        AND NOT (s.id GLOB 'muse-*' AND NOT EXISTS(SELECT 1 FROM send_events x WHERE x.request_id=s.id)
          AND EXISTS(SELECT 1 FROM events e WHERE e.acked_ms IS NULL))
        AND NOT EXISTS(SELECT 1 FROM media_jobs m WHERE m.request_id=s.id)
        ORDER BY created_ms,id LIMIT 500`).all(now - policy.send_retention_days * day);
      for (const { id } of sends) { replyContents += store.db.prepare('DELETE FROM reply_history WHERE request_id=?').run(id).changes; store.db.prepare('DELETE FROM parts WHERE request_id=?').run(id); store.db.prepare('DELETE FROM send_events WHERE request_id=?').run(id); store.db.prepare('DELETE FROM sends WHERE id=?').run(id); }
      return { events: events.length, sends: sends.length, reply_contents: replyContents, conversation_memories: memories };
    });
    store.db.exec('PRAGMA wal_checkpoint(PASSIVE)');
    const result = { ...pruned, expired_media: media, orphan_files: orphans, at: new Date(now).toISOString() };
    store.set('last_maintenance', result);
    return result;
  } finally { bridge.maintaining = false; bridge.inbound.dispatch(); }
}
