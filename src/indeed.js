// Indeed (UAE) through the Indeed connector on the user's Claude account.
// One cheap Haiku call runs every search; results are parsed deterministically.
import { askClaude } from './llm.js';
import { job } from './sources.js';
import { log } from './util.js';

const TOOL = 'mcp__claude_ai_Indeed__';

function parse(text) {
  const out = [];
  for (const block of String(text).split(/\*\*Job Title:\*\*/).slice(1)) {
    const f = (k) => (block.match(new RegExp(`\\*\\*${k}:\\*\\*\\s*(.+)`)) || [])[1]?.trim() || '';
    const title = block.split('\n')[0].trim();
    const id = f('Job Id');
    const url = f('View Job URL');
    if (!title || !url) continue;
    const comp = f('Compensation');
    out.push(
      job({
        source: 'indeed', sourceId: `in-${f('Company')}-${title}`, company: f('Company'), title, url, applyUrl: url,
        location: f('Location') || 'United Arab Emirates', salaryText: /n\/a/i.test(comp) ? '' : comp,
        postedAt: f('Posted on'), tags: [f('Job Type'), `indeed:${id}`],
      })
    );
  }
  return out;
}

export async function indeedSearch(terms = []) {
  const list = terms.map((t) => `- "${t}"`).join('\n');
  const prompt = `Call the search_jobs tool once for EACH query below with location "United Arab Emirates" and country_code "AE".
${list}
After all calls, output every tool result verbatim, one after another, with no commentary, no summarising and no reformatting.`;
  const { data } = await askClaude({ prompt, model: 'haiku', effort: 'low', allowedTools: [`${TOOL}search_jobs`], timeoutMs: 420000 });
  const jobs = parse(data);
  log(`indeed: ${jobs.length} jobs parsed`);
  return jobs;
}

// Fetch full descriptions for a shortlist (job ids look like JOBSEARCH_100002 and are only valid per search session,
// so details are requested by title + company through a fresh search when the id lookup fails).
export async function indeedDetails(jobs) {
  if (!jobs.length) return {};
  const items = jobs.map((j) => ({ key: j.id, title: j.title, company: j.company, url: j.url }));
  const prompt = `For each job below, search Indeed (search_jobs, location "United Arab Emirates", country_code "AE", query = the title) and then call get_job_details for the matching result (same company).
Return JSON only.
${JSON.stringify(items)}`;
  const schema = {
    type: 'object', required: ['jobs'],
    properties: { jobs: { type: 'array', items: { type: 'object', required: ['key', 'description'], properties: { key: { type: 'string' }, description: { type: 'string', description: 'Full job description text copied verbatim, max 4000 chars' }, applyUrl: { type: 'string' }, salary: { type: 'string' } } } } },
  };
  try {
    const { data } = await askClaude({ prompt, schema, model: 'haiku', effort: 'low', allowedTools: [`${TOOL}search_jobs`, `${TOOL}get_job_details`], timeoutMs: 600000 });
    return Object.fromEntries((data.jobs || []).map((x) => [x.key, x]));
  } catch (e) {
    log(`indeed details failed: ${e.message}`);
    return {};
  }
}
