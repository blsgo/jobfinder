// Daily autopilot: hunt every source, tailor the best new matches, then apply.
import path from 'node:path';
import { hunt } from './hunt.js';
import { tailorBatch } from './tailor.js';
import { autopilot } from './autopilot.js';
import { loadJobs } from './store.js';
import { DATA, writeJson, log } from './util.js';

const started = new Date().toISOString();
try {
  const h = await hunt();
  await tailorBatch();
  await autopilot();
  const jobs = Object.values(loadJobs());
  const today = new Date().toISOString().slice(0, 10);
  const summary = {
    started, finished: new Date().toISOString(), newMatches: h.added,
    appliedToday: jobs.filter((j) => (j.appliedAt || '').startsWith(today)).length,
    needsYou: jobs.filter((j) => j.status === 'ready').length,
    ready: jobs.filter((j) => j.status === 'tailored').length,
    applied: jobs.filter((j) => j.status === 'applied').length,
  };
  writeJson(path.join(DATA, 'last-run.json'), summary);
  log(`daily: done. ${summary.newMatches} new matches, ${summary.appliedToday} applied today, ${summary.needsYou} need you`);
} catch (e) {
  log('daily failed:', e.stack);
  process.exit(1);
}
