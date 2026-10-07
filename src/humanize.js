// Keeps generated text reading like a person wrote it.
// 1) sanitize(): strips invisible Unicode (zero-width, bidi, tag, format chars) and exotic
//    whitespace that can mark machine text, and normalises typographic punctuation.
// 2) findTells(): flags the phrases and patterns that make writing read as AI.

const INVISIBLE = /[­͏؜ᅟᅠ឴឵᠋-᠏​-‏‪-‮⁠-⁯ㅤ︀-️﻿ﾠ￹-￻]|\uDB40[\uDC00-\uDDEF]/g;
const ODD_SPACE = /[   -   　]/g;

export function sanitize(text = '') {
  return String(text)
    .replace(INVISIBLE, '')
    .replace(ODD_SPACE, ' ')
    .replace(/[‘’‛′]/g, "'")
    .replace(/[“”‟″]/g, '"')
    .replace(/(\d)\s*[–—]\s*(\d)/g, '$1-$2') // ranges: 33–50 -> 33-50
    .replace(/\s*[—–]\s*/g, ', ') // em/en dash in prose -> comma
    .replace(/…/g, '...')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/ ,/g, ',')
    .replace(/,\s*,/g, ',');
}

export const BANNED = [
  'leverage', 'leveraging', 'spearhead', 'spearheaded', 'passionate', 'excited to', 'thrilled', 'delve', 'seamless', 'seamlessly',
  'robust', 'cutting-edge', 'cutting edge', 'dynamic', 'synergy', 'testament', 'tapestry', 'landscape', "in today's", 'fast-paced',
  'i am writing to', 'i believe', 'unique blend', 'proven track record', 'results-driven', 'hit the ground running', 'game-changer',
  'game changer', 'elevate', 'empower', 'harness', 'unlock', 'journey', 'navigate', 'navigating', 'realm', 'foster', 'moreover',
  'furthermore', 'additionally', 'not only', 'it\'s not just', 'look no further', 'deeply', 'truly', 'invaluable', 'pivotal',
  'meticulous', 'showcase', 'showcasing', 'resonate', 'resonates', 'align perfectly', 'perfect fit', 'ideal candidate', 'dear hiring manager',
  'to whom it may concern', 'eager to', 'keen to contribute', 'wealth of experience', 'go-getter', 'self-starter', 'thought leader',
  'utilize', 'utilizing', 'holistic', 'innovative solutions', 'drive impact', 'cross-functional synergies', 'bandwidth', 'value-add',
];

export function findTells(text = '') {
  const t = String(text).toLowerCase();
  const hits = BANNED.filter((w) => new RegExp(`(^|[^a-z])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z]|$)`).test(t));
  if (/[—]/.test(text)) hits.push('em dash');
  if (/\?\s/.test(text) && /^(what|why|how|ever)\b/im.test(text)) hits.push('rhetorical question');
  return [...new Set(hits)];
}

// Deep-sanitize every string in a tailoring result.
export function sanitizeAll(obj) {
  if (typeof obj === 'string') return sanitize(obj);
  if (Array.isArray(obj)) return obj.map(sanitizeAll);
  if (obj && typeof obj === 'object') return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, sanitizeAll(v)]));
  return obj;
}

export const STYLE_RULES = `Writing style (critical, the text must read as written by a person, not a model):
- Sound like a confident operator typing a direct note: plain words, short and medium sentences mixed, contractions are fine.
- Be concrete: real project names, numbers and tools from the profile. One specific detail beats three adjectives.
- Never use these words or phrases: ${BANNED.join(', ')}.
- No em dashes or en dashes. No lists of three adjectives. No rhetorical questions. No "Not only X but also Y". No "It's not just X, it's Y".
- No flattery of the company. Mention one real detail from the posting and connect it to his work.`;
