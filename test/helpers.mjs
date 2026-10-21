import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { Bridge } from '../src/bridge.mjs';

export const session = { bot_token: 'TEST-SECRET', base_url: 'https://ilinkai.weixin.qq.com', ilink_bot_id: 'bot-test', ilink_user_id: 'owner' };
export function fixture(t, transport = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'muse-link-test-'));
  const config = { binding: 'muse', state_dir: directory, allow_wxids: [], api_token: 'a'.repeat(64), listen: { host: '127.0.0.1', port: 18791 }, send_timeout_ms: 1000, poll_timeout_ms: 45000 };
  const store = new Store(directory);
  store.set('session', session);
  store.saveContext('owner', 'context-1');
  const calls = [];
  const ilink = { close: async () => {}, sendText: async (...args) => { calls.push(args); }, ...transport };
  const bridge = new Bridge(config, store, ilink);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { directory, config, store, calls, bridge, ilink };
}
export const reply = (id = 'request-1', text = '你好') => ({ request_id: id, to: 'owner', text });
export function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
