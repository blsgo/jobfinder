// Opens tailored jobs in a dedicated Edge window, pre-fills every field it recognises,
// attaches the tailored CV + cover letter, flags what still needs a human, and marks the
// job "applied" automatically when the ATS confirmation page appears.
// Usage: node src/apply.js <jobId> [jobId...]   |   node src/apply.js --next 5
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { loadJobs, updateJob } from './store.js';
import { DATA, profile as loadProfile, log } from './util.js';

const CONFIRM_RE = /thank(s| you) for (applying|your application|your interest)|application (has been )?(submitted|received)|we('ve| have) received your application|successfully (submitted|applied)/i;

function answerMap(p, job) {
  const ai = job.ai || {};
  const a = p.application || {};
  const L = p.links || {};
  const current = p.experience?.[0] || {};
  // Rules match the field's own label only, and short labels only: real questions go to the
  // AI resolver in autopilot.js, which sees the full question text.
  const R = (src) => new RegExp(String.raw`^\s*[*✱]?\s*(${src})\s*[*✱]?\s*(\(optional\))?\s*[*✱]?\s*$`, 'i');
  return [
    [R('preferred (first )?name'), p.firstName],
    [R(String.raw`first\s*name|given name|forename`), p.firstName],
    [R(String.raw`last\s*name|surname|family name`), p.lastName],
    [R('(full |legal |your )?name'), p.name],
    [R('(your )?e-?mail( address)?'), p.email],
    [R('(mobile |cell |your )?(phone|mobile|telephone)( number)?'), p.phone],
    [R('linkedin( profile)?( url)?|linkedin profile url|if you have a linkedin profile.*'), L.linkedin],
    [R('github( profile)?( url)?'), L.github || null],
    [R('(portfolio|personal website|website|blog|other website)( url| link)?'), L.portfolio || L.website],
    [R('(current |most recent )?(company|employer)( name)?'), current.company],
    [R('(current |most recent )?(job )?(title|role|position)'), current.role],
    [R('(expected|desired) (annual |monthly )?(salary|compensation)|salary expectations?'), a.salaryExpectation],
    [R('notice period'), a.noticePeriod],
    [R('(earliest |possible )?start date|when can you start\??'), a.startDate],
    [R('(total |overall )?years of (professional |work )?experience|how many years of (professional |work )?experience do you have\??'), a.yearsExperience],
    [R('cover letter|covering letter'), ai.coverLetter],
    [R(String.raw`city|current city|location|current location|location \(city\)|city of residence`), p.city || 'Dubai'],
    [R('country( of residence)?'), p.country],
  ];
}

// Tag every visible form control with an id and describe it by its best label.
const DESCRIBE = () => {
  const vis = (el) => {
    if (el.type === 'file') return true;
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
  };
  const textOf = (e) => (e?.innerText || e?.textContent || '').replace(/\s+/g, ' ').trim();
  const labelOf = (el) => {
    if (el.id) { const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`); if (textOf(l)) return textOf(l); }
    const byId = document.getElementById(`${el.id || el.name}_label`);
    if (textOf(byId)) return textOf(byId);
    const lb = el.getAttribute('aria-labelledby');
    if (lb) { const t = lb.split(' ').map((id) => textOf(document.getElementById(id))).join(' ').trim(); if (t) return t; }
    if (el.getAttribute('aria-label')) return el.getAttribute('aria-label').trim();
    const own = el.closest('label');
    if (own && textOf(own)) return textOf(own);
    const qa = el.closest('[data-ui^="QA_"], .application-question, .field, [class*="question"]');
    if (qa && qa.querySelectorAll('input, textarea, select').length <= 3) { const l = qa.querySelector('label, legend, [id$="_label"], [class*="label"]'); if (textOf(l)) return textOf(l); }
    return el.placeholder || '';
  };
  let n = 0;
  return [...document.querySelectorAll('input, textarea, select')]
    .filter((el) => !['hidden', 'submit', 'button', 'image', 'reset', 'search'].includes(el.type) && vis(el) && el.getAttribute('aria-hidden') !== 'true')
    .map((el) => {
      el.dataset.jsId = el.dataset.jsId || `js${n++}`;
      return {
        key: el.dataset.jsId, tag: el.tagName.toLowerCase(), type: el.type || '', label: labelOf(el),
        combo: el.getAttribute('role') === 'combobox' || el.hasAttribute('aria-autocomplete') || !!el.closest('[class*="select__"], [class*="autocomplete"]'),
        value: el.type === 'file' ? (el.files?.length ? 'x' : '') : /^\s*\+?\d{1,4}\s*$/.test(el.value || '') && (el.type === 'tel' || /phone|mobile/i.test(el.name + el.id)) ? '' : el.value || '',
        required: el.required || el.getAttribute('aria-required') === 'true' || /\*|✱/.test(labelOf(el)),
        accept: el.accept || '',
        max: el.maxLength > 0 ? el.maxLength : 0,
      };
    });
};

// Cookie banners block clicks. Always take the most private option offered.
export async function declineCookies(page) {
  const btn = page.locator('button:visible, a[role="button"]:visible').filter({ hasText: /^\s*(decline all|reject all|decline|reject|reject non-essential|only necessary|necessary only|use necessary cookies only|accept necessary|essential only|deny)\s*$/i }).first();
  if (await btn.count().catch(() => 0)) { await btn.click({ timeout: 3000 }).catch(() => {}); await page.waitForTimeout(600); }
}

export async function fillPage(page, job, p) {
  await declineCookies(page);
  // Greenhouse/Lever/Ashby sometimes need a click on "Apply" to reveal the form.
  for (const sel of ['a:has-text("Apply for this job")', 'button:has-text("Apply for this job")', 'a:has-text("Apply now")', 'button:has-text("Apply")']) {
    const btn = page.locator(sel).first();
    if ((await page.locator('input[type="email"], input[name*="email" i]').count()) > 0) break;
    if (await btn.isVisible().catch(() => false)) { await btn.click().catch(() => {}); await page.waitForTimeout(2000); break; }
  }
  await page.waitForTimeout(1500);

  const rules = answerMap(p, job);
  const fields = [];
  for (const frame of page.frames()) {
    const list = await frame.evaluate(DESCRIBE).catch(() => []);
    fields.push(...list.map((f) => ({ ...f, frame })));
  }

  const filled = [];
  const todo = [];
  let fileIdx = 0;
  for (const f of fields) {
    const loc = f.frame.locator(`[data-js-id="${f.key}"]`);
    const lab = f.label.toLowerCase();
    try {
      if (f.type === 'file') {
        const isLetter = /cover/.test(lab);
        const file = isLetter ? job.files?.letter : fileIdx++ === 0 || /resume|cv\b|curriculum/.test(lab) ? job.files?.cv : null;
        if (file && !f.value) { await loc.setInputFiles(file); filled.push(isLetter ? 'Cover letter (PDF)' : 'CV (PDF)'); }
        continue;
      }
      if (f.value) continue;
      if (['checkbox', 'radio'].includes(f.type)) {
        if (f.required) todo.push(f.label.split(' | ')[0] || f.type);
        continue;
      }
      // Dropdowns / comboboxes: only factual picks; eligibility questions stay with the human.
      if (f.tag === 'select' || f.combo) {
        const pick = CHOICES.find(([re]) => re.test(lab));
        const ok = pick && (f.tag === 'select' ? await pickNative(loc, pick[1]) : await pickCombo(f.frame, loc, pick[1]));
        if (ok) filled.push(f.label.split(' | ')[0].slice(0, 40));
        else if (f.required) todo.push(f.label.split(' | ')[0]);
        continue;
      }
      const rule = lab.length <= 80 ? rules.find(([re]) => re.test(f.label)) : null;
      if (!rule) { if (f.required) todo.push(f.label.split(' | ')[0]); continue; }
      const val = rule[1];
      if (!val) { if (f.required) todo.push(f.label.split(' | ')[0]); continue; }
      let text = String(val);
      // Respect character limits: fall back to the short pitch, then cut at a sentence boundary.
      if (f.max && text.length > f.max) {
        const alt = job.ai?.shortPitch && job.ai.shortPitch.length <= f.max ? job.ai.shortPitch : null;
        text = alt || text.slice(0, f.max).replace(/[^.!?]*$/, '').trim();
        if (!text) { if (f.required) todo.push(f.label); continue; }
      }
      // Long answers only into textareas; a short field labelled "cover letter" gets skipped
      if (f.tag !== 'textarea' && text.length > 400) { todo.push(f.label.split(' | ')[0]); continue; }
      await loc.fill(text, { timeout: 4000 });
      filled.push(f.label.split(' | ')[0].slice(0, 40));
    } catch {
      if (f.required) todo.push(f.label.split(' | ')[0]);
    }
  }
  return { filled, todo: [...new Set(todo.map((t) => t.replace(/[|*✱]/g, '').trim()).filter(Boolean))], fieldCount: fields.length };
}

const CHOICES = [
  [/sponsor|authori[sz]|right to work|legally|eligib|relocat|willing to|clearance|citizen/, null],
  [/country/, ['United Arab Emirates', 'UAE']],
  [/city|location|where are you (based|located)/, ['Dubai']],
  [/how did you (hear|find|learn)|source/, ['Company website', 'Company Website', 'Careers', 'Website', 'Job board', 'Other']],
];

async function pickNative(loc, wanted) {
  if (!wanted) return false;
  const opts = await loc.evaluate((el) => [...el.options].map((o) => ({ v: o.value, t: o.text.trim() })));
  for (const w of wanted) {
    const o = opts.find((x) => x.t.toLowerCase() === w.toLowerCase()) || opts.find((x) => x.t.toLowerCase().includes(w.toLowerCase()));
    if (o) { await loc.selectOption(o.v); return true; }
  }
  return false;
}

export async function pickCombo(frame, loc, wanted) {
  if (!wanted) return false;
  const esc = (w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const w of wanted) {
    const typed = w.split(/[,(]/)[0].trim(); // "Dubai, United Arab Emirates" -> type "Dubai"
    await loc.click({ timeout: 3000 }).catch(() => {});
    await loc.fill('').catch(() => {});
    await loc.pressSequentially(typed, { delay: 90 });
    for (let t = 0; t < 14; t++) { // location pickers geocode asynchronously; give them ~8s
      await frame.waitForTimeout(600);
      const opt = frame.locator('[role="option"], .select__option, [class*="option"], li[id*="option"]').filter({ hasText: new RegExp(esc(typed), 'i') }).filter({ visible: true }).first();
      if (await opt.isVisible().catch(() => false)) { await opt.click(); return true; }
    }
  }
  await loc.fill('').catch(() => {});
  await loc.press('Escape').catch(() => {});
  return false;
}

async function banner(page, job, result) {
  await page.evaluate(({ title, company, filled, todo, letter, fieldCount }) => {
    document.getElementById('jsk-bar')?.remove();
    const bar = document.createElement('div');
    bar.id = 'jsk-bar';
    bar.style.cssText = 'position:fixed;z-index:2147483647;left:12px;right:12px;bottom:12px;padding:14px 18px;border-radius:16px;background:#020204;color:#cdd4e6;font:500 14px/1.45 Rajdhani,Segoe UI,sans-serif;border:1px solid rgba(216,180,254,.35);box-shadow:0 8px 40px rgba(168,85,247,.3);display:flex;gap:16px;align-items:center;flex-wrap:wrap';
    const status = fieldCount === 0
      ? '<b style="color:#fbbf24">No form found on this page.</b> Click the site\'s Apply button, then press <b>Re-fill</b> in the dashboard, or apply with the files in the job folder.'
      : `<b style="color:#d8b4fe">Pre-filled ${filled.length} fields.</b> ${todo.length ? `<span style="color:#fbbf24">Needs you: ${todo.slice(0, 8).join(' · ')}</span>` : 'Everything recognised is filled.'} Review, then press the site\'s <b>Submit</b>.`;
    bar.innerHTML = `<div style="flex:1;min-width:260px"><div style="letter-spacing:.2em;text-transform:uppercase;font-size:11px;color:#8892b0">${company} · ${title}</div>${status}</div>`;
    const btn = (label, fn) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.style.cssText = 'border-radius:100px;border:1px solid rgba(216,180,254,.35);background:rgba(216,180,254,.15);color:#d8b4fe;padding:7px 16px;font:600 12px Rajdhani,Segoe UI;letter-spacing:.15em;text-transform:uppercase;cursor:pointer';
      b.onclick = fn;
      bar.appendChild(b);
      return b;
    };
    const cp = btn('Copy cover letter', async () => { await navigator.clipboard.writeText(letter); cp.textContent = 'Copied'; });
    btn('Hide', () => bar.remove());
    document.body.appendChild(bar);
    document.querySelectorAll('[data-js-id]').forEach((el) => {
      if (!el.value && (el.required || el.getAttribute('aria-required') === 'true') && el.type !== 'file') el.style.outline = '2px solid #fbbf24';
    });
  }, { title: job.title, company: job.company, letter: job.ai?.coverLetter || '', ...result });
}

