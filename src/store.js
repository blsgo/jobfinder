import path from 'node:path';
import crypto from 'node:crypto';
import { DATA, readJson, writeJson } from './util.js';

const FILE = path.join(DATA, 'jobs.json');

// status: new -> tailored -> ready (pre-filled) -> applied -> interview / offer / rejected | skipped
export function loadJobs() {
  return readJson(FILE, {});
}

export function saveJobs(jobs) {
  writeJson(FILE, jobs);
}

const companyKey = (c = '') => c.toLowerCase().replace(/[,.]?\s*\b(inc|llc|ltd|limited|gmbh|corp|corporation|co|bv|ab|oy|sa|plc)\.?$/g, '').replace(/\.(com|io|ai|co)$/, '');

export const dedupeKey = (j) =>
  `${companyKey(j.company)}|${j.title}`.toLowerCase().replace(/\(.*?\)|remote|[^a-z0-9|]+/g, '');

export const jobId = (j) => crypto.createHash('sha1').update(dedupeKey(j)).digest('hex').slice(0, 10);

export function updateJob(id, patch) {
  const jobs = loadJobs();
  if (!jobs[id]) return null;
  jobs[id] = { ...jobs[id], ...patch, updatedAt: new Date().toISOString() };
  saveJobs(jobs);
  return jobs[id];
}
