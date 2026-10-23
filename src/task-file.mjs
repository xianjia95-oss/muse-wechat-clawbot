import { closeSync, fstatSync, fsyncSync, ftruncateSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmdirSync, unlinkSync, writeSync } from 'node:fs';
import { dirname, isAbsolute, join, parse } from 'node:path';
import { fail } from './errors.mjs';

// Reserve the destination before claiming, so a typo, existing handoff or unsafe
// directory cannot consume another task. Store only the response actually given
// to this worker; never recover a token by reading live database state.
function checkDirectory(directory, requirePrivate = true) {
  for (let parent = directory; ; parent = dirname(parent)) {
    const stat = lstatSync(parent);
    if (stat.isSymbolicLink() || !stat.isDirectory()) fail('unsafe_task_output', 'Task output directories must not be symbolic links.');
    if (requirePrivate && parent === directory && process.platform !== 'win32' && (stat.mode & 0o077)) fail('unsafe_task_output', 'Task output requires a private directory (mode 0700).');
    if (parent === parse(parent).root) break;
  }
}

export function reserveTaskFile(path, endpoint, configPath) {
  if (!isAbsolute(path)) fail('invalid_task_output', 'Task output must be an absolute path in a private directory.');
  checkDirectory(dirname(path));
  const fd = openSync(path, 'wx', 0o600);
  const started_at = new Date().toISOString();
  let snapshot;
  const save = (value) => {
    const bytes = Buffer.from(JSON.stringify({ endpoint, config_path: configPath, started_at, ...value }) + '\n');
    for (let offset = 0; offset < bytes.length;) offset += writeSync(fd, bytes, offset, bytes.length - offset, offset);
    ftruncateSync(fd, bytes.length);
    fsyncSync(fd);
    snapshot = bytes;
  };
  try {
    save({ claim_state: 'awaiting_response' });
    // Reserve a durable directory entry before making the claim request.
    if (process.platform !== 'win32') {
      const directory = openSync(dirname(path), 'r');
      try { fsyncSync(directory); } finally { closeSync(directory); }
    }
  }
  catch (error) { closeSync(fd); throw error; }
  return {
    save: (result) => save({ claim_state: 'response_saved', saved_at: new Date().toISOString(), ...result }),
    isCurrentFile: () => {
      const actual = lstatSync(path), original = fstatSync(fd);
      return actual.isFile() && !actual.isSymbolicLink() && actual.dev === original.dev && actual.ino === original.ino && readFileSync(path).equals(snapshot);
    },
    close: () => closeSync(fd),
  };
}

// Each invocation owns a fresh directory. Only its own durably saved, confirmed
// empty response may be removed. Network errors/crashes retain the reservation:
// an absent response does not prove that the server did not issue a lease.
export function reserveTaskDirectory(root, endpoint, configPath) {
  if (!isAbsolute(root)) fail('invalid_task_output', 'Task output directory must be absolute.');
  // Never create missing ancestors through symlinks or change another owner's
  // directory permissions. The caller provisions the private parent first.
  checkDirectory(dirname(root), false);
  try { mkdirSync(root, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  return reserveNewDirectory(root, endpoint, configPath);
}

function reserveNewDirectory(root, endpoint, configPath) {
  checkDirectory(root);
  const directory = mkdtempSync(join(root, 'claim.'));
  const identity = lstatSync(directory);
  if (process.platform !== 'win32') {
    for (const path of [root, dirname(root)]) {
      const fd = openSync(path, 'r');
      try { fsyncSync(fd); } finally { closeSync(fd); }
    }
  }
  const path = join(directory, 'task.json');
  const handoff = reserveTaskFile(path, endpoint, configPath);
  let empty = false, closed = false;
  const same = (a, b) => !b.isSymbolicLink() && a.dev === b.dev && a.ino === b.ino;
  return {
    path,
    save(result) {
      if (!result || !Array.isArray(result.tasks)) fail('invalid_task_response', 'Claim response is not a tasks array; preserve the reservation for review.', 502);
      handoff.save(result);
      empty = result.tasks.length === 0;
    },
    discardEmpty() {
      if (!empty || closed) return false;
      if (!same(identity, lstatSync(directory))) fail('unsafe_task_output', 'Claim directory identity changed; preserve it for review.');
      const entries = readdirSync(directory);
      if (entries.length !== 1 || entries[0] !== 'task.json') return false;
      // Compare the file against the open reservation before unlinking. No glob,
      // recursive deletion, DB lookup, lease release or other worker is involved.
      if (!handoff.isCurrentFile()) fail('unsafe_task_output', 'Claim file identity changed; preserve it for review.');
      handoff.close(); closed = true;
      unlinkSync(path);
      rmdirSync(directory);
      return true;
    },
    close() { if (!closed) { handoff.close(); closed = true; } },
  };
}
