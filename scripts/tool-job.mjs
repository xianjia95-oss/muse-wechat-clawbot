// Built-in Node 24 modules only; usable beside an existing rc.3 installation.
import { parseArgs } from 'node:util';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readSync } from 'node:fs';
import { duration } from '../src/errors.mjs';
import { startJob, listJobs, pendingJobs, cancelJob, settleJob, reconcileJob, runJob, runTool } from '../src/tool-jobs.mjs';

process.umask(0o077);
try {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { dir: { type: 'string' }, id: { type: 'string' }, script: { type: 'string' }, timeout: { type: 'string' }, reviewed: { type: 'boolean' }, text: { type: 'string' }, 'run-id': { type: 'string' } } });
  const root = values.dir ?? join(homedir(), '.local/state/muse-link-worker/jobs');
  const action = positionals[0];
  if (action === '__run') await runJob(root, values.id);
  else if (action === '__exec') await runTool(root, values.id, values['run-id']);
  else if (action === 'start') {
    if (!values.script) throw Object.assign(new Error(), { code: 'missing_script' });
    console.log(JSON.stringify(await startJob(root, values.id, values.script, duration(values.timeout, 120000))));
  } else if (action === 'list') console.log(JSON.stringify({ jobs: listJobs(root) }));
  else if (action === 'pending') console.log(pendingJobs(root));
  else if (action === 'cancel') console.log(JSON.stringify(cancelJob(root, values.id)));
  else if (action === 'settle') console.log(JSON.stringify(settleJob(root, values.id, values.reviewed)));
  else if (action === 'reconcile') {
    if (values.text !== '-') throw Object.assign(new Error(), { code: 'review_required' });
    const buffer = Buffer.alloc(8193); let size = 0, count;
    while (size < buffer.length && (count = readSync(0, buffer, size, buffer.length - size, null))) size += count;
    console.log(JSON.stringify(reconcileJob(root, values.id, values.reviewed, buffer.subarray(0, size).toString('utf8'))));
  }
  else throw Object.assign(new Error(), { code: 'unknown_job_command' });
} catch (error) { console.error(JSON.stringify({ error: error.code ?? 'job_failed' })); process.exitCode = 1; }
