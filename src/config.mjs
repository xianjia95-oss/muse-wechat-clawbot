import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { fail, integer } from './errors.mjs';

export const VERSION = '0.3.0';

export const defaultConfigPath = () => join(homedir(), '.config', 'muse-link', 'config.json');
export const expand = (path) => resolve(path.startsWith('~/') ? join(homedir(), path.slice(2)) : path);

export function privateJson(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomBytes(8).toString('hex')}.tmp`;
  writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  renameSync(temp, path);
  chmodSync(path, 0o600);
}

export function initConfig(path = defaultConfigPath()) {
  if (existsSync(path)) return { path, created: false };
  privateJson(path, {
    binding: 'muse',
    state_dir: '~/.local/state/muse-link',
    listen: { host: '127.0.0.1', port: 18791 },
    api_token: randomBytes(32).toString('hex'),
    allow_wxids: [],
    send_timeout_ms: 12000,
    poll_timeout_ms: 45000,
    media_timeout_ms: 120000,
    media_roots: ['~/workspace'],
  });
  return { path, created: true };
}

export function loadConfig(path = defaultConfigPath()) {
  if (!existsSync(path)) fail('missing_config', 'Run muse-link init first.', 500);
  const config = JSON.parse(readFileSync(path, 'utf8'));
  if (!/^[a-z0-9_-]{1,32}$/.test(config.binding)) fail('invalid_config', 'Invalid binding.');
  if (!['127.0.0.1', '::1'].includes(config.listen?.host)) fail('invalid_config', 'listen.host must be loopback.');
  integer(config.listen.port, 1, 65535, 'listen.port');
  if (typeof config.api_token !== 'string' || config.api_token.length < 32) fail('invalid_config', 'api_token must contain at least 32 characters.');
  if (!Array.isArray(config.allow_wxids) || config.allow_wxids.some((id) => typeof id !== 'string' || !id)) fail('invalid_config', 'Invalid allow_wxids.');
  integer(config.send_timeout_ms, 100, 120000, 'send_timeout_ms');
  integer(config.poll_timeout_ms, 1000, 120000, 'poll_timeout_ms');
  config.media_timeout_ms ??= 120000;
  config.media_roots ??= ['~/workspace'];
  integer(config.media_timeout_ms, 1000, 600000, 'media_timeout_ms');
  if (!Array.isArray(config.media_roots) || config.media_roots.some((root) => typeof root !== 'string' || !root)) fail('invalid_config', 'media_roots must contain local directories.');
  config.media_roots = config.media_roots.map(expand);
  if (typeof config.state_dir !== 'string' || !config.state_dir) fail('invalid_config', 'state_dir is required.');
  config.state_dir = expand(config.state_dir);
  config.path = resolve(path);
  return config;
}

export function localUrl(config) {
  const host = config.listen.host === '::1' ? '[::1]' : config.listen.host;
  return `http://${host}:${config.listen.port}`;
}
