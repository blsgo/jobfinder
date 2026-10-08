// Autopilot: opens each tailored job in an off-screen Edge window, fills it, uploads the CV
// and cover letter, answers remaining questions truthfully from the profile (or leaves them),
// then submits when config.autoApply.submit is true. Anything it can't finish honestly
// (CAPTCHA, login wall, unknown eligibility answer) goes to the "Needs you" list.
// Usage: node src/autopilot.js [--limit N] [--dry] [jobId,...]
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { fillPage, pickCombo, declineCookies } from './apply.js';
import { resolveDirect } from './resolve.js';
import { askClaude } from './llm.js';
import { sanitize, STYLE_RULES } from './humanize.js';
import { loadJobs, updateJob } from './store.js';
import { DATA, config, profile as loadProfile, log, sleep } from './util.js';

const CONFIRM_RE = /thank(s| you)( so much)? for (applying|your application|your interest|submitting)|application (has been |was )?(submitted|received|sent)|we('ve| have) received your application|successfully (submitted|applied)|your application is (in|complete)/i;

// ---- in-page: list every required control that is still empty ----
const COLLECT = () => {
  const reqMark = (s) => /\*|✱|required/i.test(s || '');
  const textOf = (el) => (el?.innerText || el?.textContent || '').replace(/\s+/g, ' ').trim();
  const labelFor = (el) => {
    if (el.id) { const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`); if (l) return textOf(l); }
    if (el.closest('label')) return textOf(el.closest('label'));
    const lb = el.getAttribute('aria-labelledby');
    if (lb) return lb.split(' ').map((id) => textOf(document.getElementById(id))).join(' ');
    return el.getAttribute('aria-label') || el.placeholder || '';
  };
  const questionFor = (el) => {
    // Most ATS widgets point at the question text through aria-labelledby on the control or its wrapper.
    const lbHost = el.closest('[aria-labelledby]');
    if (lbHost && lbHost.contains(el)) {
      const first = textOf(document.getElementById(lbHost.getAttribute('aria-labelledby').split(' ')[0]));
      if (first && (el.type === 'radio' || el.type === 'checkbox' || lbHost.getAttribute('role'))) return first;
    }
    const byId = document.getElementById(`${el.id || el.name}_label`) || (el.name && document.getElementById(`${el.name}_label`));
    if (byId) return textOf(byId);
    const qa = el.closest('[data-ui^="QA_"], [data-ui="question"]');
    if (qa) { const l = qa.querySelector('label, legend, [id$="_label"], span'); if (l && textOf(l).length > 3) return textOf(l); }
    const fs = el.closest('fieldset');
    if (fs?.querySelector('legend')) return textOf(fs.querySelector('legend'));
    const rg = el.closest('[role="radiogroup"], [role="group"]');
    if (rg) { const lb = rg.getAttribute('aria-labelledby'); if (lb) return textOf(document.getElementById(lb.split(' ')[0])); if (rg.getAttribute('aria-label')) return rg.getAttribute('aria-label'); }
    const own = labelFor(el);
    if (own && el.type !== 'radio' && el.type !== 'checkbox') return own;
    let node = el.parentElement;
    for (let i = 0; i < 6 && node; i++, node = node.parentElement) {
      if (node.querySelectorAll('input, select, textarea').length > 12) break; // walked out of this question
      const lab = node.querySelector(':scope > label, :scope > legend, :scope > [class*="label"], :scope > [class*="question"], :scope > p, :scope > span, :scope > div > label');
      if (lab && !lab.contains(el) && textOf(lab).length > 3) return textOf(lab);
    }
    return own;
  };
  const visible = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return (r.width > 2 && r.height > 2 && s.visibility !== 'hidden') || el.type === 'radio' || el.type === 'checkbox'; };
  let n = 0;
  const tag = (el) => (el.dataset.ap = el.dataset.ap || `ap${n++}`);
  const out = [];
  const groups = {};
  for (const el of document.querySelectorAll('input, select, textarea')) {
    if (['hidden', 'submit', 'button', 'file', 'search', 'password'].includes(el.type) || !visible(el) || el.disabled) continue;
    if (el.getAttribute('aria-hidden') === 'true' || (el.tabIndex === -1 && el.type !== 'radio' && el.type !== 'checkbox' && !el.getAttribute('role'))) continue;
    const q = questionFor(el);
    const required = el.required || el.getAttribute('aria-required') === 'true' || reqMark(q) || reqMark(labelFor(el)) ||
      !!el.closest('[data-ui^="QA_"]')?.querySelector('[required], [aria-required="true"]');
    if (el.type === 'radio' || el.type === 'checkbox') {
      const box = el.closest('[data-ui^="QA_"], fieldset, [role="radiogroup"], [role="group"]');
      const name = box ? (box.dataset.apg = box.dataset.apg || `g${n++}`) : el.name || tag(el);
      (groups[name] ||= { type: el.type, q, required: false, opts: [] });
      groups[name].required ||= required;
      groups[name].opts.push({ key: tag(el), label: labelFor(el) || el.value, checked: el.checked });
      continue;
    }
    if (el.tagName === 'SELECT') {
      const empty = !el.value || el.selectedIndex <= 0 && /select|choose|--|^$/i.test(el.options[el.selectedIndex]?.text || '');
      if (empty && required) out.push({ key: tag(el), kind: 'select', label: q, options: [...el.options].map((o) => o.text.trim()).filter((t) => t && !/^(select|choose|--)/i.test(t)) });
      continue;
    }
    const combo = el.getAttribute('role') === 'combobox' || el.hasAttribute('aria-autocomplete') || !!el.closest('[class*="select__"]');
    const shell = el.closest('[class*="select__control"]') || el.closest('[class*="-control"]') || el.closest('[class*="value-container"]')?.parentElement;
    const chosen = shell?.querySelector('[class*="single-value"], [class*="multi-value"], [class*="singleValue"]');
    const hasValue = el.value?.trim() || (combo && chosen && (chosen.innerText || '').trim());
    if (!hasValue && required) out.push({ key: tag(el), kind: combo ? 'combo' : el.tagName === 'TEXTAREA' ? 'textarea' : 'text', label: q, inputType: el.type });
  }
  for (const [name, g] of Object.entries(groups)) {
    if (g.opts.some((o) => o.checked)) continue;
    if (!g.required) continue;
    out.push({ key: name, kind: g.type === 'radio' || g.opts.length > 1 ? 'choice' : 'checkbox', label: g.q || g.opts[0].label, options: g.opts.map((o) => o.label), optionKeys: g.opts.map((o) => o.key) });
  }
  return out;
};

const CAPTCHA = () => {
  const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 50 && r.height > 50 && getComputedStyle(el).visibility !== 'hidden'; };
  return [...document.querySelectorAll('iframe')].some((f) => /recaptcha\/api2\/bframe|hcaptcha\.com.*(challenge|checkbox)|challenges\.cloudflare\.com|captcha/i.test(f.src) && vis(f) && !/anchor.*size=invisible/.test(f.src));
};

async function resolveQuestions(qs, job, p, cfg) {
  const facts = {
    name: p.name, email: p.email, phone: p.phone, location: p.location, timezone: p.timezone, links: p.links, languages: p.languages, education: p.education,
    summary: p.summary, experience: p.experience, projects: p.projects.map((x) => `${x.name}: ${x.desc}`),
    currentRole: `${p.experience[0].role} at ${p.experience[0].company} since ${p.experience[0].start}`,
    yearsExperience: p.application.yearsExperience, application: p.application, skills: p.skills,
    acknowledgePrivacyPolicies: !!cfg.autoApply.acknowledgePrivacyPolicies,
  };
  const schema = {
    type: 'object', required: ['answers'],
    properties: { answers: { type: 'array', items: { type: 'object', required: ['key', 'answer'], properties: { key: { type: 'string' }, answer: { type: ['string', 'null'] } } } } },
  };
  const prompt = `Job: ${job.title} at ${job.company} (${job.locationLabel}).
Candidate facts: ${JSON.stringify(facts)}
Required questions still unanswered on the application form: ${JSON.stringify(qs.map(({ key, kind, label, options, inputType }) => ({ key, kind, label, options, inputType })))}

Answer each question for the candidate. Rules:
- Truth only. If the answer depends on something not in the facts (visa or residency status, nationality, licences, clearances, criminal record, degree attestation, references), answer null. Null is always better than a guess.
- "Do you have N years of experience in X?" style yes/no: answer "Yes" only if the facts clearly support it, otherwise "No" (an honest No is fine).
- "How many years with X?" numeric: use application.skillYears[X] if present, total years (application.yearsExperience) only for general experience questions; otherwise null. Never estimate a number.
- Previous / current salary: application.currentCompensation if set, else null.
- LinkedIn / portfolio / website URL questions: use links.
- Language level questions: Arabic is native, English is fluent; pick the matching option.
- Preference questions (company size, work style, how you heard): pick what fits a founder who prefers startups/scale-ups, remote or Dubai-based work; "how did you hear" = job board / company website option.
- For "choice"/"select" kinds the answer must be copied exactly from options. For "checkbox" answer "check" or null.
- Privacy policy / data processing acknowledgement checkboxes: "check" only if acknowledgePrivacyPolicies is true, else null. Marketing opt-ins: null.
- Demographic / EEO questions (gender, race, ethnicity, veteran, disability, sexual orientation): choose the "decline / prefer not to say / don't wish to answer" option if present, else null.
- Salary: use application.salaryExpectation; for a numeric field give one number in the currency the question implies (AED monthly for UAE roles if unclear).
- Free-text questions: answer in his voice, 40-120 words, specific to this job, from facts only.
${STYLE_RULES}`;
  const { data } = await askClaude({ prompt, schema, model: 'sonnet', effort: 'low', timeoutMs: 180000 });
  return Object.fromEntries((data.answers || []).filter((a) => a.answer != null && a.answer !== '').map((a) => [a.key, sanitize(String(a.answer))]));
}

// Read back every filled control as label -> value so a reviewer can catch nonsense before submit.
const READBACK = () => {
  const t = (e) => (e?.innerText || e?.textContent || '').replace(/\s+/g, ' ').trim();
  const lab = (el) => {
    if (el.id) { const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`); if (t(l)) return t(l); }
    const byId = document.getElementById(`${el.id || el.name}_label`); if (t(byId)) return t(byId);
    const host = el.closest('[aria-labelledby]'); if (host) { const x = t(document.getElementById(host.getAttribute('aria-labelledby').split(' ')[0])); if (x) return x; }
    const qa = el.closest('[data-ui^="QA_"], fieldset, .application-question, .field'); if (qa) { const l = qa.querySelector('label, legend, [id$="_label"]'); if (t(l)) return t(l); }
    return el.getAttribute('aria-label') || el.placeholder || el.name || '';
  };
  const out = [];
  for (const el of document.querySelectorAll('input, textarea, select')) {
    if (['hidden', 'submit', 'button', 'password', 'search'].includes(el.type) || el.getAttribute('aria-hidden') === 'true') continue;
    const r = el.getBoundingClientRect(); if ((r.width <= 2 || r.height <= 2) && !['radio', 'checkbox', 'file'].includes(el.type)) continue;
    let v = '';
    if (el.type === 'file') v = el.files?.length ? `[file: ${el.files[0].name}]` : '';
    else if (el.type === 'radio' || el.type === 'checkbox') { if (!el.checked) continue; v = `[x] ${t(el.closest('label')) || el.value}`; }
    else if (el.tagName === 'SELECT') v = el.selectedIndex > 0 ? el.options[el.selectedIndex].text : '';
    else if (el.getAttribute('role') === 'combobox' && !el.value) v = t((el.closest('[class*="select__control"]') || el.closest('[class*="-control"]') || el.closest('[class*="value-container"]')?.parentElement)?.querySelector('[class*="single-value"], [class*="multi-value"]'));
    else v = el.value;
    if (v) out.push({ q: lab(el).slice(0, 160), v: String(v).slice(0, 2500) });
  }
  return out;
};

