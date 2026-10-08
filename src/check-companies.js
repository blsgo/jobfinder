// Probes candidate company slugs on the common ATS public APIs and MERGES the ones with live
// boards into config.json -> companies (existing entries are kept).
// Run: npm run check-companies
import path from 'node:path';
import { fetchJson, pool, readJson, writeJson, ROOT, log } from './util.js';

// Global AI / creative / remote-first employers
const GLOBAL = [
  'anthropic', 'openai', 'elevenlabs', 'cursor', 'replit', 'n8n', 'zapier', 'make', 'claylabs', 'lovable', 'perplexity',
  'modal', 'langchain', 'cohere', 'mistral', 'runway', 'synthesia', 'descript', 'gamma', 'krea', 'pika', 'heygen', 'captions',
  'tavus', 'hume', 'character', 'airtable', 'notion', 'coda', 'superhuman', 'granola', 'attio', 'tines', 'vercel', 'netlify',
  'webflow', 'framer', 'figma', 'canva', 'miro', 'pitch', 'tldraw', 'rive', 'spline', 'sanity', 'contentful', 'storyblok',
  'squarespace', 'wix', 'automattic', 'buffer', 'hubspot', 'intercom', 'gitlab', 'doist', 'toggl', 'hotjar', 'typeform',
  'remotecom', 'deel', 'oysterhr', 'jasper', 'writer', 'copyai', 'relevanceai', 'lindy', 'decagon', 'sierra', 'bland', 'vapi',
  'retellai', 'clay', 'instantly', 'apollo', 'smartlead', 'gohighlevel', 'highlevel', 'kajabi', 'circle', 'skool', 'teachable',
  'thinkific', 'podia', 'gumroad', 'beehiiv', 'convertkit', 'kit', 'mailerlite', 'klaviyo', 'omnisend', 'gorgias', 'yotpo',
  'shopify', 'recharge', 'triplewhale', 'northbeam', 'motion', 'foreplay', 'superside', 'designjoy', 'penji', 'manypixels',
  'kittl', 'picsart', 'lightricks', 'veed', 'kapwing', 'opusclip', 'invideo', 'pictory', 'fliki', 'colossyan', 'deepbrain',
];

// UAE / GCC employers that hire digital, AI, ecommerce, marketing, creative and ops leads
const GCC = [
  'careem', 'talabat', 'deliveryhero', 'DeliveryHero', 'noon', 'noonacademy', 'kitopi', 'tabby', 'tamara', 'tamarapay', 'sarwa',
  'stake', 'getstake', 'huspy', 'propertyfinder', 'property-finder', 'PropertyFinder', 'bayut', 'dubizzle', 'dubizzlelabs',
  'dubizzlegroup', 'emiratesnbd', 'wio', 'wiobank', 'mashreq', 'liv', 'zywa', 'ziina', 'hala', 'rain', 'bitoasis', 'nymcard',
  'networkinternational', 'magnati', 'paymob', 'checkout', 'checkoutcom', 'telr', 'payfort', 'anghami', 'calo', 'calo-app',
  'instashop', 'yallamarket', 'swvl', 'fetchr', 'ounass', 'namshi', 'sivvi', 'thegivingmovement', 'chalhoub', 'ChalhoubGroup',
  'majidalfuttaim', 'MajidAlFuttaim', 'alfuttaim', 'landmarkgroup', 'emaar', 'damac', 'aldar', 'nakheel', 'meraas', 'dewa',
  'g42', 'presight', 'core42', 'inception', 'bayanat', 'technologyinnovationinstitute', 'mbzuai', 'hub71', 'area2071',
  'in5', 'dmcc', 'dtec', 'astrolabs', 'flat6labs', 'beco', 'becocapital', 'globalventures', 'shorooq', 'vanguard',
  'eyewa', 'mumzworld', 'Mumzworld', 'shopflo', 'dabdoob', 'justlife', 'servicemarket', 'vavabid', 'pure-harvest', 'pureharvest',
  'tlaboratory', 'smartcrowd', 'stakeapp', 'baraka', 'getbaraka', 'xpence', 'pemo', 'qashio', 'alaan', 'tapcompany', 'tap',
  'tappayments', 'foodics', 'salla', 'zid', 'lucidya', 'mozn', 'lean', 'leantech', 'tamatem', 'jahez', 'nana', 'ninja',
  'sary', 'lucky', 'unifonic', 'Unifonic', 'nuitee', 'wego', 'Wego', 'almosafer', 'seera', 'tajawal', 'rotana', 'mbc',
  'shahid', 'osn', 'starzplay', 'anghamii', 'yango', 'bolt', 'uber', 'hungerstation', 'mrsool', 'keeta', 'deliveroo',
  'vezeeta', 'okadoc', 'aster', 'thumbay', 'nuhealth', 'pfizermena', 'jumeirah', 'Jumeirah', 'emirates', 'flydubai',
  'airarabia', 'etihad', 'dnata', 'transguard', 'aramex', 'Aramex', 'quiqup', 'shipa', 'blinkco', 'brandswayq', 'tbwa',
  'publicisgroupe', 'impact', 'memac', 'leo', 'wundermanthompson', 'vmlyr', 'socialeyes', 'digitas', 'mediacom', 'havas',
  'ogilvy', 'dentsu', 'traffic', 'tribalgroup', 'theagency', 'nopaperforms', 'boutiqaat', 'sharafdg', 'jumbo', 'virginmegastore',
];

