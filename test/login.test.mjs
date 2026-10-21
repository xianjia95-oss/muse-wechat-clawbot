import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { login, submitVerifyCode, waitForVerifyCode } from '../src/login.mjs';
import { initConfig, loadConfig } from '../src/config.mjs';
import { fixture, session } from './helpers.mjs';

test('QR login generates a unique readable image and stores confirmed credentials', async (t) => {
  const { store, directory } = fixture(t);
  const images = [];
  let generated = 0;
  const ilink = {
    qr: async () => ({ qrcode: `qr-${++generated}`, qrcode_img_content: 'https://weixin.qq.com/test-only' }),
    qrStatus: async () => generated === 1 ? { status: 'expired' } : {
      status: 'confirmed', bot_token: 'new-test-token', baseurl: session.base_url,
      ilink_bot_id: session.ilink_bot_id, ilink_user_id: session.ilink_user_id,
    },
  };
  const result = await login(store, ilink, { directory, timeout: 5000, onQr: (qr) => {
    assert.equal(existsSync(qr.file), true);
    assert.equal(readFileSync(qr.file).subarray(1, 4).toString(), 'PNG');
    images.push(qr.file);
  } });
  assert.equal(result.logged_in, true);
  assert.equal(images.length, 2);
  assert.notEqual(images[0], images[1]);
  assert.equal(images.every((file) => !existsSync(file)), true);
  assert.equal(store.get('session').bot_token, 'new-test-token');
});

test('init generates a private token, preserves existing config and rejects public listen address', (t) => {
  const { directory } = fixture(t);
  const path = join(directory, 'config', 'config.json');
  assert.equal(initConfig(path).created, true);
  const first = readFileSync(path, 'utf8');
  assert.equal(loadConfig(path).api_token.length, 64);
  assert.equal(initConfig(path).created, false);
  assert.equal(readFileSync(path, 'utf8'), first);
  const config = JSON.parse(first);
  config.listen.host = '0.0.0.0';
  writeFileSync(path, JSON.stringify(config));
  assert.throws(() => loadConfig(path), { code: 'invalid_config' });
});

test('QR verification preserves leading zeros, asks again after rejection and clears accepted code', async (t) => {
  const { store, directory } = fixture(t);
  const sent = [];
  const prompts = [];
  const statuses = ['need_verifycode', 'need_verifycode', 'scaned', 'confirmed'];
  const ilink = {
    qr: async () => ({ qrcode: 'verify-qr', qrcode_img_content: 'https://weixin.qq.com/test-only' }),
    qrStatus: async (id, host, signal, code) => {
      sent.push(code);
      return { status: statuses.shift(), bot_token: 'verified-test-token', baseurl: session.base_url,
        ilink_bot_id: session.ilink_bot_id, ilink_user_id: session.ilink_user_id };
    },
  };
  const result = await login(store, ilink, { directory, timeout: 10000, onQr: (qr) => {
    assert.equal(qr.expiry_source, 'client_refresh_limit');
  }, onVerifyCode: (prompt) => {
    prompts.push(prompt);
    return prompts.length === 1 ? '000111' : '000222';
  } });
  assert.equal(result.logged_in, true);
  assert.deepEqual(sent, [undefined, '000111', '000222', undefined]);
  assert.deepEqual(prompts.map((prompt) => prompt.retry), [false, true]);
  assert.equal(store.get('session').bot_token, 'verified-test-token');
  assert.equal(JSON.stringify(result).includes('000222'), false);
});

test('QR verification-required, blocked and already-bound states fail explicitly and clean up QR', async (t) => {
  const { store, directory } = fixture(t);
  for (const [status, code] of [['need_verifycode', 'verification_required'], ['verify_code_blocked', 'verification_blocked'], ['binded_redirect', 'already_bound']]) {
    let file;
    let calls = 0;
    await assert.rejects(login(store, {
      qr: async () => ({ qrcode: 'qr-explicit', qrcode_img_content: 'https://weixin.qq.com/test-only' }),
      qrStatus: async () => { calls++; return { status }; },
    }, { directory, timeout: 5000, onQr: (qr) => { file = qr.file; } }), { code });
    assert.equal(calls, 1);
    assert.equal(existsSync(file), false);
  }
});

test('detached verification accepts actual CLI stdin, exposes no code and removes its private mailbox', async (t) => {
  const { directory } = fixture(t);
  const configPath = join(directory, 'config.json');
  initConfig(configPath);
  let codeFile;
  const value = await waitForVerifyCode({ directory, signal: AbortSignal.timeout(10000),
    expires_at: new Date(Date.now() + 10000).toISOString(), onRequired: (event) => {
      codeFile = event.code_file;
      assert.equal(event.event, 'verification_required');
      const result = spawnSync(process.execPath, [fileURLToPath(new URL('../src/cli.mjs', import.meta.url)),
        'login', 'verify', '--config', configPath, '--code-file', codeFile, '--text', '-'],
      { input: '001234\n', encoding: 'utf8', timeout: 5000 });
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), { submitted: true });
      assert.equal((result.stdout + result.stderr).includes('001234'), false);
      assert.equal(readFileSync(codeFile, 'utf8').includes('001234'), true);
      if (process.platform !== 'win32') {
        assert.equal(statSync(dirname(codeFile)).mode & 0o777, 0o700);
        assert.equal(statSync(codeFile).mode & 0o777, 0o600);
      }
      assert.throws(() => submitVerifyCode(codeFile, '999999'), { code: 'verification_submitted' });
    } });
  assert.equal(value, '001234');
  assert.equal(existsSync(dirname(codeFile)), false);
  assert.throws(() => submitVerifyCode(codeFile, '001234'), { code: 'verification_expired' });
});

test('verification rejects unsafe input and expired requests; cancellation cleans private files', async (t) => {
  const { directory } = fixture(t);
  const controller = new AbortController();
  let codeFile;
  await assert.rejects(waitForVerifyCode({ directory, signal: controller.signal,
    expires_at: new Date(Date.now() + 10000).toISOString(), onRequired: (event) => {
      codeFile = event.code_file;
      assert.throws(() => submitVerifyCode(codeFile, '123; echo unsafe'), { code: 'invalid_verify_code' });
      writeFileSync(join(dirname(codeFile), 'request.json'), JSON.stringify({ purpose: 'muse-link-wechat-verification', expires_at: '2000-01-01T00:00:00Z' }));
      assert.throws(() => submitVerifyCode(codeFile, '123456'), { code: 'verification_expired' });
      controller.abort();
    } }), { name: 'AbortError' });
  assert.equal(existsSync(dirname(codeFile)), false);
  assert.throws(() => submitVerifyCode(join(directory, 'arbitrary.json'), '123456'), { code: 'invalid_verification_path' });
});
