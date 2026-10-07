// Rule-based first pass: eligibility (remote from UAE), salary floor, role fit, freshness.
// The expensive judgement (true fit, tailoring) happens later in tailor.js on the shortlist only.

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const termRe = (terms) =>
  new RegExp(terms.map((t) => (/^[a-z0-9]/i.test(t) ? '\\b' : '') + esc(t) + (/[a-z0-9]$/i.test(t) ? '\\b' : '')).join('|'), 'i');

const FX = { USD: 1, EUR: 1.08, GBP: 1.27, CAD: 0.73, AUD: 0.66, NZD: 0.6, CHF: 1.13, SEK: 0.095, NOK: 0.093, DKK: 0.145, PLN: 0.25, AED: 0.272, SAR: 0.267, QAR: 0.275, INR: 0.012, SGD: 0.74, JPY: 0.0067, BRL: 0.18, MXN: 0.055 };
const SYMBOL = { $: 'USD', '€': 'EUR', '£': 'GBP' };

export function parseSalaryText(text = '') {
  if (!text) return null;
  const t = text.replace(/,/g, '');
  const cur = (t.match(/\b(USD|EUR|GBP|CAD|AUD|CHF|AED|SAR|SGD|INR|PLN|SEK)\b/i) || [])[1]?.toUpperCase() || SYMBOL[(t.match(/[$€£]/) || [])[0]] || null;
  const nums = [...t.matchAll(/(\d+(?:\.\d+)?)\s*(k|K)?/g)]
    .map((m) => +m[1] * (m[2] ? 1000 : 1))
    .filter((n) => n >= 15); // ignore stray small numbers
  if (!nums.length || !cur) return null;
  let period = 'year';
  if (/hour|\/hr|per hr|hourly/i.test(t)) period = 'hour';
  else if (/month|\/mo\b|monthly/i.test(t)) period = 'month';
  const [min, max] = [Math.min(...nums.slice(0, 2)), Math.max(...nums.slice(0, 2))];
  return { min, max, currency: cur, period };
}

export function annualUSD(job) {
  let s = job.salaryMin || job.salaryMax ? { min: job.salaryMin, max: job.salaryMax || job.salaryMin, currency: job.currency || 'USD', period: job.period || 'year' } : parseSalaryText(job.salaryText);
  if (!s || !(s.min || s.max)) return null;
  const rate = FX[(s.currency || 'USD').toUpperCase()] ?? 1;
  const mult = s.period === 'hour' ? 1900 : s.period === 'month' ? 12 : 1;
  let min = (s.min || s.max) * rate * mult;
  let max = (s.max || s.min) * rate * mult;
  if (s.period === 'year' && max < 1000) { min *= 1000; max *= 1000; } // "120-160" meaning k
  if (max < 8000 || min > 2_000_000) return null; // unparseable noise
  return { min: Math.round(min), max: Math.round(max) };
}

export function classifyLocation(job, cfg) {
  const loc = `${job.location || ''}`.toLowerCase();
  const yes = termRe(cfg.locationYes);
  const eu = termRe(cfg.locationEurope);
  const no = termRe(cfg.locationNo);
  const remote = job.remoteHint === true || /remote|anywhere|worldwide|distributed|work from home|wfh/i.test(loc);
  const dubai = /dubai|abu dhabi|united arab emirates|\buae\b/i.test(loc);

  if (dubai) return { eligible: 'yes', label: remote ? 'Remote (UAE ok)' : 'Dubai / UAE', remote };
  if (!remote) return { eligible: 'no', label: 'On-site elsewhere', remote };
  // "Foster City, CA" / "Washington, DC" style US city with no other region = US-only
  const usCity = /,\s*(A[KLRZ]|C[AOT]|D[CE]|FL|GA|HI|I[ADLN]|K[SY]|LA|M[ADEINOST]|N[CDEHJMVY]|O[HKR]|PA|RI|S[CD]|T[NX]|UT|V[AT]|W[AIVY])\b/;
  if (usCity.test(job.location || '') && !yes.test(loc) && !eu.test(loc)) return { eligible: 'no', label: 'US city', remote };
  if (yes.test(loc)) return { eligible: 'yes', label: 'Remote · global', remote };
  if (eu.test(loc) && !no.test(loc.replace(eu, ''))) return { eligible: cfg.includeEuropeOnly ? 'maybe' : 'no', label: 'Remote · Europe', remote };
  if (no.test(loc)) {
    if (eu.test(loc)) return { eligible: cfg.includeEuropeOnly ? 'maybe' : 'no', label: 'Remote · US/EU', remote };
    return { eligible: 'no', label: 'Remote · restricted region', remote };
  }
  // Plain "Remote" with no region: check the description for hard restrictions.
  const d = (job.description || '').slice(0, 4000);
  if (/(must|need to|required to) (be )?(located|based|reside|live) in (the )?(us|u\.s\.|united states|usa|canada)|us citizens? only|authori[sz]ed to work in the (us|united states)|us work authori[sz]ation/i.test(d))
    return { eligible: 'no', label: 'Remote · US work auth', remote };
  return { eligible: 'maybe', label: 'Remote · region unstated', remote };
}

