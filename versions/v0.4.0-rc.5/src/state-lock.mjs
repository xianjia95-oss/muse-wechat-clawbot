import { chmodSync, existsSync, lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fail } from './errors.mjs';

// OS locks release even on SIGKILL. A sibling database keeps the lock stable
// while restore replaces the state directory. Shared/network state is unsupported.
export function lockState(directory) {
  const requested = resolve(directory);
  mkdirSync(dirname(requested), { recursive: true, mode: 0o700 });
  if (existsSync(requested) && lstatSync(requested).isSymbolicLink()) fail('unsafe_state', 'state_dir must not be a symbolic link.');
  const path = join(realpathSync(dirname(requested)), `${basename(requested)}.lock.sqlite`);
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) fail('unsafe_state', 'State lock must not be a symbolic link.');
  let db;
  try {
    db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    db.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE; CREATE TABLE IF NOT EXISTS owner (pid INTEGER);');
    db.prepare('INSERT INTO owner VALUES (?)').run(process.pid);
  } catch (error) {
    db?.close();
    if (error.code === 'ERR_SQLITE_ERROR' && /locked|busy/i.test(error.message)) fail('state_locked', 'Another process owns this state directory. Stop the service before maintenance.', 409);
    throw error;
  }
  let closed = false;
  return () => { if (!closed) { db.close(); closed = true; } };
}
