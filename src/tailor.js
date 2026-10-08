// For the best untouched matches: Claude judges real fit, then writes a tailored CV,
// cover letter and stock answers. Renders PDFs into output/<date>-<company>-<role>/.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { askClaude } from './llm.js';
import { monthlyMaxAED } from './estimate.js';
import { sanitizeAll, findTells, STYLE_RULES } from './humanize.js';
import { cvHtml, letterHtml, htmlToPdf, closeBrowser } from './render.js';
import { loadJobs, saveJobs } from './store.js';
import { config, profile as loadProfile, OUTPUT, slug, log, pool } from './util.js';

const SYSTEM = `You are a senior recruiter and career strategist placing AI automation specialists, operations generalists, creative leads and digital managers, both remote and in the UAE.

Who the candidate is: a founder and systems builder, not a traditional software engineer. He designs automations, AI agents, content pipelines and digital products and builds them with AI coding agents. Position him that way. Never present him as a hand-coding engineer, and lower the fit for roles that are really software engineering, ML research or need deep classical coding interviews.

Hard rules:
- Use ONLY facts present in the candidate profile. Never invent employers, titles, years, metrics, degrees, clients, certifications or tools. You may rephrase, reorder and choose emphasis.
- Be honest about fit. If the role needs things he clearly lacks (years in a specific industry, a licence or clearance, a location he can't work from, another language), lower the fit and say so in risks.
- For UAE management roles, lean on: running a company, P&L, clients across the GCC, building systems that save teams time, bilingual Arabic/English.
- Cover letter: 120-180 words, 3 short paragraphs, starts "Hi <Company> team," and ends with the candidate's full name on its own line. First sentence is proof, not a greeting formula.

${STYLE_RULES}`;

const SCHEMA = (projectIds, skillCats) => ({
  type: 'object',
  additionalProperties: false,
  required: ['fit', 'verdict', 'reason', 'risks', 'headline', 'summary', 'bullets', 'projectIds', 'skillsOrder', 'skillHighlights', 'coverLetter', 'whyCompany', 'shortPitch'],
  properties: {
    fit: { type: 'integer', minimum: 0, maximum: 100, description: 'Realistic chance-weighted fit: would a recruiter shortlist him?' },
    verdict: { type: 'string', enum: ['apply', 'maybe', 'skip'] },
    reason: { type: 'string', description: 'One sentence: why this verdict.' },
    risks: { type: 'string', description: 'Eligibility or gap risks in one sentence, empty if none.' },
    headline: { type: 'string', description: 'CV headline tuned to this role, max 70 chars, no colon.' },
    summary: { type: 'string', description: '3-4 sentence CV profile aimed at this role.' },
    bullets: { type: 'array', minItems: 5, maxItems: 7, items: { type: 'string' }, description: 'Web Tactics experience bullets reordered/rephrased for this role. Facts only. Each under 38 words.' },
    projectIds: { type: 'array', minItems: 4, maxItems: 6, items: { type: 'string', enum: projectIds } },
    skillsOrder: { type: 'array', items: { type: 'string', enum: skillCats } },
    skillHighlights: { type: 'array', maxItems: 12, items: { type: 'string' }, description: 'Exact skill strings from the profile most relevant to this job.' },
    coverLetter: { type: 'string' },
    whyCompany: { type: 'string', description: '2-3 sentences answering "Why do you want to work here?"' },
    shortPitch: { type: 'string', description: 'Max 280 chars for "Anything else we should know?"' },
  },
});

