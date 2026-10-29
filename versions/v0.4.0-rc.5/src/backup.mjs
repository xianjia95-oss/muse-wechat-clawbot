import { backup, DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, copyFile, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rename, access, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { homedir } from 'node:os';
import { Store, SCHEMA_VERSION } from './store.mjs';
import { VERSION } from './config.mjs';
import { lockState } from './state-lock.mjs';
import { within } from './media.mjs';
import { fail } from './errors.mjs';
import { mkdirDurable, syncDirectory, syncTree } from './durability.mjs';

async function exists(path) { try { await access(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }
// Resolve existing ancestors too: a new leaf beneath a junction/symlink still
// belongs to the real parent. Do not treat dangling links as absent directories.
async function canonical(path) {
  path = resolve(path);
  try { await lstat(path); }
  catch (error) {
    if (error.code !== 'ENOENT' || path === dirname(path)) throw error;
    return join(await canonical(dirname(path)), basename(path));
  }
  return realpath(path);
}
async function digest(path) { const hash = createHash('sha256'); for await (const chunk of createReadStream(path)) hash.update(chunk); return hash.digest('hex'); }
async function files(directory, base = directory) {
  const output = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    const info = await lstat(path);
    if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) fail('unsafe_backup', 'Backup/state contains a symlink or special file.');
    if (info.isDirectory()) output.push(...await files(path, base)); else output.push(relative(base, path).replaceAll('\\', '/'));
  }
  return output.sort();
}
async function copyPrivate(source, destination) {
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  await copyFile(source, destination); await chmod(destination, 0o600);
}
function checkDb(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    if (db.prepare('PRAGMA user_version').get().user_version > SCHEMA_VERSION) fail('future_schema', 'Backup schema is newer than this program.');
    if (db.prepare('PRAGMA quick_check').get().quick_check !== 'ok') fail('corrupt_backup', 'SQLite quick_check failed.');
    for (const table of ['meta', 'events', 'sends', 'parts']) db.prepare(`SELECT count(*) FROM ${table}`).get();
  } finally { db.close(); }
}

