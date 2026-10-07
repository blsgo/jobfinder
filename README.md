# Job Finder

An autonomous job-search agent. Every morning it finds new roles, decides which ones are worth applying to, writes a tailored CV and cover letter for each, and submits the applications. It leaves you a short list of the ones that need a human.

Built by [Bashar Mokdad](https://webtactics.org) as an AI-automation system: Node.js orchestration, Claude for judgement and writing, Playwright for the browser work.

## What it does

```
 Hunt ─────────► Score ─────────► Tailor ─────────► Apply ─────────► Dashboard
 ~13k jobs/day   rules: role,     Claude judges     fills the form,   applied / needs you /
 from 11 feeds,  location, pay,   real fit, writes  uploads CV + PDF  queued, with every
 115 ATS boards, freshness        CV + letter PDFs  letter, answers   CV and letter
 Workable, Indeed                  in a human voice  questions, submits
```

- **Hunt.** Pulls RemoteOK, Remotive, Himalayas, Jobicy, We Work Remotely, Working Nomads, Arbeitnow and Hacker News "Who is hiring", plus targeted keyword searches. It also reads the public Greenhouse, Lever and Ashby boards of 115 companies (OpenAI, Anthropic, Vercel, n8n, ElevenLabs, Careem and others), and Workable and Indeed searches for UAE roles.
- **Score.** A fast rules pass drops roles you can't take (wrong region, under the pay floor, stale, off-target titles) and ranks the rest by role family, pay, skills overlap and freshness.
- **Tailor.** Claude reads each shortlisted posting against your profile. It returns a fit score and verdict, and writes a CV, cover letter, "why us" answer and short pitch. It may only use facts from your profile.
- **Humanize.** Hidden Unicode characters are stripped and phrases that make writing read as AI are banned. Anything that slips through gets one rewrite pass.
- **Apply.** An off-screen Edge window fills the form and attaches the CV and cover letter. Claude answers the remaining questions from your facts, then the form is submitted and the confirmation page is checked.
- **Hand-off.** Some jobs can't be finished honestly: a CAPTCHA, a login wall, or a question like visa status that isn't in your profile. Those go to a "Needs you" list instead of being guessed.

## Setup

```bash
npm install
cp profile/profile.example.json profile/profile.json   # then fill in your real facts
npm run check-companies                                  # finds which companies have live boards
npm run daily                                            # hunt + tailor + apply
npm run dashboard                                        # http://127.0.0.1:4545
```

Requirements: Node 20+, Microsoft Edge, and the [Claude Code](https://claude.com/claude-code) CLI signed in. Tailoring runs through the CLI, so no API key is needed. On Windows, `setup-autopilot.ps1` schedules the daily run.

## Configure

All targeting lives in `config.json`:

- `roles`: title families with weights, including families limited to the UAE
- `searchTerms`, `uaeSearch`: what to search for
- `salaryFloorUSD`, `maxAgeDays`
- location allow and deny lists
- `autoApply`: on/off, `submit` (false = dry run), per-day and per-company caps, minimum fit, delays

## Guardrails

- It never invents experience. Prompts restrict the model to the facts in `profile.json`.
- It never guesses eligibility. Visa, sponsorship and relocation answers come only from the profile, otherwise the job goes to "Needs you".
- It never solves CAPTCHAs or creates accounts. Those jobs are handed back to you.
- It applies at most two jobs per company per day, with random delays, so it doesn't spam employers.

## Project layout

```
src/sources.js     job feeds, ATS boards, Workable        src/score.js      rules scoring
src/indeed.js      Indeed via Claude connector             src/tailor.js     fit + CV/letter writing
src/humanize.js    unicode cleanup + style guard           src/render.js     branded PDF CV / letter
src/apply.js       form filler + manual review window      src/autopilot.js  unattended apply loop
src/hunt.js        fetch, dedupe, score, merge             src/server.js     dashboard API
```
