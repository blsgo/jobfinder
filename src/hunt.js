// Fetch every source, dedupe, score, and merge into data/jobs.json without losing statuses.
import { pathToFileURL } from 'node:url';
import { fetchAll } from './sources.js';
import { scoreJob } from './score.js';
import { loadJobs, saveJobs, jobId } from './store.js';
import { config, log } from './util.js';

// Lower = preferred copy of a duplicated posting: company ATS first, bot-walled boards last.
const SOURCE_RANK = { greenhouse: 0, lever: 0, ashby: 0, workable: 0, smartrecruiters: 0, recruitee: 0, breezy: 0, remoteok: 2, jobicy: 2, remotive: 2, weworkremotely: 3, workingnomads: 4, arbeitnow: 4, hackernews: 5, himalayas: 6, indeed: 7 };

export async function hunt() {
  const cfg = config();
  log('hunt: fetching sources...');
  const { jobs: raw, stats } = await fetchAll(cfg.companies, cfg.searchTerms, cfg.uaeSearch);
  log(`hunt: ${raw.length} raw jobs`, JSON.stringify(stats));

  const store = loadJobs();
  const now = Date.now();
  const seen = new Map();
  const excluded = {};
  const byUrl = new Map(Object.values(store).map((j) => [j.url, j.id])); // keep ids stable if the key rules change

  for (const j of raw) {
    if (!j.title || !j.url) continue;
    const s = scoreJob(j, cfg, now);
    if (s.excluded) { excluded[s.excluded] = (excluded[s.excluded] || 0) + 1; continue; }
    const id = byUrl.get(j.url) || jobId(j);
    const prev = seen.get(id);
    // keep the richest / most direct copy of a duplicated posting
    if (prev && (SOURCE_RANK[prev.job.source] ?? 9) <= (SOURCE_RANK[j.source] ?? 9)) {
      prev.job.alsoOn = [...new Set([...(prev.job.alsoOn || []), j.source])];
      continue;
    }
    seen.set(id, { job: j, s });
  }

  let added = 0;
  for (const [id, { job, s }] of seen) {
    const existing = store[id];
    const fields = {
      ...job, id, score: s.score, family: s.family, eligible: s.eligible, locationLabel: s.locationLabel,
      salaryUSD: s.salaryUSD, reasons: s.reasons, lastSeen: new Date().toISOString(),
    };
    if (existing) {
      store[id] = {
        ...existing, ...fields, status: existing.status, ai: existing.ai, files: existing.files,
        description: job.description || existing.description, applyUrl: existing.applyUrl || job.applyUrl,
      };
    } else {
      store[id] = { ...fields, status: 'new', firstSeen: new Date().toISOString() };
      added++;
    }
  }

  // Indeed search results carry no description: fetch it for the best new ones, then re-score.
  const bare = Object.values(store)
    .filter((j) => j.source === 'indeed' && j.status === 'new' && !j.description)
    .sort((a, b) => b.score - a.score)
    .slice(0, 20);
  if (bare.length) {
    const { indeedDetails } = await import('./indeed.js');
    const details = await indeedDetails(bare);
    for (const j of bare) {
      const d = details[j.id];
      if (!d?.description) continue;
      Object.assign(j, { description: d.description.slice(0, 9000), salaryText: j.salaryText || d.salary || '' });
      if (d.applyUrl && /^https?:/.test(d.applyUrl)) j.applyUrl = d.applyUrl;
      const s = scoreJob(j, cfg, now);
      if (s.excluded) j.status = 'expired';
      else Object.assign(j, { score: s.score, salaryUSD: s.salaryUSD, reasons: s.reasons });
    }
    log(`hunt: indeed details for ${Object.keys(details).length}/${bare.length}`);
  }

  // Expire open, untouched jobs that stopped appearing for 10+ days
  for (const j of Object.values(store)) {
    if (j.status === 'new' && now - Date.parse(j.lastSeen) > 10 * 864e5) j.status = 'expired';
  }

  saveJobs(store);
  const open = Object.values(store).filter((j) => j.status === 'new' || j.status === 'tailored');
  log(`hunt: ${seen.size} matches (${added} new). excluded: ${JSON.stringify(excluded)}. open pipeline: ${open.length}`);
  return { added, matches: seen.size, stats, excluded };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  hunt().catch((e) => { log('hunt failed:', e.stack); process.exit(1); });
}
