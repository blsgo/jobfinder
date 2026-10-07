import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA = path.join(ROOT, 'data');
export const OUTPUT = path.join(ROOT, 'output');
export const PROFILE_DIR = path.join(ROOT, 'profile');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) JobSeeker/1.0 (+https://webtactics.org)';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function fetchText(url, { timeout = 30000, retries = 1 } = {}) {
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, Accept: 'application/json, text/xml, */*' },
        signal: AbortSignal.timeout(timeout),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (err) {
      if (i === retries) throw new Error(`${url}: ${err.message}`);
      await sleep(1500);
    }
  }
}

export async function fetchJson(url, opts) {
  return JSON.parse(await fetchText(url, opts));
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'", rsquo: "'", lsquo: "'", rdquo: '"', ldquo: '"', mdash: '-', ndash: '-', hellip: '...' };

export function decodeEntities(s = '') {
  return String(s)
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z0-9#]+);/gi, (m, k) => ENTITIES[k.toLowerCase()] ?? m);
}

export function stripHtml(html = '') {
  let s = decodeEntities(html); // some feeds double-escape their HTML
  s = s
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|li|h\d|tr)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, ' ');
  return decodeEntities(s)
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/\n\s*\n\s*/g, '\n\n')
    .trim();
}

export function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

export const config = () => readJson(path.join(ROOT, 'config.json'), {});
export const profile = () => readJson(path.join(PROFILE_DIR, 'profile.json'), null) || readJson(path.join(PROFILE_DIR, 'profile.example.json'), {});

export function slug(s = '') {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
}

export function log(...args) {
  const line = `[${new Date().toISOString().slice(0, 19).replace('T', ' ')}] ${args.join(' ')}`;
  console.log(line);
  fs.mkdirSync(DATA, { recursive: true });
  fs.appendFileSync(path.join(DATA, 'run.log'), line + '\n');
}

export async function pool(items, limit, fn) {
  const out = [];
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}