async function reviewForm(page, job, p) {
  const filled = [];
  for (const frame of page.frames()) filled.push(...(await frame.evaluate(READBACK).catch(() => [])));
  const schema = { type: 'object', required: ['ok', 'problems'], properties: { ok: { type: 'boolean' }, problems: { type: 'array', items: { type: 'string' } } } };
  const prompt = `You are the last check before a job application is submitted for ${p.name}. Job: ${job.title} at ${job.company}.
Candidate facts (everything here is true): ${JSON.stringify({ name: p.name, email: p.email, phone: p.phone, location: p.location, links: p.links, languages: p.languages, application: p.application, experience: p.experience, projects: p.projects.map((x) => `${x.name}: ${x.desc}`), skills: p.skills, education: p.education })}
Filled form (question -> value): ${JSON.stringify(filled)}

List every problem: a value that doesn't answer its question, is in the wrong format or currency, repeats the same paragraph in unrelated fields, contains garbage or repeated words, or claims something the facts don't support (e.g. years with a specific tool), or is cut off mid-sentence. Phone numbers with or without the country code are fine, and a country picker showing a dial code like +971 is correct. Only flag material problems: something untrue, garbage, clearly the wrong answer for its question, or truncated. Minor formatting preferences are not problems. Optional fields left empty are fine. An honest "No" to an experience question is fine and is not a problem. Ignore style. ok=true only if there are no problems.`;
  const { data } = await askClaude({ prompt, schema, model: 'sonnet', effort: 'low', timeoutMs: 150000 });
  return { ok: !!data.ok && !(data.problems || []).length, problems: data.problems || [], filled };
}

