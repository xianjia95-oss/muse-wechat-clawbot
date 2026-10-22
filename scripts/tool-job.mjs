// Built-in Node 24 modules only; usable beside an existing rc.3 installation.
import { parseArgs } from 'node:util';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { duration } from '../src/errors.mjs';
import { startJob, listJobs, pendingJobs, cancelJob, settleJob, runJob } from '../src/tool-jobs.mjs';

process.umask(0o077);
try {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { dir: { type: 'string' }, id: { type: 'string' }, script: { type: 'string' }, timeout: { type: 'string' }, reviewed: { type: 'boolean' } } });
  const root = values.dir ?? join(homedir(), '.local/state/muse-link-worker/jobs');
  const action = positionals[0];
  if (action === '__run') await runJob(root, values.id);
  else if (action === 'start') {
    if (!values.script) throw Object.assign(new Error(), { code: 'missing_script' });
    console.log(JSON.stringify(await startJob(root, values.id, values.script, duration(values.timeout, 120000))));
  } else if (action === 'list') console.log(JSON.stringify({ jobs: listJobs(root) }));
  else if (action === 'pending') console.log(pendingJobs(root));
  else if (action === 'cancel') console.log(JSON.stringify(cancelJob(root, values.id)));
  else if (action === 'settle') console.log(JSON.stringify(settleJob(root, values.id, values.reviewed)));
  else throw Object.assign(new Error(), { code: 'unknown_job_command' });
} catch (error) { console.error(JSON.stringify({ error: error.code ?? 'job_failed' })); process.exitCode = 1; }
