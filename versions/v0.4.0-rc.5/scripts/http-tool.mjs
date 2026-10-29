import { parseArgs } from 'node:util';
import { runHttpTool } from '../src/http-tool.mjs';

process.umask(0o077);
try {
  const { values } = parseArgs({ options: { request: { type: 'string' }, output: { type: 'string' }, help: { type: 'boolean' } } });
  if (values.help) console.log('node scripts/http-tool.mjs --request <private-request.json> --output <new-private-result-directory>');
  else {
    const report = await runHttpTool(values.request, values.output);
    console.log(JSON.stringify(report));
    process.exitCode = report.exit_code;
  }
} catch {
  console.error(JSON.stringify({ ok: false, reason: 'http_tool_configuration_failed', exit_code: 2 }));
  process.exitCode = 2;
}
