import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readTaskLease, reserveTaskFile } from '../src/task-file.mjs';
import { fixture } from './helpers.mjs';

function captured(t) {
  const { directory } = fixture(t);
  const path = join(directory, 'task.json'), endpoint = 'http://127.0.0.1:18791', config = join(directory, 'config.json');
  const token = 'ab'.repeat(24), event = 'muse:captured';
  const saved = reserveTaskFile(path, endpoint, config);
  saved.save({ tasks: [{ event_id: 'muse:other', lease_token: 'cd'.repeat(24) }, { event_id: event, lease_token: token }] });
  saved.close();
  return { path, endpoint, config, token, event };
}

test('task-file reader selects the explicit event and rejects incomplete, ambiguous or wrongly scoped claims', (t) => {
  const { path, endpoint, config, token, event } = captured(t), original = readFileSync(path, 'utf8');
  assert.equal(readTaskLease(path, event, endpoint, config), token);
  assert.throws(() => readTaskLease(path, 'muse:missing', endpoint, config), { code: 'invalid_task_file' });
  assert.throws(() => readTaskLease(path, event, 'http://127.0.0.1:18792', config), { code: 'task_file_scope_mismatch' });
  assert.throws(() => readTaskLease(path, event, endpoint, config + '.other'), { code: 'task_file_scope_mismatch' });
  for (const tasks of [[{ event_id: event, lease_token: token.slice(0, 16) }], [{ event_id: event }], [{ event_id: event, lease_token: token }, { event_id: event, lease_token: token }]]) {
    writeFileSync(path, JSON.stringify({ ...JSON.parse(original), tasks }));
    assert.throws(() => readTaskLease(path, event, endpoint, config), { code: 'invalid_task_file' });
  }
  writeFileSync(path, JSON.stringify({ claim_state: 'awaiting_response' }));
  assert.throws(() => readTaskLease(path, event, endpoint, config), { code: 'task_file_scope_mismatch' });
  writeFileSync(path, '{broken');
  assert.throws(() => readTaskLease(path, event, endpoint, config), { code: 'invalid_task_file' });
  for (const content of ['', 'x'.repeat(4 * 1024 * 1024 + 1)]) {
    writeFileSync(path, content);
    assert.throws(() => readTaskLease(path, event, endpoint, config), { code: 'invalid_task_file' });
  }
});

test('task-file reader refuses a symlink and nonprivate captured file', { skip: process.platform === 'win32' }, (t) => {
  const { path, endpoint, config, event } = captured(t), linked = path + '.link';
  symlinkSync(path, linked);
  assert.throws(() => readTaskLease(linked, event, endpoint, config), { code: 'unsafe_task_file' });
  chmodSync(path, 0o644);
  assert.throws(() => readTaskLease(path, event, endpoint, config), { code: 'unsafe_task_file' });
});
