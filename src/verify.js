// Makes sure every job leads somewhere real before it is tailored or applied to:
// swaps aggregator links for the company's own application page when one exists,
// opens each link, and expires postings that are closed or broken.
import { pathToFileURL } from 'node:url';
import { resolveDirect } from './resolve.js';
import { askClaude } from './llm.js';
import { detectAts } from './sources.js';
import { config } from './util.js';
import { loadJobs, saveJobs } from './store.js';
import { log, pool } from './util.js';

const DIRECT = /greenhouse\.io|lever\.co|ashbyhq\.com|workable\.com|smartrecruiters\.com|recruitee\.com|breezy\.hr|bamboohr\.com|myworkdayjobs\.com|teamtailor\.com|personio\.|jobvite\.com|icims\.com|successfactors|taleo\.net|zohorecruit/i;
const CLOSED = /no longer (accepting|available|open|active)|position (has been |is )?(filled|closed)|job (is |has )?(closed|expired|been filled)|this (job|position|posting|vacancy) (has expired|is no longer|has been (closed|removed))|posting (has )?(closed|expired)|not accepting (new )?applications|applications (are )?closed|job not found|page not found|404 not found|vacancy (is )?closed/i;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 Edg/130.0';
const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };

async function check(url) {
  const res = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml' }, signal: AbortSignal.timeout(20000) });
  const text = res.ok ? (await res.text()).slice(0, 200000) : '';
  return { status: res.status, finalUrl: res.url, text };
}

export async function verifyLinks({ statuses = ['new', 'tailored', 'ready'], maxAgeHours = 36, ids } = {}) {
  const jobs = loadJobs();
  const list = (ids?.length ? ids.map((id) => jobs[id]).filter(Boolean) : Object.values(jobs))
    .filter((j) => statuses.includes(j.status))
    .filter((j) => ids || !j.link?.at || Date.now() - Date.parse(j.link.at) > maxAgeHours * 36e5);
  if (!list.length) return log('verify: nothing to check');
  log(`verify: checking ${list.length} links`);
  const tally = {};

  await pool(list, 8, async (j) => {
    const link = { at: new Date().toISOString() };
    try {
      // Prefer the company's own ATS over aggregators (they block bots and sometimes go stale).
      if (!DIRECT.test(j.applyUrl || '')) {
        const d = await resolveDirect(j).catch(() => null);
        if (d) { j.applyUrl = d.url; j.ats = d.ats; link.resolved = true; }
      }
      const r = await check(j.applyUrl || j.url).catch((e) => ({ status: 0, error: e.message }));
      link.status = r.status;
      link.finalUrl = r.finalUrl || j.applyUrl;
      link.host = host(link.finalUrl);
      const blocked = r.status === 403 || r.status === 429 || /just a moment|attention required|cf-chl/i.test(r.text || '');
      if (r.status === 404 || r.status === 410) link.kind = 'closed';
      else if (r.status >= 200 && r.status < 400 && CLOSED.test((r.text || '').replace(/<[^>]+>/g, ' ').slice(0, 60000))) link.kind = 'closed';
      else if (/indeed\./i.test(link.host)) link.kind = 'indeed';
      else if (blocked) link.kind = /himalayas/i.test(link.host) ? 'board' : 'blocked';
      else if (r.status === 0 || r.status >= 500) link.kind = 'unreachable';
      else if (DIRECT.test(link.finalUrl)) link.kind = 'direct';
      else link.kind = 'site';
    } catch (e) {
      link.kind = 'unreachable';
      link.error = e.message.slice(0, 120);
    }
    j.link = link;
    if (link.kind === 'closed') { j.status = 'expired'; j.skipReason = 'Posting is closed'; }
    tally[link.kind] = (tally[link.kind] || 0) + 1;
  });

  const fresh = loadJobs();
  for (const j of list) if (fresh[j.id]) fresh[j.id] = { ...fresh[j.id], link: j.link, applyUrl: j.applyUrl, ats: j.ats, status: j.status, skipReason: j.skipReason ?? fresh[j.id].skipReason };
  saveJobs(fresh);
  log(`verify: ${JSON.stringify(tally)}`);
  return tally;
}

// For good jobs whose link goes to Indeed / Himalayas / a bot wall, find the official posting on the web.
async function findOfficial(j) {
  const { data } = await askClaude({
    model: 'sonnet', effort: 'medium', allowedTools: ['WebSearch', 'WebFetch'], timeoutMs: 300000,
    schema: { type: 'object', required: ['url'], properties: { url: { type: ['string', 'null'] }, where: { type: 'string' } } },
    prompt: `Find the official job posting / application page for this role:
Title: "${j.title}"
Company: ${j.company}
Location: ${j.location}

Steps: search the web for "${j.company} careers ${j.title}", "${j.company} jobs", and the title in quotes with the company. Look for the company's own careers site or its applicant tracking system (Workday / myworkdayjobs, SuccessFactors, Oracle, Greenhouse, Lever, Ashby, SmartRecruiters, Workable, Teamtailor, Zoho Recruit, BambooHR, Recruitee). Open candidate pages to confirm it is this role and still open.
Never return Indeed, LinkedIn, Glassdoor, Bayt, GulfTalent, Naukrigulf, Himalayas or other aggregators. If you can't confirm the exact role, return url null.`,
  });
  return data?.url && /^https?:\/\//.test(data.url) && !/indeed\.|linkedin\.|himalayas\.|glassdoor\.|bayt\.com|naukrigulf|gulftalent/i.test(data.url) ? data.url : null;
}

export async function findOfficialLinks({ limit } = {}) {
  const cfg = config();
  const max = limit ?? cfg.officialLookupsPerRun ?? 15;
  const jobs = loadJobs();
  const list = Object.values(jobs)
    .filter((j) => ['indeed', 'board', 'blocked'].includes(j.link?.kind) && !j.link?.officialTried)
    .filter((j) => (j.status === 'tailored' && (j.ai?.fit ?? 0) >= 40) || (j.status === 'new' && j.score >= 65) || j.status === 'ready')
    .sort((a, b) => (b.ai?.fit ?? b.score / 2) - (a.ai?.fit ?? a.score / 2))
    .slice(0, max);
  if (!list.length) return log('official: nothing to look up');
  log(`official: looking up ${list.length} postings`);
  let found = 0;
  await pool(list, 3, async (j) => {
    j.link.officialTried = new Date().toISOString();
    const url = await findOfficial(j).catch(() => null);
    if (!url) return;
    const r = await check(url).catch(() => null);
    if (!r || r.status >= 400) return;
    if (CLOSED.test((r.text || '').replace(/<[^>]+>/g, ' ').slice(0, 60000))) { j.status = 'expired'; j.skipReason = 'Posting is closed'; return; }
    j.applyUrl = r.finalUrl || url;
    j.ats = detectAts(j.applyUrl) || j.ats;
    j.link = { ...j.link, kind: DIRECT.test(j.applyUrl) ? 'direct' : 'site', finalUrl: j.applyUrl, host: host(j.applyUrl), official: true, status: r.status };
    found++;
  });
  const fresh = loadJobs();
  for (const j of list) if (fresh[j.id]) fresh[j.id] = { ...fresh[j.id], link: j.link, applyUrl: j.applyUrl, ats: j.ats, status: j.status, skipReason: j.skipReason ?? fresh[j.id].skipReason };
  saveJobs(fresh);
  log(`official: found ${found}/${list.length} official postings`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  verifyLinks({ maxAgeHours: process.argv.includes('--all') ? 0 : 36 }).then(() => findOfficialLinks()).catch((e) => { log('verify failed:', e.stack); process.exit(1); });
}