async function applyAnswers(frame, qs, answers) {
  let n = 0;
  for (const q of qs) {
    const a = answers[q.key];
    if (a == null) continue;
    try {
      if (q.kind === 'select') { await frame.locator(`[data-ap="${q.key}"]`).selectOption({ label: q.options.find((o) => o === a) || a }); n++; }
      else if (q.kind === 'choice') {
        const i = q.options.findIndex((o) => o.trim().toLowerCase() === a.trim().toLowerCase());
        if (i >= 0) { await frame.locator(`[data-ap="${q.optionKeys[i]}"]`).check({ force: true }); n++; }
      } else if (q.kind === 'checkbox') { if (a === 'check') { await frame.locator(`[data-ap="${q.optionKeys[0]}"]`).check({ force: true }); n++; } }
      else if (q.kind === 'combo') {
        const extra = /hear|find|source|learn about/i.test(q.label) ? ['Job board', 'Company website', 'Website', 'Internet', 'Other'] : [];
        if (await pickCombo(frame, frame.locator(`[data-ap="${q.key}"]`), [a, ...extra])) n++;
      }
      else { await frame.locator(`[data-ap="${q.key}"]`).fill(a); n++; }
    } catch {}
  }
  return n;
}

async function collectAll(page) {
  const qs = [];
  for (const frame of page.frames()) {
    const list = await frame.evaluate(COLLECT).catch(() => []);
    qs.push(...list.map((q) => ({ ...q, frame })));
  }
  return qs;
}

