import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { initConfig, loadConfig, privateJson } from '../src/config.mjs';

const exec = promisify(execFile);
const cliPath = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
const moduleUrl = (name) => JSON.stringify(new URL(`../src/${name}.mjs`, import.meta.url).href);
// A real separate API/Store process with a fake upstream only. Each restart
// reopens the same SQLite and state ownership lock, like the deployed daemon.
const runner = `
  import {Store} from ${moduleUrl('store')};
  import {Bridge} from ${moduleUrl('bridge')};
  import {createApi} from ${moduleUrl('server')};
  import {lockState} from ${moduleUrl('state-lock')};
  import {loadConfig} from ${moduleUrl('config')};
  const config = loadConfig(process.argv[1]);
  const release = lockState(config.state_dir);
  const store = new Store(config.state_dir);
  store.set('session', {bot_token:'test', ilink_user_id:'owner'});
  store.saveContext('owner','test-context');
  let sent = 0;
  const bridge = new Bridge(config, store, {sendText:async()=>{sent++;}, close:async()=>{}});
  const server = createApi(bridge);
  server.listen(process.argv[2] === 'initial' ? 0 : config.listen.port, config.listen.host, ()=>process.send({port:server.address().port}));
  process.on('message', async (message)=>{
    if(message.action==='ingest') {
      bridge.ingest({msgs:[{message_id:message.id,from_user_id:'owner',item_list:[{type:1,text_item:{text:'hello'}}]}]});
      process.send({added:true});
    } else if(message.action==='stats') process.send({sent});
    else if(message.action==='stop') {
      server.closeAllConnections();
      await new Promise(done=>server.close(done));
      await bridge.close(); store.close(); release(); process.disconnect();
    }
  });
`;

async function setup(t) {
  const directory = mkdtempSync(join(tmpdir(), 'muse-link-restart-'));
  const path = join(directory, 'config.json'); initConfig(path);
  const config = loadConfig(path); config.state_dir = join(directory, 'state'); privateJson(path, config);
  let child;
  const stop = async () => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit'); child.send({ action: 'stop' }); await exited;
  };
  t.after(async () => {
    if (child && child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; }
    rmSync(directory, { recursive: true, force: true });
  });
  const start = async (initial = false) => {
    child = spawn(process.execPath, ['--input-type=module', '-e', runner, path, initial ? 'initial' : 'restart'], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    let stderr = ''; child.stderr.on('data', (data) => { stderr += data; });
    const ready = await Promise.race([once(child, 'message').then(([message]) => message), once(child, 'exit').then(() => { throw new Error(stderr); })]);
    config.listen.port = ready.port; privateJson(path, config);
  };
  const command = async (...args) => JSON.parse((await exec(process.execPath, [cliPath, '--config', path, ...args])).stdout);
  const message = async (value) => { const received = once(child, 'message'); child.send(value); return (await received)[0]; };
  await start(true);
  return { start, stop, command, message };
}

test('restart before claim preserves a new lease and accepts the first immediate reply', { timeout: 15000 }, async (t) => {
  const { start, stop, command, message } = await setup(t);
  await stop(); await start(); await message({ action: 'ingest', id: 'after-restart' });
  const task = (await command('muse', 'next', '--limit', '1', '--lease', '30m')).tasks[0];
  assert.ok(task.lease_until > Date.now() + 1700000);
  const result = await command('muse', 'reply', task.event_id, '--lease-token', task.lease_token, '--text', 'done');
  assert.equal(result.state, 'accepted'); assert.equal((await message({ action: 'stats' })).sent, 1);
});

test('restart after claim preserves the exact token and does not make the leased event claimable', { timeout: 15000 }, async (t) => {
  const { start, stop, command, message } = await setup(t);
  await message({ action: 'ingest', id: 'before-restart' });
  const task = (await command('muse', 'next', '--limit', '1', '--lease', '30m')).tasks[0];
  await stop(); await start();
  assert.equal((await command('muse', 'next', '--limit', '1')).tasks.length, 0);
  assert.equal((await command('muse', 'reply', task.event_id, '--lease-token', task.lease_token, '--text', 'done')).state, 'accepted');
  assert.equal((await message({ action: 'stats' })).sent, 1);
});
