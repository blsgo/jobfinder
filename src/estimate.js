// Most postings hide pay. Estimate a realistic monthly range (AED) for every job that
// doesn't list one, in batches, and store it separately from listed salaries.
import { pathToFileURL } from 'node:url';
import { askClaude } from './llm.js';
import { loadJobs, saveJobs } from './store.js';
import { log, pool, config } from './util.js';

export const USD_TO_AED = 3.6725;

// Best available monthly pay ceiling in AED: listed salary first, estimate second.
export function monthlyMaxAED(j) {
  if (j.salaryUSD) return (j.salaryUSD.max * USD_TO_AED) / 12;
  if (j.salaryEst) return j.salaryEst.maxAED;
  return null;
}

const SCHEMA = {
  type: 'object', required: ['estimates'],
  properties: {
    estimates: {
      type: 'array',
      items: {
        type: 'object', required: ['id', 'minAED', 'maxAED'],
        properties: {
          id: { type: 'string' },
          minAED: { type: 'integer', description: 'Monthly gross, AED' },
          maxAED: { type: 'integer', description: 'Monthly gross, AED' },
          basis: { type: 'string', description: 'Max 8 words: what the estimate is based on' },
        },
      },
    },
  },
};

async function estimateChunk(chunk) {
  const prompt = `Estimate the realistic monthly gross pay range in AED for each job below, as of 2026, for a mid-to-senior hire.
Use the company's region, size and the role's market rate. Remote roles at US/EU companies hiring from the UAE usually pay contractor rates below US levels. UAE on-site roles: use UAE market pay (tax-free, monthly).
Keep ranges tight (max is at most 1.5x min). Return one entry per id.
${JSON.stringify(chunk.map((j) => ({ id: j.id, title: j.title, company: j.company, location: j.location, where: j.locationLabel, snippet: (j.description || '').slice(0, 500) })))}`;
  const { data } = await askClaude({ prompt, schema: SCHEMA, model: 'sonnet', effort: 'low', timeoutMs: 240000 });
  return data.estimates || [];
}

export async function estimateSalaries({ ids, all } = {}) {
  const jobs = loadJobs();
  const todo = (ids?.length ? ids.map((id) => jobs[id]) : Object.values(jobs))
    .filter((j) => j && !j.salaryUSD && (all || !j.salaryEst) && !['expired', 'skipped'].includes(j.status));
  if (!todo.length) log('estimate: nothing new to estimate');
  const chunks = [];
  for (let i = 0; i < todo.length; i += 25) chunks.push(todo.slice(i, i + 25));
  log(`estimate: ${todo.length} jobs in ${chunks.length} batches`);
  const results = (await pool(chunks, 3, (c) => estimateChunk(c).catch((e) => { log(`estimate batch failed: ${e.message}`); return []; }))).flat();
  const fresh = loadJobs();
  let n = 0;
  for (const e of results) {
    if (!fresh[e.id] || !(e.minAED > 0)) continue;
    fresh[e.id].salaryEst = { minAED: e.minAED, maxAED: Math.max(e.minAED, e.maxAED), basis: e.basis || '', at: new Date().toISOString() };
    n++;
  }
  // Below the pay floor: don't spend effort or applications on it.
  const floor = config().minMonthlyAED || 0;
  let low = 0;
  for (const j of Object.values(fresh)) {
    const m = monthlyMaxAED(j);
    if (floor && m != null && m < floor && ['new', 'tailored', 'ready'].includes(j.status)) {
      j.status = 'skipped'; j.skipReason = `Pays under AED ${Math.round(floor / 1000)}k/month`; low++;
    }
  }
  saveJobs(fresh);
  log(`estimate: ${n} salaries estimated, ${low} below the pay floor skipped`);
  return n;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  estimateSalaries({ all: process.argv.includes('--all') }).catch((e) => { log('estimate failed:', e.stack); process.exit(1); });
}