async function reachForm(page) {
  // Listing pages (Himalayas, RemoteOK, Workable view...) link out to the real form.
  for (let hop = 0; hop < 3; hop++) {
    await declineCookies(page);
    const hasForm = await page.locator('input[type="email"], input[name*="email" i], input[type="file"]').count();
    if (hasForm) return true;
    const link = page.locator('a:visible, button:visible').filter({ hasText: /^\s*(apply( now| for this (job|position|role))?|apply on company (site|website)|i'?m interested|easy apply)\s*$/i }).first();
    if (!(await link.count())) return false;
    const [popup] = await Promise.all([page.context().waitForEvent('page', { timeout: 6000 }).catch(() => null), link.click({ timeout: 5000 }).catch(() => {})]);
    if (popup) { await page.goto(popup.url(), { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {}); await popup.close().catch(() => {}); }
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(1500);
  }
  return (await page.locator('input[type="email"], input[name*="email" i], input[type="file"]').count()) > 0;
}

async function clickSubmit(page) {
  const btn = page.locator('button:visible, input[type="submit"]:visible').filter({ hasText: /submit|send application|apply now|^\s*apply\s*$|complete application/i }).last();
  if (await btn.count()) { await btn.scrollIntoViewIfNeeded().catch(() => {}); await btn.click({ timeout: 8000 }); return true; }
  const sub = page.locator('input[type="submit"]:visible, button[type="submit"]:visible').last();
  if (await sub.count()) { await sub.click({ timeout: 8000 }); return true; }
  return false;
}

async function waitForConfirmation(page, ms = 25000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const text = await page.evaluate(() => document.body?.innerText?.slice(0, 6000) || '').catch(() => '');
    if (CONFIRM_RE.test(text) || /confirmation|thank-?you|application-submitted|\/success/i.test(page.url())) return { ok: true };
    if (await hasCaptcha(page)) return { ok: false, captcha: true, why: 'Human check after submit' };
    await sleep(1500);
  }
  const errs = await page.evaluate(() => [...document.querySelectorAll('[role="alert"], [class*="error"]:not(:empty), [aria-invalid="true"]')].map((e) => (e.innerText || e.getAttribute('name') || '').trim()).filter(Boolean).slice(0, 5)).catch(() => []);
  return { ok: false, why: errs.length ? `Form errors: ${errs.join(' · ').slice(0, 200)}` : 'No confirmation page' };
}

const HANDOFF = "Pre-filled. Tick 'Verify you are human', then Submit";
const CAPTCHA_TEXT = /verify you are human|i'?m not a robot|complete the security check|confirm you are human|are you a robot/i;
async function hasCaptcha(page) {
  if (await page.evaluate(CAPTCHA).catch(() => false)) return true;
  // Challenge widgets often live in shadow DOM; Playwright still sees their frames.
  for (const f of page.frames()) {
    if (!/challenges\.cloudflare\.com|hcaptcha\.com|recaptcha\/api2\/bframe|turnstile/i.test(f.url())) continue;
    const box = await (await f.frameElement().catch(() => null))?.boundingBox().catch(() => null);
    if (box && box.width > 50 && box.height > 40) return true;
  }
  const text = await page.evaluate(() => document.body?.innerText?.slice(-4000) || '').catch(() => '');
  return CAPTCHA_TEXT.test(text);
}

// Everything short of submitting: reach the form, fill it, attach files, answer what the facts allow.
export async function prepareForm(page, job, p, cfg = config()) {
  if (!(await reachForm(page))) return { stop: 'No application form found (external site or login needed)' };
  if (await page.locator('input[type="password"]:visible').count()) return { stop: 'Asks you to create an account' };
  const fill = await fillPage(page, job, p);
  await page.waitForTimeout(2500); // some ATSs parse the CV and autofill fields; let that settle, then correct it
  const addr = page.locator('input[name="address"]:visible, input[id="address"]:visible').first();
  if (await addr.count() && !new RegExp(p.city || 'Dubai', 'i').test(await addr.inputValue().catch(() => p.city || 'Dubai'))) {
    await addr.fill(p.location).catch(() => {}); await addr.press('Escape').catch(() => {});
  }
  let qs = await collectAll(page);
  if (qs.length) {
    const answers = await resolveQuestions(qs, job, p, cfg).catch((e) => { log(`autopilot: answer step failed ${e.message}`); return {}; });
    if (job.files?.dir) fs.writeFileSync(path.join(job.files.dir, 'autopilot-answers.json'), JSON.stringify({ questions: qs.map(({ frame, ...q }) => q), answers }, null, 2));
    for (const frame of new Set(qs.map((q) => q.frame))) await applyAnswers(frame, qs.filter((q) => q.frame === frame), answers);
    await page.waitForTimeout(800);
    qs = await collectAll(page);
  }
  return { fill, qs };
}

const DIRECT_ATS = ['greenhouse', 'lever', 'ashby', 'workable', 'recruitee', 'smartrecruiters', 'breezy'];
const BOT_WALLED = ['himalayas', 'indeed'];

async function processJob(ctx, job, p, cfg, live) {
  const note = (state, extra = {}) => ({ state, at: new Date().toISOString(), ...extra });
  // Aggregator pages often sit behind bot walls: go straight to the company's own ATS when we can find it.
  if (!DIRECT_ATS.includes(job.ats)) {
    const direct = await resolveDirect(job).catch(() => null);
    if (direct) { job.applyUrl = direct.url; job.ats = direct.ats; updateJob(job.id, { applyUrl: direct.url, ats: direct.ats }); }
    else if (BOT_WALLED.includes(job.source)) return note('needs-you', { why: `${job.source} blocks automated browsers; open the job link yourself` });
  }
  const page = await ctx.newPage();
  try {
    await page.goto(job.applyUrl || job.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForLoadState('networkidle', { timeout: 12000 }).catch(() => {});
    if (/just a moment|attention required|blocked/i.test(await page.title().catch(() => ''))) return note('needs-you', { why: 'Site bot check; open the job link yourself' });
    if (/indeed\.com\/(account|auth)|linkedin\.com\/(login|authwall|checkpoint)|accounts\.google/i.test(page.url())) return note('needs-you', { why: 'Login wall' });
    const prep = await prepareForm(page, job, p, cfg);
    if (prep.stop) return note('needs-you', { why: prep.stop });
    const { fill } = prep;
    let { qs } = prep;
    const shot = path.join(job.files?.dir || DATA, 'autopilot-form.png');
    await page.screenshot({ path: shot, fullPage: true }).catch(() => {});
    if (qs.length) return note('needs-you', { why: 'Questions only you can answer', todo: qs.map((q) => q.label.slice(0, 120)), filled: fill.filled.length });
    if (await hasCaptcha(page)) return note('needs-you', { why: HANDOFF, handoff: true, filled: fill.filled.length });
    if (!fill.filled.some((f) => /CV/.test(f))) return note('needs-you', { why: 'Could not attach CV', filled: fill.filled.length });
    const review = await reviewForm(page, job, p).catch((e) => ({ ok: false, problems: [`review failed: ${e.message.slice(0, 80)}`] }));
    if (job.files?.dir) fs.writeFileSync(path.join(job.files.dir, 'autopilot-review.json'), JSON.stringify(review, null, 2));
    if (!review.ok) return note('needs-you', { why: 'Final check found issues', todo: review.problems.slice(0, 6), filled: fill.filled.length });
    if (!live) return note('dry-run-ok', { filled: fill.filled.length });

    if (!(await clickSubmit(page))) return note('needs-you', { why: 'Submit button not found' });
    const res = await waitForConfirmation(page);
    await page.screenshot({ path: path.join(job.files?.dir || DATA, 'autopilot-result.png'), fullPage: true }).catch(() => {});
    if (res.ok) return note('applied', { filled: fill.filled.length });
    return note('needs-you', { why: res.captcha ? HANDOFF : res.why, handoff: !!res.captcha, filled: fill.filled.length });
  } catch (e) {
    return note('error', { why: e.message.slice(0, 200) });
  } finally {
    await page.close().catch(() => {});
  }
}

export async function autopilot({ limit, ids, dry } = {}) {
  const cfg = config();
  const ap = cfg.autoApply || {};
  if (!ap.enabled && !ids) return log('autopilot: disabled in config');
  const live = !dry && !!ap.submit;
  const p = loadProfile();
  const jobs = loadJobs();
  const today = new Date().toISOString().slice(0, 10);
  const doneToday = Object.values(jobs).filter((j) => j.appliedVia === 'autopilot' && (j.appliedAt || '').startsWith(today));
  const perCompany = {};
  doneToday.forEach((j) => (perCompany[j.company] = (perCompany[j.company] || 0) + 1));
  const budget = Math.max(0, (limit ?? ap.maxPerDay ?? 50) - (live ? doneToday.length : 0));

  const queue = (ids?.length ? ids.map((id) => jobs[id]).filter(Boolean) : Object.values(jobs)
    .filter((j) => ['tailored', 'ready'].includes(j.status) && j.files?.cv && (ap.verdicts || ['apply']).includes(j.ai?.verdict) && (j.ai?.fit ?? 0) >= (ap.minFit ?? 50))
    .filter((j) => ids || !j.autopilot || (j.autopilot.state === 'dry-run-ok' && live) || j.autopilot.state === 'error' || (dry && j.autopilot.state === 'needs-you'))
    .sort((a, b) => (b.ai?.fit ?? 0) - (a.ai?.fit ?? 0)))
    .filter((j) => (perCompany[j.company] = (perCompany[j.company] || 0) + 1) <= (ap.maxPerCompanyPerDay ?? 2))
    .slice(0, budget);

  log(`autopilot: ${queue.length} jobs, ${live ? 'LIVE submit' : 'dry run (no submit)'}`);
  if (!queue.length) return;
  // Fresh browser every run: ATS forms save drafts in local storage, and stale drafts must never leak in.
  let browser = await chromium.launch({ channel: 'msedge', headless: false, args: ['--window-position=-32000,-32000'] }); // off-screen
  let ctx = await browser.newContext({ viewport: { width: 1366, height: 900 }, locale: 'en-US' });
  const tally = {};
  try {
    for (const [i, job] of queue.entries()) {
      if (!browser.isConnected()) { // window closed / PC slept: start a fresh one and carry on
        browser = await chromium.launch({ channel: 'msedge', headless: false, args: ['--window-position=-32000,-32000'] });
        ctx = await browser.newContext({ viewport: { width: 1366, height: 900 }, locale: 'en-US' });
      }
      let r = await processJob(ctx, job, p, cfg, live);
      if (r.state === 'error' && /closed|disconnected/i.test(r.why || '')) r = { ...r, state: 'error', why: 'Browser closed mid-run; will retry next run' };
      tally[r.state] = (tally[r.state] || 0) + 1;
      const patch = { autopilot: r };
      if (r.state === 'applied') Object.assign(patch, { status: 'applied', appliedAt: r.at, appliedVia: 'autopilot' });
      if (r.state === 'needs-you') Object.assign(patch, { status: 'ready', prefill: { todo: r.todo || [r.why], at: r.at } });
      if (r.state === 'error') Object.assign(patch, { status: 'tailored' });
      updateJob(job.id, patch);
      log(`autopilot: ${r.state.toUpperCase()}${r.why ? ` (${r.why})` : ''} | ${job.title} @ ${job.company}`);
      if (i < queue.length - 1) {
        const [a, b] = live ? ap.delaySeconds || [25, 70] : [2, 4];
        await sleep((a + Math.random() * (b - a)) * 1000);
      }
    }
  } finally {
    await browser.close().catch(() => {});
  }
  log(`autopilot: done ${JSON.stringify(tally)}`);
  fs.writeFileSync(path.join(DATA, 'last-autopilot.json'), JSON.stringify({ at: new Date().toISOString(), live, tally }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const opt = { dry: args.includes('--dry') };
  const li = args.indexOf('--limit');
  if (li >= 0) opt.limit = +args[li + 1];
  const idArg = args.find((a) => /^[0-9a-f]{10}(,[0-9a-f]{10})*$/.test(a));
  if (idArg) opt.ids = idArg.split(',');
  autopilot(opt).catch((e) => { log('autopilot failed:', e.stack); process.exit(1); });
}
