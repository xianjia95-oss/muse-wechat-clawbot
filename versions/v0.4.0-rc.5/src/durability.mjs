import { lstat, mkdir, open, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fail } from './errors.mjs';

export async function syncFile(path) {
  const file = await open(path, 'r+');
  try { await file.sync(); } finally { await file.close(); }
}
export async function syncDirectory(path) {
  if (process.platform === 'win32') return;
  const directory = await open(path, 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}
export async function mkdirDurable(path) {
  path = resolve(path);
  const firstCreated = await mkdir(path, { recursive: true, mode: 0o700 });
  if (!firstCreated || process.platform === 'win32') return;
  for (let directory = path; ; directory = dirname(directory)) {
    await syncDirectory(directory);
    if (directory === dirname(firstCreated) || directory === dirname(directory)) break;
  }
}
// Used only for private, quiescent staging trees before publishing a backup
// or restore. Reject links/special files rather than following them.
export async function syncTree(path) {
  const info = await lstat(path);
  if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory())) fail('unsafe_file_tree', 'Cannot persist a tree containing links or special files.');
  if (info.isFile()) return syncFile(path);
  for (const entry of await readdir(path)) await syncTree(join(path, entry));
  await syncDirectory(path);
}
