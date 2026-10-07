// Finds the company's own application page for jobs found on aggregators that block bots
// (Himalayas, Indeed...). Probes the common ATS public APIs by company-name slug and matches
// the title. Results are cached per company.
import path from 'node:path';
import { fetchJson, readJson, writeJson, DATA } from './util.js';

const CACHE = path.join(DATA, 'resolve-cache.json');

const PROBES = [
  ['workable', (s) => `https://apply.workable.com/api/v1/widget/accounts/${s}`, (d) => (d.jobs || []).map((j) => ({ title: j.title, url: j.application_url || j.url }))],
  ['greenhouse', (s) => `https://boards-api.greenhouse.io/v1/boards/${s}/jobs`, (d) => (d.jobs || []).map((j) => ({ title: j.title, url: j.absolute_url }))],
  ['lever', (s) => `https://api.lever.co/v0/postings/${s}?mode=json`, (d) => (d || []).map((j) => ({ title: j.text, url: j.applyUrl }))],
  ['ashby', (s) => `https://api.ashbyhq.com/posting-api/job-board/${s}`, (d) => (d.jobs || []).map((j) => ({ title: j.title, url: j.applyUrl }))],
  ['recruitee', (s) => `https://${s}.recruitee.com/api/offers`, (d) => (d.offers || []).map((j) => ({ title: j.title, url: j.careers_apply_url || j.careers_url }))],
  ['smartrecruiters', (s) => `https://api.smartrecruiters.com/v1/companies/${s}/postings?limit=100`, (d) => (d.content || []).map((j) => ({ title: j.name, url: `https://jobs.smartrecruiters.com/${s}/${j.id}` }))],
  ['breezy', (s) => `https://${s}.breezy.hr/json`, (d) => (Array.isArray(d) ? d : []).map((j) => ({ title: j.name, url: j.url }))],
];

const STOP = /\b(llc|l\.l\.c|inc|ltd|limited|gmbh|corp|corporation|co|company|group|holding|holdings|fze|fzco|fz|dmcc|plc|sa|bv|ab|oy|dubai|uae|technologies|technology)\b\.?/g;

function slugs(company = '') {
  const base = company.toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9 ]+/g, ' ');
  const core = base.replace(STOP, ' ').replace(/\s+/g, ' ').trim();
  const words = core.split(' ').filter(Boolean);
  const all = base.replace(/\s+/g, ' ').trim().split(' ');
  return [...new Set([words.join(''), words.join('-'), all.join(''), all.join('-'), words[0], words.slice(0, 2).join('')].filter((s) => s && s.length > 2))];
}

const tokens = (t) => new Set(t.toLowerCase().replace(/\(.*?\)|remote|[^a-z0-9 ]/g, ' ').split(/\s+/).filter((w) => w.length > 1));
function similar(a, b) {
  const A = tokens(a), B = tokens(b);
  const inter = [...A].filter((x) => B.has(x)).length;
  return inter / Math.max(1, Math.min(A.size, B.size));
}

export async function resolveDirect(job) {
  const cache = readJson(CACHE, {});
  const key = job.company.toLowerCase();
  let boards = cache[key];
  if (!boards || Date.now() - boards.at > 2 * 864e5) {
    boards = { at: Date.now(), found: [] };
    for (const s of slugs(job.company).slice(0, 4)) {
      for (const [ats, url, map] of PROBES) {
        try {
          const list = map(await fetchJson(url(s), { timeout: 12000, retries: 0 }));
          if (list.length) boards.found.push({ ats, slug: s, jobs: list.slice(0, 400) });
        } catch {}
      }
      if (boards.found.length) break;
    }
    cache[key] = boards;
    writeJson(CACHE, cache);
  }
  let best = null;
  for (const b of boards.found) for (const j of b.jobs) {
    const sc = similar(job.title, j.title);
    if (sc >= 0.75 && (!best || sc > best.sc)) best = { sc, ats: b.ats, url: j.url };
  }
  return best;
}