function watchForConfirmation(page, job) {
  const check = async () => {
    const text = await page.evaluate(() => document.body?.innerText?.slice(0, 5000) || '').catch(() => '');
    if (CONFIRM_RE.test(text) || /confirmation|thank-you|thanks|submitted/i.test(page.url())) {
      updateJob(job.id, { status: 'applied', appliedAt: new Date().toISOString(), appliedVia: 'autofill' });
      log(`apply: confirmed submission ${job.title} @ ${job.company}`);
      return true;
    }
    return false;
  };
  const timer = setInterval(async () => { if (await check()) clearInterval(timer); }, 2500);
  page.on('close', () => clearInterval(timer));
}

export async function openApplications(ids) {
  const p = loadProfile();
  const jobs = loadJobs();
  const list = ids.map((id) => jobs[id]).filter(Boolean);
  if (!list.length) throw new Error('no matching jobs');

  const opts = { channel: 'msedge', headless: false, viewport: null, args: ['--start-maximized'], permissions: ['clipboard-read', 'clipboard-write'] };
  // The main profile keeps ATS logins between sessions; if a window is already open it is locked, so use a spare one.
  const ctx = await chromium.launchPersistentContext(path.join(DATA, 'browser-profile'), opts)
    .catch(() => chromium.launchPersistentContext(path.join(DATA, `browser-profile-${Date.now() % 100000}`), opts));
  const blank = ctx.pages()[0];
  for (const job of list) {
    const page = await ctx.newPage();
    try {
      await page.goto(job.applyUrl || job.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
      const result = await fillPage(page, job, p);
      await banner(page, job, result);
      updateJob(job.id, { status: job.status === 'applied' ? 'applied' : 'ready', prefill: { filled: result.filled.length, todo: result.todo, at: new Date().toISOString() } });
      log(`apply: pre-filled ${result.filled.length} fields, ${result.todo.length} need review | ${job.title} @ ${job.company}`);
      watchForConfirmation(page, job);
    } catch (e) {
      log(`apply: failed to open ${job.title} @ ${job.company}: ${e.message}`);
    }
  }
  if (blank && ctx.pages().length > 1) await blank.close().catch(() => {});
  await ctx.pages()[0]?.bringToFront();
  await new Promise((r) => ctx.on('close', r)); // stay alive until the window is closed
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  let ids = args;
  if (args[0] === '--next') {
    const n = +(args[1] || 5);
    ids = Object.values(loadJobs())
      .filter((j) => j.status === 'tailored' && j.ai?.verdict !== 'skip')
      .sort((a, b) => (b.ai?.fit ?? 0) - (a.ai?.fit ?? 0))
      .slice(0, n)
      .map((j) => j.id);
  }
  openApplications(ids).catch((e) => { log('apply failed:', e.message); process.exit(1); });
}
