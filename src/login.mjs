import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';
import QRCode from 'qrcode';
import { AUTH_BASE, wechatBase } from './ilink.mjs';
import { privateJson } from './config.mjs';
import { fail } from './errors.mjs';

export function validateSession(session) {
  if (!session || ['bot_token', 'base_url', 'ilink_bot_id', 'ilink_user_id'].some((key) => typeof session[key] !== 'string' || !session[key])) {
    fail('invalid_session', 'Login response is missing credentials or account identifiers.');
  }
  wechatBase(session.base_url);
  return session;
}
export function saveSession(store, session) {
  validateSession(session);
  const prior = store.get('session');
  if (prior && (prior.ilink_bot_id !== session.ilink_bot_id || prior.ilink_user_id !== session.ilink_user_id)) {
    fail('account_changed', 'Use a separate state_dir for a different WeChat account.');
  }
  store.transaction(() => { store.set('session', session); store.set('expired', false); });
}

function validVerifyCode(code) {
  if (typeof code !== 'string' || !/^[0-9]{1,32}$/.test(code)) fail('invalid_verify_code', '微信配对验证码应为 1..32 位数字。');
  return code;
}

// A private, single-use mailbox lets a detached cloud login receive user input.
// Codes never appear in process arguments, command output or the session DB.
export async function waitForVerifyCode({ directory, signal, expires_at, onRequired = console.log, ...fields }) {
  signal.throwIfAborted();
  const pending = mkdtempSync(join(resolve(directory), 'muse-link-verify-'));
  chmodSync(pending, 0o700);
  const path = join(pending, 'code.json');
  try {
    privateJson(join(pending, 'request.json'), { purpose: 'muse-link-wechat-verification', expires_at });
    await onRequired({ event: 'verification_required', ...fields, code_file: path, expires_at });
    for (;;) {
      signal.throwIfAborted();
      if (existsSync(path)) return validVerifyCode(JSON.parse(readFileSync(path, 'utf8')).code);
      await pause(250, undefined, { signal });
    }
  } finally { rmSync(pending, { recursive: true, force: true }); }
}

export function submitVerifyCode(path, code) {
  path = resolve(path);
  const value = validVerifyCode(code.trim());
  if (basename(path) !== 'code.json' || !/^muse-link-verify-[A-Za-z0-9]+$/.test(basename(dirname(path)))) {
    fail('invalid_verification_path', '请使用当前登录日志 verification_required 给出的 code_file。');
  }
  let request;
  try { request = JSON.parse(readFileSync(join(dirname(path), 'request.json'), 'utf8')); } catch {
    fail('verification_expired', '验证码请求已结束，请查看最新登录日志。');
  }
  if (request.purpose !== 'muse-link-wechat-verification' || !(Date.parse(request.expires_at) > Date.now())) {
    fail('verification_expired', '验证码请求已过期，请查看最新登录日志。');
  }
  if (existsSync(path)) fail('verification_submitted', '已提交验证码，请等待登录日志结果。');
  privateJson(path, { code: value });
  return { submitted: true };
}

export async function login(store, ilink, { directory, timeout = 600000, onQr = console.log, onVerifyCode, signal } = {}) {
  directory = resolve(directory);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const deadline = Date.now() + timeout;
  const overall = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout);
  const files = [];
  let round = 0;
  try {
    while (Date.now() < deadline) {
      overall.throwIfAborted();
      const qr = await ilink.qr(overall);
      if (!qr.qrcode || !qr.qrcode_img_content) fail('invalid_qr', 'iLink returned an empty QR code.');
      const suffix = createHash('sha256').update(qr.qrcode).digest('hex').slice(0, 8);
      const path = join(directory, `muse-link-qr-${++round}-${suffix}-${randomUUID().slice(0, 8)}.png`);
      await QRCode.toFile(path, qr.qrcode_img_content, { width: 400, margin: 3 });
      chmodSync(path, 0o600);
      files.push(path);
      // Tencent's reference client keeps a QR session for at most five minutes;
      // the server can return expired sooner. This is a local refresh deadline.
      const expiresAt = Math.min(Date.now() + 300000, deadline);
      const expires_at = new Date(expiresAt).toISOString();
      await onQr({ event: 'qr', qr_number: round, id_prefix: qr.qrcode.slice(0, 8), file: path, expires_at, expiry_source: 'client_refresh_limit' });
      let host = AUTH_BASE;
      let pendingVerifyCode;
      while (Date.now() < expiresAt) {
        overall.throwIfAborted();
        const roundSignal = AbortSignal.any([overall, AbortSignal.timeout(Math.max(1, expiresAt - Date.now()))]);
        let status;
        try {
          status = await ilink.qrStatus(qr.qrcode, host, roundSignal, pendingVerifyCode);
        } catch (error) {
          if (overall.aborted) throw error;
          await pause(Math.min(1000, Math.max(1, deadline - Date.now())), undefined, { signal: overall });
          continue;
        }
        if (status.status === 'confirmed') {
          saveSession(store, {
            bot_token: status.bot_token, base_url: status.baseurl,
            ilink_bot_id: status.ilink_bot_id, ilink_user_id: status.ilink_user_id,
          });
          return { logged_in: true };
        }
        if (status.status === 'expired') break;
        if (status.status === 'need_verifycode') {
          if (!onVerifyCode) fail('verification_required', '手机要求配对验证码，请用支持验证码的登录命令继续。');
          const retry = pendingVerifyCode !== undefined;
          pendingVerifyCode = undefined;
          try {
            pendingVerifyCode = validVerifyCode(await onVerifyCode({
              directory, signal: roundSignal, expires_at, qr_number: round, id_prefix: qr.qrcode.slice(0, 8), retry,
            }));
          } catch (error) {
            if (overall.aborted) throw error;
            if (roundSignal.aborted) break;
            throw error;
          }
          continue;
        }
        if (status.status === 'scaned') pendingVerifyCode = undefined;
        if (status.status === 'verify_code_blocked') fail('verification_blocked', '微信提示验证码错误次数过多，登录已停止，请稍后重新扫码。');
        if (status.status === 'binded_redirect') fail('already_bound', '微信提示已绑定。请检查现有 status/health；此响应没有提供新的凭证。');
        if (status.status === 'scaned_but_redirect') {
          const redirect = status.redirect_host ?? '';
          host = wechatBase(redirect.includes('://') ? redirect : `https://${redirect}`);
        }
        await pause(1000, undefined, { signal: overall });
      }
    }
    fail('login_timeout', '扫码等待已超时，请准备好后重新登录。');
  } finally {
    for (const path of files) rmSync(path, { force: true });
  }
}
