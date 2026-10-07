// Local dashboard: http://127.0.0.1:4545
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, exec } from 'node:child_process';
import { loadJobs, updateJob } from './store.js';
import { ROOT, DATA, OUTPUT, readJson } from './util.js';

const PORT = +(process.env.PORT || 4545);
const running = new Map(); // task name -> child

function runTask(name, args) {
  if (running.has(name)) return false;
  const child = spawn(process.execPath, args, { cwd: ROOT, windowsHide: true, stdio: 'ignore' });
  running.set(name, child);
  child.on('exit', () => running.delete(name));
  return true;
}

const send = (res, code, body, type = 'application/json') => {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
};

const body = (req) => new Promise((r) => { let s = ''; req.on('data', (d) => (s += d)); req.on('end', () => { try { r(JSON.parse(s || '{}')); } catch { r({}); } }); });

const STRIP = ({ description, ...j }) => ({ ...j, snippet: (description || '').slice(0, 600) });

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;
  try {
    if (p === '/' || p === '/index.html') return send(res, 200, fs.readFileSync(path.join(ROOT, 'public', 'index.html')), 'text/html; charset=utf-8');

    if (p === '/api/jobs') {
      const jobs = Object.values(loadJobs()).map(STRIP);
      const lastRun = readJson(path.join(DATA, 'last-run.json'), null);
      return send(res, 200, { jobs, running: [...running.keys()], lastRun });
    }

    let m;
    if ((m = p.match(/^\/api\/job\/(\w+)$/))) return send(res, 200, loadJobs()[m[1]] || null);

    if ((m = p.match(/^\/api\/job\/(\w+)\/status$/)) && req.method === 'POST') {
      const { status } = await body(req);
      const patch = { status };
      if (status === 'applied') patch.appliedAt = new Date().toISOString();
      return send(res, 200, updateJob(m[1], patch));
    }

    if (p === '/api/apply' && req.method === 'POST') {
      const { ids = [] } = await body(req);
      if (!ids.length) return send(res, 400, { error: 'no ids' });
      const ok = runTask(`apply-${Date.now()}`, ['src/apply.js', ...ids]);
      return send(res, 200, { ok });
    }

    if (p === '/api/tailor' && req.method === 'POST') {
      const { ids, limit } = await body(req);
      const arg = ids?.length ? ids.join(',') : String(limit || 10);
      return send(res, 200, { ok: runTask('tailor', ['src/tailor.js', arg]) });
    }

    if (p === '/api/run' && req.method === 'POST') return send(res, 200, { ok: runTask('daily', ['src/run.js']) });
    if (p === '/api/autopilot' && req.method === 'POST') return send(res, 200, { ok: runTask('autopilot', ['src/autopilot.js']) });

    if (p === '/api/log') {
      const log = fs.existsSync(path.join(DATA, 'run.log')) ? fs.readFileSync(path.join(DATA, 'run.log'), 'utf8') : '';
      return send(res, 200, { lines: log.trim().split('\n').slice(-60) });
    }

    if ((m = p.match(/^\/api\/job\/(\w+)\/folder$/)) && req.method === 'POST') {
      const j = loadJobs()[m[1]];
      if (j?.files?.dir) exec(`explorer "${j.files.dir}"`);
      return send(res, 200, { ok: !!j?.files?.dir });
    }

    if (p === '/file') {
      const f = path.resolve(url.searchParams.get('path') || '');
      if (!f.startsWith(path.resolve(OUTPUT)) || !fs.existsSync(f)) return send(res, 404, 'not found', 'text/plain');
      return send(res, 200, fs.readFileSync(f), f.endsWith('.pdf') ? 'application/pdf' : 'text/plain; charset=utf-8');
    }

    send(res, 404, { error: 'not found' });
  } catch (e) {
    send(res, 500, { error: e.message });
  }
});

server.listen(PORT, '127.0.0.1', () => console.log(`Job Seeker dashboard: http://127.0.0.1:${PORT}`));
