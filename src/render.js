// Branded, ATS-parseable CV + cover letter -> PDF (real text layer, single column).
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { OUTPUT, profile as loadProfile, log } from './util.js';

const h = (s = '') => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const bare = (u = '') => u.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '');

const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Orbitron:wght@500;700&family=Rajdhani:wght@500;600;700&family=Syncopate:wght@700&display=swap');
@page { size: A4; margin: 0; }
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { background: #fff; }
body { font-family: 'Rajdhani', 'Segoe UI', sans-serif; font-weight: 500; color: #2a2636; font-size: 10.6pt; line-height: 1.42; }
.page { width: 210mm; padding: 15mm 16mm 13mm; }
header { border-bottom: 1px solid rgba(22,18,31,0.12); padding-bottom: 5mm; margin-bottom: 5mm; position: relative; }
header::before { content: ''; position: absolute; left: -16mm; top: -15mm; width: 3.2mm; height: 34mm; background: #7c3aed; }
.name { font-family: 'Syncopate', sans-serif; font-weight: 700; font-size: 21pt; letter-spacing: 0.06em; text-transform: uppercase; color: #16121f; line-height: 1.1; }
.headline { font-weight: 700; font-size: 11.5pt; color: #7c3aed; letter-spacing: 0.12em; text-transform: uppercase; margin-top: 2.2mm; }
.contact { margin-top: 2.6mm; font-size: 9.6pt; color: #5b6478; display: flex; flex-wrap: wrap; gap: 1mm 4.5mm; }
.contact a { color: #5b6478; text-decoration: none; }
h2 { font-family: 'Rajdhani', sans-serif; font-weight: 700; font-size: 9pt; letter-spacing: 0.3em; text-transform: uppercase; color: #7c3aed; margin: 5mm 0 2.2mm; display: flex; align-items: center; gap: 3mm; }
h2::after { content: ''; flex: 1; height: 1px; background: rgba(124,58,237,0.18); }
p.summary { font-size: 10.8pt; color: #2a2636; }
.job { margin-bottom: 3.4mm; break-inside: avoid; }
.job-top { display: flex; justify-content: space-between; align-items: baseline; gap: 4mm; }
.role { font-weight: 700; font-size: 11.2pt; color: #16121f; }
.co { color: #7c3aed; font-weight: 700; }
.when { font-family: 'Orbitron', monospace; font-size: 7.6pt; letter-spacing: 0.08em; color: #5b6478; white-space: nowrap; }
.loc { font-size: 9.4pt; color: #5b6478; }
ul { margin: 1.4mm 0 0 4mm; }
li { margin-bottom: 1mm; padding-left: 1mm; }
li::marker { color: #7c3aed; }
.projects { display: grid; grid-template-columns: 1fr 1fr; gap: 2.4mm 6mm; }
.proj { break-inside: avoid; }
.proj b { color: #16121f; font-weight: 700; }
.proj a { color: #7c3aed; text-decoration: none; font-size: 9pt; }
.proj div { font-size: 9.8pt; color: #3a3546; }
.skills { display: grid; grid-template-columns: 31mm 1fr; gap: 1.3mm 4mm; font-size: 10pt; }
.skills dt { font-weight: 700; color: #16121f; text-transform: uppercase; letter-spacing: 0.08em; font-size: 8.6pt; padding-top: 0.5mm; }
.skills dd { color: #3a3546; }
.two { display: grid; grid-template-columns: 1fr 1fr; gap: 6mm; }
.small { font-size: 10pt; }
.letter { font-size: 11.2pt; line-height: 1.6; color: #2a2636; }
.letter p { margin-bottom: 3.6mm; }
.date { font-family: 'Orbitron', monospace; font-size: 8pt; letter-spacing: 0.1em; color: #5b6478; margin-bottom: 6mm; }
`;

function headerHtml(p, headline) {
  const L = p.links || {};
  const items = [
    p.location, `<a href="mailto:${h(p.email)}">${h(p.email)}</a>`, h(p.phone),
    L.website && `<a href="${h(L.website)}">${bare(L.website)}</a>`,
    L.portfolio && `<a href="${h(L.portfolio)}">${bare(L.portfolio)}</a>`,
    L.linkedin && `<a href="${h(L.linkedin)}">linkedin.com/in/bashar-mokdad</a>`,
    L.github && `<a href="${h(L.github)}">${bare(L.github)}</a>`,
  ].filter(Boolean);
  return `<header><div class="name">${h(p.name)}</div><div class="headline">${h(headline || p.headline)}</div>
  <div class="contact">${items.map((i) => `<span>${i}</span>`).join('')}</div></header>`;
}

export function cvHtml(p, t = {}) {
  const projects = (t.projectIds?.length ? t.projectIds.map((id) => p.projects.find((x) => x.id === id)).filter(Boolean) : p.projects.slice(0, 6)).slice(0, 6);
  const skillCats = t.skillsOrder?.length ? [...t.skillsOrder.filter((c) => p.skills[c]), ...Object.keys(p.skills).filter((c) => !t.skillsOrder.includes(c))] : Object.keys(p.skills);
  const exp = p.experience.map((e, i) => ({ ...e, bullets: i === 0 && t.bullets?.length ? t.bullets : e.bullets }));
  const projDesc = t.projectNotes || {};

  return `<!doctype html><html><head><meta charset="utf-8"><title>${h(p.name)} CV</title><style>${CSS}</style></head><body><div class="page">
  ${headerHtml(p, t.headline)}
  <h2>Profile</h2><p class="summary">${h(t.summary || p.summary)}</p>
  <h2>Experience</h2>
  ${exp.map((e) => `<div class="job"><div class="job-top"><div class="role">${h(e.role)} · <span class="co">${h(e.company)}</span></div><div class="when">${h(e.start)} – ${h(e.end)}</div></div>
    <div class="loc">${h(e.location)}</div><ul>${e.bullets.map((b) => `<li>${h(b)}</li>`).join('')}</ul></div>`).join('')}
  <h2>Selected work</h2>
  <div class="projects">${projects.map((x) => `<div class="proj"><b>${h(x.name)}</b>${x.url ? ` <a href="${h(x.url)}">${bare(x.url)}</a>` : ''}<div>${h(projDesc[x.id] || x.desc)}</div></div>`).join('')}</div>
  <h2>Skills</h2>
  <dl class="skills">${skillCats.map((c) => `<dt>${h(c)}</dt><dd>${h((t.skillHighlights?.length ? [...p.skills[c].filter((s) => t.skillHighlights.includes(s)), ...p.skills[c].filter((s) => !t.skillHighlights.includes(s))] : p.skills[c]).join(' · '))}</dd>`).join('')}</dl>
  <div class="two">
    <div><h2>Education</h2><div class="small">${p.education.map((e) => `<div><b>${h(e.degree)}</b>, ${h(e.school)}${e.location ? `, ${h(e.location)}` : ''}</div>`).join('')}</div></div>
    <div><h2>Languages</h2><div class="small">${h(p.languages.join(' · '))}</div>
    ${p.extras?.length ? `<h2>Also</h2><div class="small">${p.extras.map((x) => `<div>${h(x)}</div>`).join('')}</div>` : ''}</div>
  </div>
  </div></body></html>`;
}

export function letterHtml(p, letter, headline) {
  const date = new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' });
  const paras = String(letter).trim().split(/\n\s*\n/).map((x) => `<p>${h(x).replace(/\n/g, '<br>')}</p>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><title>${h(p.name)} Cover Letter</title><style>${CSS}</style></head><body><div class="page">
  ${headerHtml(p, headline)}<div class="date">${date}</div><div class="letter">${paras}</div></div></body></html>`;
}

let browserPromise;
export function browser() {
  browserPromise ??= chromium.launch({ channel: 'msedge', headless: true }).catch(() => chromium.launch({ channel: 'chrome', headless: true }));
  return browserPromise;
}
export async function closeBrowser() {
  if (browserPromise) (await browserPromise).close().catch(() => {});
  browserPromise = null;
}

export async function htmlToPdf(html, outFile) {
  const b = await browser();
  const page = await b.newPage();
  try {
    await page.setContent(html, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
    await page.evaluate(() => document.fonts.ready);
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    await page.pdf({ path: outFile, format: 'A4', printBackground: true, preferCSSPageSize: true });
    fs.writeFileSync(outFile.replace(/\.pdf$/, '.html'), html);
  } finally {
    await page.close();
  }
  return outFile;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const p = loadProfile();
  const out = path.join(OUTPUT, '_master', `CV - ${p.name}.pdf`);
  await htmlToPdf(cvHtml(p), out);
  await closeBrowser();
  log(`master CV written: ${out}`);
}