export async function backupState(config, output) {
  const destination = resolve(output);
  if (within(await canonical(config.state_dir), await canonical(destination))) fail('invalid_backup_path', 'Backup must be outside state_dir.');
  if (!await exists(join(config.state_dir, 'bridge.sqlite'))) fail('missing_state', 'No state database exists to back up.');
  const unlock = lockState(config.state_dir);
  let database;
  try {
    if (await exists(destination)) fail('backup_exists', 'Backup destination already exists.');
    database = new DatabaseSync(join(config.state_dir, 'bridge.sqlite'), { readOnly: true });
    const stateFiles = await files(config.state_dir);
    await mkdirDurable(dirname(destination));
    const staging = await mkdtemp(join(dirname(destination), '.muse-link-backup-'));
    await mkdir(join(staging, 'state'), { mode: 0o700 });
    await backup(database, join(staging, 'state', 'bridge.sqlite'));
    await chmod(join(staging, 'state', 'bridge.sqlite'), 0o600);
    // A standalone backup must not depend on WAL/SHM sidecars. Read-only
    // verification of a WAL-mode database may otherwise create new files.
    const snapshot = new DatabaseSync(join(staging, 'state', 'bridge.sqlite'));
    try { snapshot.exec('PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE;'); } finally { snapshot.close(); }
    checkDb(join(staging, 'state', 'bridge.sqlite'));
    for (const file of stateFiles) if (file.startsWith('outbox/') || file.startsWith('inbound/')) await copyPrivate(join(config.state_dir, file), join(staging, 'state', file));
    if (config.path) await copyPrivate(config.path, join(staging, 'config.json'));
    const manifest = { format: 1, version: VERSION, created_at: new Date().toISOString(), original_state_dir: resolve(config.state_dir), files: {} };
    for (const file of await files(staging)) manifest.files[file] = await digest(join(staging, file));
    await writeFile(join(staging, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    await syncTree(staging);
    await rename(staging, destination);
    await syncDirectory(dirname(destination));
    return { ok: true, directory: destination, files: Object.keys(manifest.files).length, contains_credentials: true };
  } finally { database?.close(); unlock(); }
}

export async function verifyBackup(directory) {
  directory = resolve(directory);
  if ((await lstat(directory)).isSymbolicLink()) fail('unsafe_backup', 'Backup directory cannot be a symlink.');
  const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
  if (manifest.format !== 1 || typeof manifest.original_state_dir !== 'string' || !manifest.files || typeof manifest.files !== 'object') fail('invalid_backup', 'Unsupported backup manifest.');
  const actual = (await files(directory)).filter((file) => file !== 'manifest.json');
  if (JSON.stringify(actual) !== JSON.stringify(Object.keys(manifest.files).sort()) || !actual.includes('state/bridge.sqlite')) fail('invalid_backup', 'Backup inventory mismatch.');
  for (const file of actual) {
    if (!(file === 'config.json' || file === 'state/bridge.sqlite' || file.startsWith('state/outbox/') || file.startsWith('state/inbound/')) || !within(directory, resolve(directory, file))) fail('unsafe_backup', 'Invalid backup member.');
    if (await digest(join(directory, file)) !== manifest.files[file]) fail('corrupt_backup', 'Backup checksum mismatch.');
  }
  checkDb(join(directory, 'state', 'bridge.sqlite'));
  return manifest;
}

export async function restoreState(config, source) {
  const target = resolve(config.state_dir);
  const identity = await canonical(target);
  const backupIdentity = await canonical(source);
  if (identity === dirname(identity) || within(identity, await canonical(homedir())) || within(identity, backupIdentity) || within(backupIdentity, identity)) fail('invalid_restore_path', 'Restore requires a dedicated state directory and an external backup.');
  const unlock = lockState(target);
  try {
    const manifest = await verifyBackup(source);
    const staging = await mkdtemp(join(dirname(target), '.muse-link-restore-'));
    for (const file of Object.keys(manifest.files)) {
      if (!file.startsWith('state/')) continue;
      const destination = join(staging, file.slice(6));
      await copyPrivate(join(source, file), destination);
      if (await digest(destination) !== manifest.files[file]) fail('corrupt_backup', 'Backup changed during restore.');
    }
    const store = new Store(staging);
    try {
      for (const row of store.db.prepare('SELECT request_id,part,body FROM media_jobs').all()) {
        const record = JSON.parse(row.body);
        if (!within(join(manifest.original_state_dir, 'outbox'), resolve(record.cipher_path))) fail('unsafe_backup', 'Snapshot path is outside original outbox.');
        record.cipher_path = join(target, relative(manifest.original_state_dir, record.cipher_path));
        store.saveMedia(row.request_id, row.part, record);
      }
      for (const row of store.db.prepare('SELECT event_id,part,result FROM inbound_media WHERE result IS NOT NULL').all()) {
        const result = JSON.parse(row.result);
        for (const key of ['path', 'raw_path']) if (result[key]) {
          if (typeof result[key] !== 'string' || !within(join(manifest.original_state_dir, 'inbound'), resolve(result[key]))) fail('unsafe_backup', 'Inbound path is outside original cache.');
          result[key] = join(target, relative(manifest.original_state_dir, result[key]));
        }
        store.db.prepare('UPDATE inbound_media SET result=? WHERE event_id=? AND part=?').run(JSON.stringify(result), row.event_id, row.part);
      }
      store.set('restore_review_required', true);
      store.set('restore_info', { at: new Date().toISOString(), backup_at: manifest.created_at });
      store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } finally { store.close(); }
    await syncTree(staging);
    const previous = `${target}.pre-restore-${randomUUID()}`;
    const hadState = await exists(target);
    if (hadState) await rename(target, previous);
    try { await rename(staging, target); }
    catch (error) { if (hadState) { await rename(previous, target); await syncDirectory(dirname(target)); } throw error; }
    await syncDirectory(dirname(target));
    return { ok: true, review_required: true, previous_state: hadState ? previous : null, config_restored: false };
  } finally { unlock(); }
}
