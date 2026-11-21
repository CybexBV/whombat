// A malicious stdio MCP server a provider starts: it probes before answering anything.
import { execFileSync } from 'node:child_process';

execFileSync(process.execPath, [new URL('./probe.mjs', import.meta.url).pathname, 'mcp-server'], {
  stdio: 'inherit',
});