export function scoreJob(job, cfg, now = Date.now()) {
  const title = job.title.toLowerCase();
  const reasons = [];
  const out = { score: 0, family: null, eligible: 'no', locationLabel: '', salaryUSD: null, reasons, excluded: null };

  if (termRe(cfg.excludeTitle).test(title)) { out.excluded = 'title'; return out; }

  // Location / eligibility
  const loc = classifyLocation(job, cfg);
  out.eligible = loc.eligible;
  out.locationLabel = loc.label;
  if (loc.eligible === 'no') { out.excluded = 'location'; return out; }
  const inUae = /dubai|uae/i.test(loc.label);

  // Role fit (title is the strongest signal). UAE-only families need a UAE location.
  let best = null;
  for (const r of cfg.roles) {
    if (r.uaeOnly && !inUae) continue;
    if (termRe(r.terms).test(title) && (!best || r.weight > best.weight)) best = r;
  }
  if (!best) { out.excluded = 'role'; return out; }
  out.family = best.family;
  let score = best.weight;
  reasons.push(best.family);

  if (best.aiBoost && termRe(cfg.aiTerms || []).test(`${job.title} ${(job.description || '').slice(0, 5000)}`)) {
    score += best.aiBoost;
    reasons.push('AI-related');
  }
  if (/\b(senior|sr\.?|lead|head|founding|director|manager)\b/i.test(title)) { score += 5; reasons.push('senior'); }
  if (inUae) score += 4; // local roles: in-person advantage, no work-auth friction
  if (/dubai|uae/i.test(loc.label) && !loc.remote && !cfg.includeDubaiOnsite) { out.excluded = 'location'; return out; }
  score += loc.eligible === 'yes' ? 16 : 6;

  // Salary
  const sal = annualUSD(job);
  out.salaryUSD = sal;
  if (sal) {
    if (sal.max < cfg.salaryFloorUSD) { out.excluded = 'salary'; return out; }
    const mid = (sal.min + sal.max) / 2;
    const pts = mid >= 150000 ? 22 : mid >= 120000 ? 18 : mid >= 90000 ? 14 : mid >= cfg.salaryFloorUSD ? 9 : 4;
    score += pts;
    reasons.push(`$${Math.round(sal.min / 1000)}k–${Math.round(sal.max / 1000)}k`);
  } else if (job.boardCompany) {
    score += 6; // direct boards of well-paying companies rarely list pay
  }

  // Skill overlap in the description
  const desc = `${job.title} ${job.description} ${job.tags.join(' ')}`.toLowerCase();
  const hits = cfg.skills.filter((s) => termRe([s]).test(desc));
  score += Math.min(14, hits.length * 1.5);
  if (hits.length) reasons.push(hits.slice(0, 6).join(', '));

  // Freshness
  const ageDays = job.postedAt ? (now - Date.parse(job.postedAt)) / 864e5 : null;
  if (ageDays != null) {
    if (ageDays > cfg.maxAgeDays) { out.excluded = 'stale'; return out; }
    score += ageDays <= 3 ? 6 : ageDays <= 7 ? 4 : ageDays <= 14 ? 2 : 0;
  }

  // Applications we can pre-fill score a little higher
  if (['greenhouse', 'lever', 'ashby'].includes(job.ats)) score += 3;

  out.score = Math.min(100, Math.round(score));
  return out;
}
