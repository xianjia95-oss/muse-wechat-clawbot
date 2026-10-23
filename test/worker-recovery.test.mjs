import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApi } from '../src/server.mjs';
import { reserveTaskDirectory } from '../src/task-file.mjs';
import { fixture } from './helpers.mjs';

const exec = promisify(execFile);
const cliPath = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
async function setup(t, dropped = false) {
  const f = fixture(t); f.config.require_lease_token = true;
  const server = dropped ? createServer((req, res) => { f.store.claim(1); res.destroy(); }) : createApi(f.bridge);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise((done) => server.close(done)); });
  f.config.listen.port = server.address().port;
  const path = join(f.directory, 'config.json'); writeFileSync(path, JSON.stringify(f.config));
  const root = join(f.directory, 'claims');
  const cli = async (...args) => JSON.parse((await exec(process.execPath, [cliPath, '--config', path, 'muse', 'next', '--output-dir', root, ...args])).stdout);
  const add = (id) => f.bridge.ingest({ msgs: [{ message_id: id, from_user_id: 'owner', item_list: [{ type: 1, text_item: { text: 'PRIVATE' } }] }] });
  return { ...f, root, path, cli, add };
}

test('concurrent empty polls remove only their own confirmed empty handoffs; active claims stay private and intact', { timeout: 20000 }, async (t) => {
  const { root, cli, add, store } = await setup(t);
  mkdirSync(root, { mode: 0o700 });
  const other = join(root, 'claim.other-worker'); mkdirSync(other, { mode: 0o700 });
  writeFileSync(join(other, 'task.json'), 'OTHER-WORKER-LEASE');
  const empty = await Promise.all(Array.from({ length: 8 }, () => cli()));
  assert.ok(empty.every((value) => value.tasks.length === 0 && value.handoff_file === null));
  assert.deepEqual(readdirSync(root), ['claim.other-worker']);
  add('concurrent-a'); add('concurrent-b');
  const claimed = await Promise.all([cli(), cli()]);
  assert.notEqual(claimed[0].handoff_file, claimed[1].handoff_file);
  const before = claimed.map((value) => readFileSync(value.handoff_file, 'utf8'));
  for (const value of claimed) {
    const captured = JSON.parse(readFileSync(value.handoff_file));
    assert.equal(captured.tasks.length, 1);
    assert.equal(captured.tasks[0].lease_token, store.event(captured.tasks[0].event_id).lease_token);
  }
  await cli();
  assert.deepEqual(claimed.map((value) => readFileSync(value.handoff_file, 'utf8')), before);
  assert.equal(readFileSync(join(other, 'task.json'), 'utf8'), 'OTHER-WORKER-LEASE');
  assert.equal(readdirSync(root).length, 3);
  assert.equal(store.queueStats().leased, 2);
});

test('lost claim response preserves its own reservation and never releases or acknowledges the possibly issued lease', { timeout: 10000 }, async (t) => {
  const { root, cli, add, store } = await setup(t, true); add('dropped-response');
  await assert.rejects(cli(), (error) => error.stderr.includes('claim_handoff_retained'));
  const names = readdirSync(root); assert.equal(names.length, 1);
  const saved = JSON.parse(readFileSync(join(root, names[0], 'task.json')));
  assert.equal(saved.claim_state, 'awaiting_response');
  assert.equal(store.queueStats().leased, 1);
  assert.equal(store.event('muse:dropped-response').acked_ms, null);
});

test('managed empty cleanup refuses foreign files, replaced reservation identities and malformed results', (t) => {
  const { directory } = fixture(t); const root = join(directory, 'claims');
  const handoff = reserveTaskDirectory(root, 'http://127.0.0.1:18791', '/private/config.json');
  t.after(() => handoff.close());
  assert.throws(() => handoff.save({}), { code: 'invalid_task_response' });
  assert.equal(handoff.discardEmpty(), false);
  handoff.save({ tasks: [] });
  renameSync(handoff.path, join(root, 'original-held.json'));
  writeFileSync(handoff.path, 'OTHER-WORKER-FILE');
  assert.throws(() => handoff.discardEmpty(), { code: 'unsafe_task_output' });
  assert.equal(readFileSync(handoff.path, 'utf8'), 'OTHER-WORKER-FILE');
  const second = reserveTaskDirectory(root, 'http://127.0.0.1:18791', '/private/config.json');
  t.after(() => second.close()); second.save({ tasks: [] });
  writeFileSync(join(second.path, '..', 'foreign-file'), 'PRESERVE');
  assert.equal(second.discardEmpty(), false);
  assert.equal(existsSync(second.path), true);
  const third = reserveTaskDirectory(root, 'http://127.0.0.1:18791', '/private/config.json');
  t.after(() => third.close()); third.save({ tasks: [] });
  writeFileSync(third.path, '{"tasks":[{"lease_token":"FOREIGN"}]}');
  assert.throws(() => third.discardEmpty(), { code: 'unsafe_task_output' });
  assert.match(readFileSync(third.path, 'utf8'), /FOREIGN/);
});

test('conflicting handoff flags fail before claiming or creating a managed directory', async (t) => {
  const { cli, root, directory, add, store } = await setup(t); add('flags');
  await assert.rejects(cli('--output', join(directory, 'explicit-task.json')));
  assert.equal(existsSync(root), false); assert.equal(store.count(), 1);
});
