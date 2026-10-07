// Free job sources. Each fetcher returns normalized jobs:
// { source, sourceId, company, title, url, applyUrl, location, remoteHint, salaryText,
//   salaryMin, salaryMax, currency, period, description, tags, postedAt, ats, boardCompany }
import { fetchJson, fetchText, stripHtml, decodeEntities, pool, log } from './util.js';

const DESC_MAX = 9000;
const clip = (s) => (s || '').slice(0, DESC_MAX);
const iso = (d) => {
  if (!d) return null;
  const t = typeof d === 'number' ? (d < 1e12 ? d * 1000 : d) : Date.parse(d);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};

export function job(o) {
  return {
    source: o.source,
    sourceId: String(o.sourceId ?? o.url),
    company: (o.company || '').trim(),
    title: decodeEntities(o.title || '').trim(),
    url: o.url,
    applyUrl: o.applyUrl || o.url,
    location: (o.location || '').trim(),
    remoteHint: o.remoteHint ?? null,
    salaryText: o.salaryText || '',
    salaryMin: o.salaryMin || null,
    salaryMax: o.salaryMax || null,
    currency: o.currency || null,
    period: o.period || null,
    description: clip(o.description),
    tags: (o.tags || []).filter(Boolean).map(String),
    postedAt: iso(o.postedAt),
    ats: o.ats || detectAts(o.applyUrl || o.url),
    boardCompany: o.boardCompany || null,
  };
}

export function detectAts(url = '') {
  if (/greenhouse\.io/i.test(url)) return 'greenhouse';
  if (/lever\.co/i.test(url)) return 'lever';
  if (/ashbyhq\.com/i.test(url)) return 'ashby';
  if (/workable\.com/i.test(url)) return 'workable';
  if (/myworkdayjobs|workday/i.test(url)) return 'workday';
  if (/smartrecruiters/i.test(url)) return 'smartrecruiters';
  if (/bamboohr/i.test(url)) return 'bamboohr';
  if (/recruitee/i.test(url)) return 'recruitee';
  if (/breezy\.hr/i.test(url)) return 'breezy';
  return null;
}

// ---------- Aggregator boards ----------

async function remoteok() {
  const data = await fetchJson('https://remoteok.com/api');
  return data.filter((x) => x.id && x.position).map((x) =>
    job({
      source: 'remoteok', sourceId: x.id, company: x.company, title: x.position,
      url: x.url, applyUrl: x.apply_url || x.url, location: x.location || 'Remote', remoteHint: true,
      salaryMin: x.salary_min || null, salaryMax: x.salary_max || null, currency: x.salary_min ? 'USD' : null, period: 'year',
      description: stripHtml(x.description), tags: x.tags, postedAt: x.date,
    })
  );
}

async function remotive() {
  const cats = ['software-dev', 'design', 'product', 'data', 'all-others', 'marketing'];
  const lists = await pool(cats, 3, (c) =>
    fetchJson(`https://remotive.com/api/remote-jobs?category=${c}`).then((d) => d.jobs || []).catch(() => [])
  );
  return lists.flat().map((x) =>
    job({
      source: 'remotive', sourceId: x.id, company: x.company_name, title: x.title, url: x.url,
      location: x.candidate_required_location, remoteHint: true, salaryText: x.salary,
      description: stripHtml(x.description), tags: [...(x.tags || []), x.category, x.job_type], postedAt: x.publication_date,
    })
  );
}

