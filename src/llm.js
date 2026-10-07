// Runs Claude through the local Claude Code CLI, so tailoring uses the existing
// subscription with no separate API key. Structured output via --json-schema.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function claudeBinary() {
  const candidates = [
    process.env.CLAUDE_BIN,
    path.join(process.env.APPDATA || '', 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'),
    path.join(os.homedir(), '.local', 'bin', 'claude.exe'),
  ].filter(Boolean);
  return candidates.find((p) => fs.existsSync(p)) || 'claude';
}

export function askClaude({ prompt, system, schema, model = 'sonnet', effort = 'medium', timeoutMs = 240000, allowedTools }) {
  const args = ['-p', '--model', model, '--effort', effort, '--output-format', 'json', '--setting-sources', '', '--no-session-persistence'];
  // No tools by default; MCP connector tools (e.g. Indeed) only when explicitly allowed.
  if (allowedTools?.length) args.push('--allowedTools', ...allowedTools);
  else args.push('--tools', '', '--strict-mcp-config');
  if (system) args.push('--system-prompt', system);
  if (schema) args.push('--json-schema', JSON.stringify(schema));

  return new Promise((resolve, reject) => {
    const child = spawn(claudeBinary(), args, { cwd: os.tmpdir(), windowsHide: true });
    let out = '';
    let err = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('claude timed out')); }, timeoutMs);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      try {
        const res = JSON.parse(out);
        if (res.is_error) return reject(new Error(res.result || res.api_error_status || 'claude error'));
        let data = res.structured_output ?? res.result;
        if (typeof data === 'string') {
          const m = data.match(/\{[\s\S]*\}/);
          data = m ? JSON.parse(m[0]) : data;
        }
        resolve({ data, costUSD: res.total_cost_usd || 0 });
      } catch {
        reject(new Error(`claude exit ${code}: ${(err || out).slice(0, 400)}`));
      }
    });
    child.stdin.end(prompt);
  });
}