const PROBES = {
  greenhouse: async (s) => (await fetchJson(`https://boards-api.greenhouse.io/v1/boards/${s}/jobs`, { timeout: 15000, retries: 0 })).jobs?.length || 0,
  lever: async (s) => (await fetchJson(`https://api.lever.co/v0/postings/${s}?mode=json&limit=500`, { timeout: 15000, retries: 0 }))?.length || 0,
  ashby: async (s) => (await fetchJson(`https://api.ashbyhq.com/posting-api/job-board/${s}`, { timeout: 15000, retries: 0 })).jobs?.length || 0,
  workable: async (s) => (await fetchJson(`https://apply.workable.com/api/v1/widget/accounts/${s}`, { timeout: 15000, retries: 0 })).jobs?.length || 0,
  smartrecruiters: async (s) => (await fetchJson(`https://api.smartrecruiters.com/v1/companies/${s}/postings?limit=1`, { timeout: 15000, retries: 0 })).totalFound || 0,
  recruitee: async (s) => (await fetchJson(`https://${s}.recruitee.com/api/offers`, { timeout: 15000, retries: 0 })).offers?.length || 0,
  breezy: async (s) => { const d = await fetchJson(`https://${s}.breezy.hr/json`, { timeout: 15000, retries: 0 }); return Array.isArray(d) ? d.length : 0; },
};

const cfgPath = path.join(ROOT, 'config.json');
const cfg = readJson(cfgPath, {});
const found = Object.fromEntries(Object.keys(PROBES).map((k) => [k, new Set(cfg.companies?.[k] || [])]));
const before = Object.values(found).reduce((n, s) => n + s.size, 0);
const names = [...new Set([...GLOBAL, ...GCC])];

await pool(names, 12, async (s) => {
  for (const [ats, probe] of Object.entries(PROBES)) {
    if (found[ats].has(s)) continue;
    // SmartRecruiters ids are case-sensitive company names; skip lowercase-only probes there for speed
    if (ats === 'smartrecruiters' && s === s.toLowerCase() && !GCC.includes(s)) continue;
    try {
      const n = await probe(s);
      if (n > 0) { found[ats].add(s); console.log(`${ats.padEnd(16)} ${s.padEnd(24)} ${n} jobs`); }
    } catch {}
  }
});

cfg.companies = Object.fromEntries(Object.entries(found).map(([k, v]) => [k, [...v].sort()]));
writeJson(cfgPath, cfg);
const after = Object.values(found).reduce((n, s) => n + s.size, 0);
log(`check-companies: ${after} boards (${after - before} new) ${JSON.stringify(Object.fromEntries(Object.entries(cfg.companies).map(([k, v]) => [k, v.length])))}`);