async function himalayas() {
  const out = [];
  let cursor = '';
  for (let page = 0; page < 15; page++) {
    const d = await fetchJson(`https://himalayas.app/jobs/api?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    for (const x of d.jobs || []) {
      out.push(
        job({
          source: 'himalayas', sourceId: x.guid, company: x.companyName, title: x.title,
          url: x.guid, applyUrl: x.applicationLink,
          location: (x.locationRestrictions || []).length ? x.locationRestrictions.join(', ') : 'Worldwide',
          remoteHint: true, salaryMin: x.minSalary, salaryMax: x.maxSalary, currency: x.currency,
          period: x.salaryPeriod === 'annual' ? 'year' : x.salaryPeriod,
          description: stripHtml(x.description), tags: [...(x.categories || []), ...(x.seniority || []), x.employmentType],
          postedAt: x.pubDate,
        })
      );
    }
    if (!d.nextCursor || !(d.jobs || []).length) break;
    cursor = d.nextCursor;
  }
  return out;
}

async function jobicy() {
  const inds = ['dev', 'design-multimedia', 'engineering', 'marketing', 'management', 'data-science', 'technical-support'];
  const lists = await pool(inds, 3, (i) =>
    fetchJson(`https://jobicy.com/api/v2/remote-jobs?count=100&industry=${i}`).then((d) => d.jobs || []).catch(() => [])
  );
  return lists.flat().map((x) =>
    job({
      source: 'jobicy', sourceId: x.id, company: x.companyName, title: x.jobTitle, url: x.url,
      location: x.jobGeo, remoteHint: true,
      salaryMin: x.salaryMin || x.annualSalaryMin, salaryMax: x.salaryMax || x.annualSalaryMax,
      currency: x.salaryCurrency, period: /hour/i.test(x.salaryPeriod || '') ? 'hour' : /month/i.test(x.salaryPeriod || '') ? 'month' : 'year',
      description: stripHtml(x.jobDescription), tags: [...(x.jobIndustry || []), ...(x.jobType || []), x.jobLevel],
      postedAt: x.pubDate,
    })
  );
}

async function arbeitnow() {
  const out = [];
  for (let page = 1; page <= 5; page++) {
    const d = await fetchJson(`https://www.arbeitnow.com/api/job-board-api?page=${page}`).catch(() => null);
    if (!d?.data?.length) break;
    for (const x of d.data) {
      if (!x.remote) continue;
      out.push(
        job({
          source: 'arbeitnow', sourceId: x.slug, company: x.company_name, title: x.title, url: x.url,
          location: x.location ? `${x.location} (remote)` : 'Remote', remoteHint: true,
          description: stripHtml(x.description), tags: [...(x.tags || []), ...(x.job_types || [])], postedAt: x.created_at,
        })
      );
    }
  }
  return out;
}

async function weworkremotely() {
  const feeds = [
    'remote-full-stack-programming-jobs', 'remote-front-end-programming-jobs', 'remote-back-end-programming-jobs',
    'remote-programming-jobs', 'remote-design-jobs', 'remote-product-jobs', 'all-other-remote-jobs', 'remote-sales-and-marketing-jobs',
  ];
  const xmls = await pool(feeds, 3, (f) => fetchText(`https://weworkremotely.com/categories/${f}.rss`).catch(() => ''));
  const out = [];
  for (const xml of xmls) {
    for (const item of xml.split('<item>').slice(1)) {
      const tag = (t) => {
        const m = item.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`));
        return m ? m[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim() : '';
      };
      const full = decodeEntities(tag('title'));
      const i = full.indexOf(':');
      out.push(
        job({
          source: 'weworkremotely', sourceId: tag('guid') || tag('link'),
          company: i > 0 ? full.slice(0, i) : '', title: i > 0 ? full.slice(i + 1) : full,
          url: tag('link'), location: decodeEntities(tag('region')) || 'Remote', remoteHint: true,
          description: stripHtml(tag('description')), tags: [tag('category'), tag('type')], postedAt: tag('pubDate'),
        })
      );
    }
  }
  return out;
}

async function workingnomads() {
  const d = await fetchJson('https://www.workingnomads.com/api/exposed_jobs/');
  return d.map((x) =>
    job({
      source: 'workingnomads', sourceId: x.url, company: x.company_name, title: x.title, url: x.url,
      location: x.location || 'Remote', remoteHint: true, description: stripHtml(x.description),
      tags: [x.category_name, ...String(x.tags || '').split(',')], postedAt: x.pub_date,
    })
  );
}

async function hackernews() {
  const s = await fetchJson('https://hn.algolia.com/api/v1/search_by_date?tags=story,author_whoishiring&hitsPerPage=10');
  const story = (s.hits || []).find((h) => /who is hiring/i.test(h.title));
  if (!story) return [];
  const thread = await fetchJson(`https://hn.algolia.com/api/v1/items/${story.objectID}`, { timeout: 60000 });
  const out = [];
  for (const c of thread.children || []) {
    if (!c.text || !/remote/i.test(c.text)) continue;
    const text = stripHtml(c.text);
    const first = text.split('\n')[0];
    const parts = first.split('|').map((p) => p.trim()).filter(Boolean);
    if (parts.length < 2) continue;
    const roleRe = /engineer|developer|designer|lead|head|manager|architect|founding|creative|scientist|full.?stack|frontend|front-end/i;
    const title = parts.slice(1).find((p) => roleRe.test(p) && p.length < 90);
    if (!title || parts[0].length > 60) continue;
    const loc = parts.filter((p) => /remote|onsite|on-site|hybrid|anywhere|worldwide|global|emea|europe|\bus\b|usa/i.test(p)).join(' | ');
    const href = (c.text.match(/href="([^"]+)"/) || [])[1];
    const link = href ? decodeEntities(href) : null;
    out.push(
      job({
        source: 'hackernews', sourceId: c.id, company: parts[0], title,
        url: `https://news.ycombinator.com/item?id=${c.id}`,
        applyUrl: link && !/ycombinator\.com/.test(link) ? link : `https://news.ycombinator.com/item?id=${c.id}`,
        location: loc || 'Remote', remoteHint: true, salaryText: (first.match(/[$€£]\s?\d[\d,.]*k?\s*(?:-|–|to)\s*[$€£]?\s?\d[\d,.]*k?/i) || [''])[0],
        description: text, postedAt: c.created_at, tags: ['hn-who-is-hiring'],
      })
    );
  }
  return out;
}

// ---------- Direct company ATS boards ----------

async function greenhouseBoard(slug) {
  const d = await fetchJson(`https://boards-api.greenhouse.io/v1/boards/${slug}/jobs?content=true`, { timeout: 45000 });
  return (d.jobs || []).map((x) => {
    const desc = stripHtml(x.content || '');
    return job({
      source: 'greenhouse', sourceId: `gh-${slug}-${x.id}`, company: x.company_name || slug, title: x.title,
      url: x.absolute_url, applyUrl: x.absolute_url, location: x.location?.name || '',
      description: desc, postedAt: x.first_published || x.updated_at, ats: 'greenhouse', boardCompany: slug,
      tags: (x.departments || []).map((d) => d.name),
    });
  });
}

async function leverBoard(slug) {
  const d = await fetchJson(`https://api.lever.co/v0/postings/${slug}?mode=json`, { timeout: 45000 });
  return (d || []).map((x) =>
    job({
      source: 'lever', sourceId: `lv-${slug}-${x.id}`, company: slug, title: x.text, url: x.hostedUrl, applyUrl: x.applyUrl,
      location: [x.categories?.location, ...(x.categories?.allLocations || [])].filter(Boolean).join(', '),
      remoteHint: x.workplaceType === 'remote' ? true : x.workplaceType === 'onsite' ? false : null,
      salaryMin: x.salaryRange?.min, salaryMax: x.salaryRange?.max, currency: x.salaryRange?.currency,
      period: /hour/i.test(x.salaryRange?.interval || '') ? 'hour' : 'year',
      description: [x.descriptionPlain, ...(x.lists || []).map((l) => `${l.text}\n${stripHtml(l.content)}`), x.additionalPlain].filter(Boolean).join('\n\n'),
      postedAt: x.createdAt, ats: 'lever', boardCompany: slug, tags: [x.categories?.team, x.categories?.commitment],
    })
  );
}

async function ashbyBoard(slug) {
  const d = await fetchJson(`https://api.ashbyhq.com/posting-api/job-board/${slug}?includeCompensation=true`, { timeout: 45000 });
  return (d.jobs || []).filter((x) => x.isListed !== false).map((x) => {
    const comp = (x.compensation?.summaryComponents || []).find((c) => c.compensationType === 'Salary');
    return job({
      source: 'ashby', sourceId: `ab-${slug}-${x.id}`, company: d.organizationName || slug, title: x.title,
      url: x.jobUrl, applyUrl: x.applyUrl,
      location: [x.location, ...(x.secondaryLocations || []).map((l) => l.location)].filter(Boolean).join(', '),
      remoteHint: x.isRemote ?? null, salaryText: x.compensation?.compensationTierSummary || '',
      salaryMin: comp?.minValue, salaryMax: comp?.maxValue, currency: comp?.currencyCode,
      period: /hour/i.test(comp?.interval || '') ? 'hour' : 'year',
      description: x.descriptionPlain || stripHtml(x.descriptionHtml), postedAt: x.publishedAt,
      ats: 'ashby', boardCompany: slug, tags: [x.department, x.team, x.employmentType],
    });
  });
}

// Targeted keyword searches for the niches the generic feeds under-sample.
async function himalayasSearch(term) {
  const d = await fetchJson(`https://himalayas.app/jobs/api/search?q=${encodeURIComponent(term)}&limit=20`);
  return (d.jobs || []).map((x) =>
    job({
      source: 'himalayas', sourceId: x.guid, company: x.companyName, title: x.title, url: x.guid, applyUrl: x.applicationLink,
      location: (x.locationRestrictions || []).length ? x.locationRestrictions.join(', ') : 'Worldwide', remoteHint: true,
      salaryMin: x.minSalary, salaryMax: x.maxSalary, currency: x.currency, period: x.salaryPeriod === 'annual' ? 'year' : x.salaryPeriod,
      description: stripHtml(x.description), tags: [...(x.categories || []), ...(x.seniority || [])], postedAt: x.pubDate,
    })
  );
}

async function remoteokTag(tag) {
  const data = await fetchJson(`https://remoteok.com/api?tag=${encodeURIComponent(tag)}`);
  return data.filter((x) => x.id && x.position).map((x) =>
    job({
      source: 'remoteok', sourceId: x.id, company: x.company, title: x.position, url: x.url, applyUrl: x.apply_url || x.url,
      location: x.location || 'Remote', remoteHint: true, salaryMin: x.salary_min || null, salaryMax: x.salary_max || null,
      currency: x.salary_min ? 'USD' : null, period: 'year', description: stripHtml(x.description), tags: x.tags, postedAt: x.date,
    })
  );
}

// Workable's public job search: strong for UAE companies.
async function workableSearch(term, location) {
  const out = [];
  let token = '';
  for (let page = 0; page < 3; page++) {
    const d = await fetchJson(`https://jobs.workable.com/api/v1/jobs?query=${encodeURIComponent(term)}&location=${encodeURIComponent(location)}${token ? `&pageToken=${encodeURIComponent(token)}` : ''}`);
    for (const x of d.jobs || []) {
      const loc = x.location ? [x.location.city, x.location.countryName].filter(Boolean).join(', ') : (x.locations || []).join('; ');
      out.push(
        job({
          source: 'workable', sourceId: x.id, company: x.company?.title, title: x.title, url: x.url, applyUrl: x.url,
          location: x.workplace === 'remote' ? `Remote, ${loc}` : loc, remoteHint: x.workplace === 'remote' ? true : null,
          description: stripHtml([x.description, x.requirementsSection, x.benefitsSection].filter(Boolean).join('\n')),
          tags: [x.department, x.employmentType, x.workplace], postedAt: x.created, ats: 'workable',
        })
      );
    }
    if (!d.nextPageToken || !(d.jobs || []).length) break;
    token = d.nextPageToken;
  }
  return out;
}

export function uaeSearches(uae = {}) {
  return (uae.terms || []).flatMap((t) => (uae.locations || ['Dubai']).map((l) => ({ name: `workable?q=${t}@${l}`, fn: () => workableSearch(t, l) })));
}

export async function keywordSearches(terms = []) {
  const tasks = terms.flatMap((t) => [
    { name: `himalayas?q=${t}`, fn: () => himalayasSearch(t) },
    ...(/^[a-z0-9-]+$/.test(t) ? [{ name: `remoteok?tag=${t}`, fn: () => remoteokTag(t) }] : []),
  ]);
  return tasks;
}

export const BOARD_FETCHERS = { greenhouse: greenhouseBoard, lever: leverBoard, ashby: ashbyBoard };

export const AGGREGATORS = { remoteok, remotive, himalayas, jobicy, arbeitnow, weworkremotely, workingnomads, hackernews };

export async function fetchAll(companies = {}, searchTerms = [], uae = {}) {
  const tasks = [
    ...Object.entries(AGGREGATORS).map(([name, fn]) => ({ name, fn })),
    ...(await keywordSearches(searchTerms)),
    ...uaeSearches(uae),
    ...(uae.indeed ? [{ name: 'indeed-uae', fn: () => import('./indeed.js').then((m) => m.indeedSearch(uae.terms)) }] : []),
    ...Object.entries(companies).flatMap(([ats, slugs]) =>
      (slugs || []).map((s) => ({ name: `${ats}:${s}`, fn: () => BOARD_FETCHERS[ats](s) }))
    ),
  ];
  const stats = {};
  const results = await pool(tasks, 8, async (t) => {
    try {
      const jobs = await t.fn();
      stats[t.name] = jobs.length;
      return jobs;
    } catch (err) {
      stats[t.name] = `ERR ${err.message.slice(0, 80)}`;
      log(`source ${t.name} failed: ${err.message.slice(0, 160)}`);
      return [];
    }
  });
  return { jobs: results.flat(), stats };
}