export async function tailorJob(job, p = loadProfile()) {
  const prompt = `CANDIDATE PROFILE (JSON):
${JSON.stringify({ ...p, application: undefined })}

JOB POSTING
Company: ${job.company}
Title: ${job.title}
Location: ${job.location} (${job.locationLabel})
Salary: ${job.salaryUSD ? `~$${job.salaryUSD.min}-${job.salaryUSD.max}/yr` : job.salaryText || 'not stated'}
URL: ${job.url}
Description:
${(job.description || '').slice(0, 7000)}

Assess fit and produce the tailored application materials.`;

  const schema = SCHEMA(p.projects.map((x) => x.id), Object.keys(p.skills));
  let { data, costUSD } = await askClaude({ prompt, system: SYSTEM, schema });
  if (!data || typeof data !== 'object' || !data.coverLetter) throw new Error('bad tailoring output');

  // One rewrite pass if anything still reads as machine-written.
  const proseOf = (d) => [d.summary, d.coverLetter, d.whyCompany, d.shortPitch, ...(d.bullets || [])].join('\n');
  const tells = findTells(proseOf(data));
  if (tells.length && data.verdict !== 'skip') {
    const fix = await askClaude({
      prompt: `Rewrite this JSON so the writing sounds like a person, removing: ${tells.join(', ')}. Keep every fact, field and the same structure.
${JSON.stringify(data)}`,
      system: SYSTEM, schema,
    }).catch(() => null);
    if (fix?.data?.coverLetter) { data = fix.data; costUSD += fix.costUSD; }
  }
  data = sanitizeAll(data);
  data.tells = findTells(proseOf(data));

  const dir = path.join(OUTPUT, `${new Date().toISOString().slice(0, 10)}-${slug(job.company)}-${slug(job.title)}`.slice(0, 120));
  fs.mkdirSync(dir, { recursive: true });
  const files = { dir };
  if (data.verdict !== 'skip') {
    files.cv = await htmlToPdf(cvHtml(p, data), path.join(dir, `CV - ${p.name}.pdf`));
    files.letter = await htmlToPdf(letterHtml(p, data.coverLetter, data.headline), path.join(dir, `Cover Letter - ${p.name}.pdf`));
    fs.writeFileSync(path.join(dir, 'cover-letter.txt'), data.coverLetter);
  }
  fs.writeFileSync(path.join(dir, 'application.json'), JSON.stringify({ job: { ...job, description: undefined }, ai: data }, null, 2));
  return { ai: data, files, costUSD };
}

// Write applications for the jobs most worth it first: fit, then pay, then a link we can actually apply through.
function priority(j) {
  const m = monthlyMaxAED(j) || 0;
  const pay = m >= 45000 ? 18 : m >= 35000 ? 13 : m >= 28000 ? 9 : m >= 20000 ? 4 : 0;
  const link = j.link?.kind === 'direct' ? 8 : ['indeed', 'board', 'blocked'].includes(j.link?.kind) ? -6 : 0;
  return j.score + pay + link;
}

export async function tailorBatch({ limit, ids } = {}) {
  const cfg = config();
  const p = loadProfile();
  const jobs = loadJobs();
  const queue = ids?.length
    ? ids.map((id) => jobs[id]).filter(Boolean)
    : Object.values(jobs)
        .filter((j) => j.status === 'new' && j.score >= cfg.minScoreToTailor)
        .filter((j) => { const m = monthlyMaxAED(j); return m == null || m >= (cfg.minMonthlyAED ?? 0); })
        .sort((a, b) => priority(b) - priority(a))
        .slice(0, limit ?? cfg.tailorPerRun);

  log(`tailor: ${queue.length} jobs`);
  let cost = 0;
  await pool(queue, 3, async (job) => {
    try {
      const { ai, files, costUSD } = await tailorJob(job, p);
      cost += costUSD;
      const fresh = loadJobs(); // re-read: other workers save too
      fresh[job.id] = { ...fresh[job.id], ai, files, status: ai.verdict === 'skip' ? 'skipped' : 'tailored', tailoredAt: new Date().toISOString() };
      saveJobs(fresh);
      log(`tailor: ${ai.verdict.toUpperCase()} fit ${ai.fit} | ${job.title} @ ${job.company}`);
    } catch (e) {
      log(`tailor: failed ${job.title} @ ${job.company}: ${e.message}`);
    }
  });
  await closeBrowser();
  log(`tailor: done, ~$${cost.toFixed(2)} list-price equivalent`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const arg = process.argv[2];
  const opts = arg && /^\d+$/.test(arg) ? { limit: +arg } : arg ? { ids: arg.split(',') } : {};
  tailorBatch(opts).catch((e) => { log('tailor failed:', e.stack); process.exit(1); });
}
