// Probes candidate company slugs on Greenhouse / Lever / Ashby and writes the ones
// that have live boards into config.json -> companies. Run: npm run check-companies
import path from 'node:path';
import { fetchJson, pool, readJson, writeJson, ROOT, log } from './util.js';

const CANDIDATES = [
  // AI / automation
  'anthropic', 'openai', 'elevenlabs', 'cursor', 'anysphere', 'replit', 'n8n', 'zapier', 'make', 'clay', 'claylabs', 'lovable',
  'perplexity', 'perplexityai', 'modal', 'langchain', 'pinecone', 'cohere', 'mistral', 'runwayml', 'runway', 'synthesia',
  'descript', 'gamma', 'krea', 'pika', 'lumalabs', 'relevanceai', 'lindy', 'cognition', 'sierra', 'decagon', 'writer',
  'jasper', 'glean', 'browserbase', 'stackblitz', 'bolt', 'v0', 'huggingface', 'together', 'togetherai', 'fireworksai',
  'baseten', 'deepgram', 'assemblyai', 'heygen', 'captions', 'tavus', 'hume', 'character', 'poolside', 'magic', 'factory',
  'vapi', 'retellai', 'bland', 'airtable', 'notion', 'coda', 'superhuman', 'granola', 'attio', 'tines',
  // design / web / creative tooling
  'vercel', 'netlify', 'webflow', 'framer', 'figma', 'canva', 'miro', 'pitch', 'tldraw', 'rive', 'spline', 'sanity',
  'contentful', 'storyblok', 'builderio', 'squarespace', 'wix', 'shopify', 'automattic', 'wpengine', 'kinsta', '10up',
  'xwp', 'rtcamp', 'humanmade', 'webdevstudios', 'toggl', 'doist', 'hotjar', 'typeform', 'loom', 'calcom', 'cal',
  'resend', 'raycast', 'linear', 'posthog', 'supabase', 'planetscale', 'neon', 'convex', 'clerk', 'warp', 'tailwindlabs',
  // remote-first / well paying
  'gitlab', 'cloudflare', 'stripe', 'dropbox', 'discord', 'reddit', 'duolingo', 'remotecom', 'deel', 'oysterhr',
  'ramp', 'mercury', 'brex', 'elastic', 'mongodb', 'grafanalabs', 'twilio', 'coinbase', 'kraken', 'kraken.com', 'binance',
  'okx', 'consensys', 'chainlink', 'chainlinklabs', 'uniswap', 'phantom', 'alchemy', 'wikimedia', 'mozilla', 'sourcegraph',
  'sourcegraph91', 'canonical', 'datadog', 'hashicorp', 'postman', 'algolia', 'fastly', 'intercom', 'close', 'closeio',
  'zapier', 'buffer', 'hubspot', 'spotify', 'palantir', 'celonis', 'smartling', 'articulate', 'automattic', 'invision',
  'crossover', 'turing', 'ateam', 'toptal', 'proxify', 'arc', 'lemonio', 'andela', 'gun', 'braintrust', 'contra',
  // MENA / Dubai tech
  'careem', 'tabby', 'tamara', 'kitopi', 'talabat', 'deliveryhero', 'property-finder', 'propertyfinder', 'bayut',
  'dubizzle', 'noon', 'anghami', 'sarwa', 'pure-harvest', 'yallacompare', 'emiratesnbd', 'g42', 'presight', 'bitoasis',
  'rain', 'ziina', 'huspy', 'stake', 'hala', 'lean', 'leantechnologies', 'foodics', 'salla', 'zid', 'lucidya',
];

const PROBES = {
  greenhouse: async (s) => (await fetchJson(`https://boards-api.greenhouse.io/v1/boards/${s}/jobs`, { timeout: 20000, retries: 0 })).jobs?.length || 0,
  lever: async (s) => (await fetchJson(`https://api.lever.co/v0/postings/${s}?mode=json&limit=500`, { timeout: 20000, retries: 0 }))?.length || 0,
  ashby: async (s) => (await fetchJson(`https://api.ashbyhq.com/posting-api/job-board/${s}`, { timeout: 20000, retries: 0 })).jobs?.length || 0,
};

const unique = [...new Set(CANDIDATES)];
const found = { greenhouse: [], lever: [], ashby: [] };
await pool(unique, 10, async (s) => {
  for (const [ats, probe] of Object.entries(PROBES)) {
    try {
      const n = await probe(s);
      if (n > 0) {
        found[ats].push(s);
        console.log(`${ats.padEnd(10)} ${s.padEnd(20)} ${n} jobs`);
      }
    } catch {}
  }
});

for (const k of Object.keys(found)) found[k].sort();
const cfgPath = path.join(ROOT, 'config.json');
const cfg = readJson(cfgPath, {});
cfg.companies = found;
writeJson(cfgPath, cfg);
log(`check-companies: greenhouse ${found.greenhouse.length}, lever ${found.lever.length}, ashby ${found.ashby.length}`);
