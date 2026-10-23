import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { fail, integer } from './errors.mjs';

export const VERSION = '0.4.0-rc.7';
export const OPS_DEFAULTS = Object.freeze({
  max_inflight_sends: 64, max_peer_sends: 16, max_pending_events: 2000,
  min_free_bytes: 128 * 1024 * 1024, max_state_bytes: 1024 * 1024 * 1024,
  max_outbox_bytes: 512 * 1024 * 1024, max_http_requests: 128,
  backlog_warn_ms: 300000, worker_claim_warn_ms: 60000, poll_stale_ms: 120000, worker_stale_ms: 600000,
  event_retention_days: 7, send_retention_days: 90, failed_media_retention_days: 7,
  maintenance_interval_ms: 3600000, shutdown_timeout_ms: 180000,
});
export const operational = (config) => ({ ...OPS_DEFAULTS, ...config.operations });

export const defaultConfigPath = () => join(homedir(), '.config', 'muse-link', 'config.json');
export const expand = (path) => resolve(path.startsWith('~/') ? join(homedir(), path.slice(2)) : path);

export function privateJson(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomBytes(8).toString('hex')}.tmp`;
  writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  const fd = openSync(temp, 'r+');
  try { fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temp, path);
  chmodSync(path, 0o600);
  if (process.platform !== 'win32') {
    const directory = openSync(dirname(path), 'r');
    try { fsyncSync(directory); } finally { closeSync(directory); }
  }
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
    require_lease_token: true,
    operations: { ...OPS_DEFAULTS },
  });
  return { path, created: true };
}

export function loadConfig(path = defaultConfigPath()) {
  if (!existsSync(path)) fail('missing_config', 'Run muse-link init first.', 500);
  const config = JSON.parse(readFileSync(path, 'utf8'));
  if (!/^[a-z0-9_-]{1,32}$/.test(config.binding)) fail('invalid_config', 'Invalid binding.');
  if (!['127.0.0.1', '::1'].includes(config.listen?.host)) fail('invalid_config', 'listen.host must be loopback.');
  integer(config.listen.port, 1, 65535, 'listen.port');
  if (typeof config.api_token !== 'string' || !/^[\x21-\x7e]{32,256}$/.test(config.api_token)) fail('invalid_config', 'api_token must contain 32..256 printable ASCII characters without spaces. Run muse-link init to generate a private token.');
  if (!Array.isArray(config.allow_wxids) || config.allow_wxids.some((id) => typeof id !== 'string' || !id)) fail('invalid_config', 'Invalid allow_wxids.');
  integer(config.send_timeout_ms, 100, 120000, 'send_timeout_ms');
  integer(config.poll_timeout_ms, 1000, 120000, 'poll_timeout_ms');
  config.media_timeout_ms ??= 120000;
  config.media_roots ??= ['~/workspace'];
  integer(config.media_timeout_ms, 1000, 600000, 'media_timeout_ms');
  if (!Array.isArray(config.media_roots) || config.media_roots.some((root) => typeof root !== 'string' || !root)) fail('invalid_config', 'media_roots must contain local directories.');
  config.media_roots = config.media_roots.map(expand);
  config.require_lease_token ??= true;
  if (typeof config.require_lease_token !== 'boolean') fail('invalid_config', 'require_lease_token must be boolean.');
  if (config.operations !== undefined && (!config.operations || typeof config.operations !== 'object' || Array.isArray(config.operations))) fail('invalid_config', 'operations must be an object.');
  for (const key of Object.keys(config.operations ?? {})) if (!Object.hasOwn(OPS_DEFAULTS, key)) fail('invalid_config', `Unknown operations option: ${key}`);
  config.operations = operational(config);
  for (const [key, value] of Object.entries(config.operations)) integer(value, 1, Number.MAX_SAFE_INTEGER, `operations.${key}`);
  if (config.operations.event_retention_days > config.operations.send_retention_days) fail('invalid_config', 'send retention must cover event retention.');
  integer(config.operations.shutdown_timeout_ms, 1000, 1800000, 'shutdown_timeout_ms');
  integer(config.operations.maintenance_interval_ms, 1000, 86400000, 'maintenance_interval_ms');
  for (const key of ['event_retention_days', 'send_retention_days', 'failed_media_retention_days']) integer(config.operations[key], 1, 36500, key);
  for (const key of ['max_http_requests', 'max_inflight_sends', 'max_peer_sends']) integer(config.operations[key], 1, 4096, key);
  if (config.operations.max_outbox_bytes >= config.operations.max_state_bytes) fail('invalid_config', 'max_state_bytes must exceed max_outbox_bytes.');
  if (typeof config.state_dir !== 'string' || !config.state_dir) fail('invalid_config', 'state_dir is required.');
  config.state_dir = expand(config.state_dir);
  config.path = resolve(path);
  return config;
}

export function localUrl(config) {
  const host = config.listen.host === '::1' ? '[::1]' : config.listen.host;
  return `http://${host}:${config.listen.port}`;
}
