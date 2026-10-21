import { closeSync, fsyncSync, ftruncateSync, lstatSync, openSync, writeSync } from 'node:fs';
import { dirname, isAbsolute, parse } from 'node:path';
import { fail } from './errors.mjs';

// Reserve the destination before claiming, so a typo, existing handoff or unsafe
// directory cannot consume another task. Store only the response actually given
// to this worker; never recover a token by reading live database state.
export function reserveTaskFile(path, endpoint, configPath) {
  if (!isAbsolute(path)) fail('invalid_task_output', 'Task output must be an absolute path in a private directory.');
  for (let parent = dirname(path); ; parent = dirname(parent)) {
    const stat = lstatSync(parent);
    if (stat.isSymbolicLink() || !stat.isDirectory()) fail('unsafe_task_output', 'Task output directories must not be symbolic links.');
    if (parent === dirname(path) && process.platform !== 'win32' && (stat.mode & 0o077)) fail('unsafe_task_output', 'Task output requires a private directory (mode 0700).');
    if (parent === parse(parent).root) break;
  }
  const fd = openSync(path, 'wx', 0o600);
  const started_at = new Date().toISOString();
  const save = (value) => {
    const bytes = Buffer.from(JSON.stringify({ endpoint, config_path: configPath, started_at, ...value }) + '\n');
    for (let offset = 0; offset < bytes.length;) offset += writeSync(fd, bytes, offset, bytes.length - offset, offset);
    ftruncateSync(fd, bytes.length);
    fsyncSync(fd);
  };
  try { save({ claim_state: 'awaiting_response' }); }
  catch (error) { closeSync(fd); throw error; }
  return {
    save: (result) => save({ claim_state: 'response_saved', saved_at: new Date().toISOString(), ...result }),
    close: () => closeSync(fd),
  };
}
