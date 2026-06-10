// ============================================================
// Pursuit API — Cloudflare Pages Function (catch-all router)
// File: functions/api/[[path]].js
// Bindings required: DB (D1), ANTHROPIC_KEY, SESSION_SECRET (env)
// ============================================================

const MODEL_SMART = 'claude-sonnet-4-6';   // quality work: search, tailor, outreach, chat, CV extraction
const MODEL_FAST  = 'claude-haiku-4-5';    // cheap work: intake questions, JD analysis

// Daily per-user AI budget, in weighted units (resets at midnight UTC)
const DAILY_UNITS = 300;
const COST = { search: 10, extract: 5, tailor: 3, cover: 3, prep: 3, outreach: 2, followup: 2, analyze: 2, chat: 1, intake: 1 };

const STAGES = ['discovered', 'preparing', 'applied', 'interview', 'offer'];

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// ---------------- entry ----------------

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const seg = url.pathname.replace(/^\/api\/?/, '').split('/').filter(Boolean);
  const method = request.method;

  try {
    if (!env.DB) throw new HttpError(500, 'Database not bound. Add the D1 binding named DB in Cloudflare Pages settings.');
    if (!env.SESSION_SECRET) throw new HttpError(500, 'SESSION_SECRET environment variable is not set.');

    // ---- public auth routes ----
    if (seg[0] === 'auth' && method === 'POST') {
      const body = await readJSON(request);
      if (seg[1] === 'signup') return await signup(env, body);
      if (seg[1] === 'login')  return await login(env, body);
    }

    // ---- everything below requires a signed-in user ----
    const user = await requireUser(request, env);

    if (seg[0] === 'me') {
      if (method === 'GET') return json(safeUser(user));
      if (method === 'PUT') return await updateMe(env, user, await readJSON(request));
    }

    if (seg[0] === 'cv' && method === 'POST')
      return await extractCV(env, user, await readJSON(request));

    if (seg[0] === 'intake' && method === 'POST')
      return await intakeQuestions(env, user);

    if (seg[0] === 'jobs') {
      if (seg.length === 1 && method === 'GET')  return await listJobs(env, user);
      if (seg[1] === 'search' && method === 'POST') return await searchJobs(env, user, await readJSON(request));
      if (seg[1] === 'analyze' && method === 'POST') return await analyzeJob(env, user, await readJSON(request));
      // /jobs/:id...
      const jobId = seg[1];
      if (seg.length === 2 && method === 'PUT')    return await updateJob(env, user, jobId, await readJSON(request));
      if (seg.length === 2 && method === 'DELETE') return await deleteJob(env, user, jobId);
      if (seg[2] === 'tailor' && method === 'POST')   return await tailor(env, user, await readJSON(request), jobId);
      if (seg[2] === 'outreach' && method === 'POST') return await outreach(env, user, await readJSON(request), jobId);
      if (seg[2] === 'cover' && method === 'POST')    return await coverLetter(env, user, jobId);
      if (seg[2] === 'followup' && method === 'POST') return await followUp(env, user, jobId);
      if (seg[2] === 'prep' && method === 'POST')     return await interviewPrep(env, user, jobId);
    }

    if (seg[0] === 'tailor' && method === 'POST')
      return await tailor(env, user, await readJSON(request), null);

    if (seg[0] === 'outreach' && method === 'POST')
      return await outreach(env, user, await readJSON(request), null);

    if (seg[0] === 'chat') {
      if (method === 'GET')    return await chatHistory(env, user);
      if (method === 'POST')   return await chat(env, user, await readJSON(request));
      if (method === 'DELETE') return await chatClear(env, user);
    }

    throw new HttpError(404, 'Not found');
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    return json({ error: e.message || 'Server error' }, status);
  }
}

// ---------------- auth ----------------

async function signup(env, body) {
  const name = String(body.name || '').trim();
  const email = String(body.email || '').trim().toLowerCase();
  const pin = String(body.pin || '').trim();

  if (name.length < 1 || name.length > 60) throw new HttpError(400, 'Enter your name (up to 60 characters).');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, 'Enter a valid email address.');
  if (!/^\d{4}$/.test(pin)) throw new HttpError(400, 'PIN must be exactly 4 digits.');

  const existing = await env.DB.prepare('SELECT id FROM users WHERE email=?').bind(email).first();
  if (existing) throw new HttpError(409, 'An account with this email already exists. Sign in instead.');

  const id = crypto.randomUUID();
  const salt = crypto.randomUUID();
  const pin_hash = await hashPin(pin, salt);

  await env.DB.prepare(
    'INSERT INTO users (id, email, name, pin_hash, salt, created_at) VALUES (?,?,?,?,?,?)'
  ).bind(id, email, name, pin_hash, salt, Date.now()).run();

  const user = await env.DB.prepare('SELECT * FROM users WHERE id=?').bind(id).first();
  const token = await makeToken(id, env);
  return json({ token, user: safeUser(user) });
}

async function login(env, body) {
  const email = String(body.email || '').trim().toLowerCase();
  const pin = String(body.pin || '').trim();

  const user = await env.DB.prepare('SELECT * FROM users WHERE email=?').bind(email).first();
  if (!user) throw new HttpError(401, 'No account found with this email.');

  if (user.locked_until && Date.now() < user.locked_until) {
    const mins = Math.ceil((user.locked_until - Date.now()) / 60000);
    throw new HttpError(429, `Too many wrong attempts. Try again in ${mins} min.`);
  }

  const hash = await hashPin(pin, user.salt);
  if (hash !== user.pin_hash) {
    const fails = (user.failed_attempts || 0) + 1;
    const lock = fails >= 5 ? Date.now() + 15 * 60 * 1000 : 0;
    await env.DB.prepare('UPDATE users SET failed_attempts=?, locked_until=? WHERE id=?')
      .bind(fails >= 5 ? 0 : fails, lock, user.id).run();
    throw new HttpError(401, lock ? 'Wrong PIN. Account locked for 15 minutes.' : 'Wrong PIN.');
  }

  await env.DB.prepare('UPDATE users SET failed_attempts=0, locked_until=0 WHERE id=?').bind(user.id).run();
  const token = await makeToken(user.id, env);
  return json({ token, user: safeUser(user) });
}

async function requireUser(request, env) {
  const auth = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  const parts = auth.split('.');
  if (parts.length !== 3) throw new HttpError(401, 'Sign in to continue.');
  const [id, exp, sig] = parts;
  if (!id || !exp || Date.now() > Number(exp)) throw new HttpError(401, 'Session expired. Sign in again.');
  const expected = await hmacHex(`${id}.${exp}`, env.SESSION_SECRET);
  if (!timingSafeEqual(sig, expected)) throw new HttpError(401, 'Invalid session. Sign in again.');
  const user = await env.DB.prepare('SELECT * FROM users WHERE id=?').bind(id).first();
  if (!user) throw new HttpError(401, 'Account not found. Sign in again.');
  return user;
}

async function makeToken(id, env) {
  const exp = Date.now() + 30 * 24 * 3600 * 1000; // 30 days
  const sig = await hmacHex(`${id}.${exp}`, env.SESSION_SECRET);
  return `${id}.${exp}.${sig}`;
}

async function hashPin(pin, salt) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(pin), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: enc.encode(salt), iterations: 100000, hash: 'SHA-256' }, key, 256
  );
  return hex(bits);
}

async function hmacHex(payload, secret) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(payload));
  return hex(sig);
}

function hex(buf) {
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

function safeUser(u) {
  const today = new Date().toISOString().slice(0, 10);
  return {
    id: u.id, name: u.name, email: u.email,
    cv_json: u.cv_json || null,
    prefs: u.prefs ? JSON.parse(u.prefs) : null,
    intake: u.intake ? JSON.parse(u.intake) : null,
    onboarded: Boolean(u.cv_json && u.prefs),
    usage: { used: u.req_date === today ? (u.req_count || 0) : 0, limit: DAILY_UNITS },
    created_at: u.created_at
  };
}

// ---------------- account data ----------------

async function updateMe(env, user, body) {
  const sets = [];
  const vals = [];
  if (body.prefs !== undefined) { sets.push('prefs=?'); vals.push(JSON.stringify(body.prefs)); }
  if (body.intake !== undefined) { sets.push('intake=?'); vals.push(JSON.stringify(body.intake)); }
  if (body.name !== undefined) {
    const n = String(body.name).trim();
    if (n.length < 1 || n.length > 60) throw new HttpError(400, 'Name must be 1–60 characters.');
    sets.push('name=?'); vals.push(n);
  }
  if (!sets.length) throw new HttpError(400, 'Nothing to update.');
  vals.push(user.id);
  await env.DB.prepare(`UPDATE users SET ${sets.join(',')} WHERE id=?`).bind(...vals).run();
  const fresh = await env.DB.prepare('SELECT * FROM users WHERE id=?').bind(user.id).first();
  return json(safeUser(fresh));
}

// ---------------- AI plumbing ----------------

async function askClaude(env, { model = MODEL_FAST, system, messages, maxTokens = 2000, tools }) {
  const body = { model, max_tokens: maxTokens, messages };
  if (system) body.system = system;
  if (tools) body.tools = tools;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': env.ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  const data = await res.json();
  if (data.error) throw new HttpError(502, 'AI error: ' + (data.error.message || 'unknown'));
  return (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
}

function parseJSONLoose(text) {
  let t = String(text).replace(/```json|```/gi, '').trim();
  const a = t.indexOf('['), o = t.indexOf('{');
  const start = a === -1 ? o : (o === -1 ? a : Math.min(a, o));
  if (start > 0) t = t.slice(start);
  const end = Math.max(t.lastIndexOf(']'), t.lastIndexOf('}'));
  if (end !== -1) t = t.slice(0, end + 1);
  return JSON.parse(t);
}

function buildSystem(u) {
  const prefs = u.prefs ? JSON.parse(u.prefs) : null;
  const parts = [
    `You are the AI engine inside Pursuit, a personal job-search platform. You work exclusively for ${u.name} (${u.email}).`
  ];
  if (u.cv_json) parts.push('STRUCTURED PROFILE (extracted from their CV):\n' + u.cv_json);
  if (u.cv_raw) parts.push('FULL CV TEXT:\n' + String(u.cv_raw).slice(0, 12000));
  if (prefs) parts.push('JOB PREFERENCES:\n' + JSON.stringify(prefs));
  if (u.intake) parts.push('ADDITIONAL Q&A FROM THE USER:\n' + u.intake);
  parts.push(`RULES:
- Never fabricate experience, employers, metrics, dates, or qualifications that are not in the CV. Rephrasing, reordering, and emphasising real facts is allowed and encouraged.
- Never invent or guess email addresses, phone numbers, or contact details.
- Be specific, concise, and direct. No generic filler.`);
  return parts.join('\n\n');
}

async function spendUnits(env, user, units) {
  const today = new Date().toISOString().slice(0, 10);
  const used = user.req_date === today ? (user.req_count || 0) : 0;
  if (used + units > DAILY_UNITS) {
    throw new HttpError(429, 'Daily AI budget reached for this account. It resets at midnight UTC.');
  }
  await env.DB.prepare('UPDATE users SET req_date=?, req_count=? WHERE id=?')
    .bind(today, used + units, user.id).run();
}

// ---------------- CV extraction ----------------

async function extractCV(env, user, body) {
  await spendUnits(env, user, COST.extract);

  const prompt = `Read this CV and return ONLY a JSON object, no other text, with exactly these keys:
{
 "name": "", "email": "", "phone": "", "location": "", "links": [],
 "headline": "one-line professional identity",
 "summary": "2-3 sentence profile summary",
 "education": [{"institution":"","degree":"","years":"","score":""}],
 "experience": [{"company":"","role":"","dates":"","bullets":[""]}],
 "leadership": [], "skills": [], "achievements": [], "certifications": [],
 "suggested": {"roles": ["3-6 job titles this person should target"], "industries": ["2-5"], "locations": ["from CV if evident"]},
 "raw_text": "full plain-text transcription of the CV"
}
Transcribe faithfully. Do not invent anything not present in the CV.`;

  let content;
  if (body.pdf_base64) {
    content = [
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: body.pdf_base64 } },
      { type: 'text', text: prompt }
    ];
  } else if (body.text && String(body.text).trim().length > 100) {
    content = [{ type: 'text', text: prompt + '\n\nCV TEXT:\n' + String(body.text).slice(0, 30000) }];
  } else {
    throw new HttpError(400, 'Upload a PDF or paste at least a few paragraphs of CV text.');
  }

  const out = await askClaude(env, { model: MODEL_SMART, messages: [{ role: 'user', content }], maxTokens: 8000 });
  let parsed;
  try { parsed = parseJSONLoose(out); }
  catch { throw new HttpError(502, 'Could not read that CV. Try a cleaner PDF or paste the text.'); }

  const raw = parsed.raw_text || '';
  delete parsed.raw_text;

  await env.DB.prepare('UPDATE users SET cv_raw=?, cv_json=? WHERE id=?')
    .bind(raw, JSON.stringify(parsed), user.id).run();

  return json({ cv: parsed });
}

// ---------------- adaptive intake ----------------

async function intakeQuestions(env, user) {
  await spendUnits(env, user, COST.intake);
  const fresh = await env.DB.prepare('SELECT * FROM users WHERE id=?').bind(user.id).first();
  const out = await askClaude(env, {
    model: MODEL_FAST,
    system: buildSystem(fresh),
    messages: [{
      role: 'user',
      content: `Generate exactly 4 short, specific questions that would most improve job matching, CV tailoring, and outreach for this person — beyond what the CV and stated preferences already cover. Examples of useful angles: portfolio/work samples, notice period nuances, relocation constraints, dream companies, dealbreakers, visa/work-authorization, story behind a career gap. Skip anything already answered. Return ONLY a JSON array of question strings.`
    }],
    maxTokens: 800
  });
  let questions;
  try { questions = parseJSONLoose(out); } catch { questions = []; }
  if (!Array.isArray(questions)) questions = [];
  return json({ questions: questions.slice(0, 6).map(String) });
}

// ---------------- jobs ----------------

async function listJobs(env, user) {
  const rows = await env.DB.prepare('SELECT * FROM jobs WHERE user_id=? ORDER BY created_at DESC')
    .bind(user.id).all();
  return json({ jobs: (rows.results || []).map(jobOut) });
}

function jobOut(j) {
  return { ...j, tags: j.tags ? JSON.parse(j.tags) : [] };
}

async function searchJobs(env, user, body) {
  await spendUnits(env, user, COST.search);
  const fresh = await env.DB.prepare('SELECT * FROM users WHERE id=?').bind(user.id).first();
  const prefs = fresh.prefs ? JSON.parse(fresh.prefs) : {};

  const query = String(body.query || '').trim() ||
    [(prefs.roles || []).slice(0, 3).join(' / '), (prefs.locations || []).slice(0, 3).join(', ')]
      .filter(Boolean).join(' — ') || 'entry level roles matching my profile';

  const out = await askClaude(env, {
    model: MODEL_SMART,
    system: buildSystem(fresh),
    tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }],
    maxTokens: 4096,
    messages: [{
      role: 'user',
      content: `Use web search to find REAL, currently-open job postings matching: "${query}".
Search job boards and career pages (LinkedIn Jobs, Naukri, Indeed, Wellfound, iimjobs, Instahyre, company career sites). Prefer postings from the last 30 days.

Then return ONLY a JSON array of up to 8 jobs you actually found in the search results. Each object:
{"title":"","company":"","location":"","type":"Full-time/Internship/Contract","url":"real link from search results","source":"site name","summary":"1-2 sentence JD summary","score":0,"reason":"one sentence on fit","tags":["2-3 short strings"]}

Scoring rubric vs this user's profile and preferences: role match 40, location/work-mode 20, seniority fit 20, company/industry fit 20.
Hard rules: never invent listings or URLs — only include jobs present in search results. If fewer than 8 real postings exist, return fewer. If none, return [].`
    }]
  });

  let found;
  try { found = parseJSONLoose(out); } catch { found = []; }
  if (!Array.isArray(found)) found = [];

  const added = [];
  let skipped = 0;
  for (const j of found) {
    const fp = `${j.company || ''}|${j.title || ''}`.toLowerCase().replace(/\s+/g, ' ').trim();
    if (!fp || fp === '|') continue;
    const dupe = await env.DB.prepare('SELECT id FROM jobs WHERE user_id=? AND fingerprint=?')
      .bind(user.id, fp).first();
    if (dupe) { skipped++; continue; }
    const row = {
      id: crypto.randomUUID(), user_id: user.id,
      title: String(j.title || 'Untitled role'), company: String(j.company || 'Unknown'),
      location: String(j.location || ''), type: String(j.type || ''),
      url: String(j.url || ''), source: String(j.source || ''),
      summary: String(j.summary || ''), score: Math.max(0, Math.min(100, Number(j.score) || 0)),
      reason: String(j.reason || ''), tags: JSON.stringify((j.tags || []).slice(0, 4).map(String)),
      stage: 'discovered', fingerprint: fp, created_at: Date.now(), updated_at: Date.now()
    };
    await env.DB.prepare(
      `INSERT INTO jobs (id,user_id,title,company,location,type,url,source,summary,score,reason,tags,stage,fingerprint,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(row.id, row.user_id, row.title, row.company, row.location, row.type, row.url, row.source,
      row.summary, row.score, row.reason, row.tags, row.stage, row.fingerprint, row.created_at, row.updated_at).run();
    added.push(jobOut(row));
  }

  return json({ added, skipped, query });
}

async function analyzeJob(env, user, body) {
  await spendUnits(env, user, COST.analyze);
  const fresh = await env.DB.prepare('SELECT * FROM users WHERE id=?').bind(user.id).first();

  let jd = String(body.jd || '').trim();
  const srcUrl = String(body.url || '').trim();

  if (!jd && srcUrl) {
    try {
      const r = await fetch(srcUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36' }
      });
      const html = await r.text();
      jd = html
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .slice(0, 20000);
    } catch { /* fall through */ }
  }

  if (!jd || jd.length < 300) {
    throw new HttpError(422, "Couldn't read that page — many job sites block robots. Paste the job description text instead.");
  }

  const out = await askClaude(env, {
    model: MODEL_FAST,
    system: buildSystem(fresh),
    maxTokens: 1500,
    messages: [{
      role: 'user',
      content: `From this job description, return ONLY a JSON object:
{"title":"","company":"","location":"","type":"","summary":"1-2 sentences","score":0,"reason":"one sentence on fit vs my profile","tags":["2-3 short strings"],"keyRequirements":["3-5 strings"]}
Score 0-100: role match 40, location 20, seniority fit 20, company/industry fit 20.

JOB DESCRIPTION:
${jd}`
    }]
  });

  let j;
  try { j = parseJSONLoose(out); } catch { throw new HttpError(502, 'Could not parse that job description.'); }

  const fp = `${j.company || ''}|${j.title || ''}`.toLowerCase().replace(/\s+/g, ' ').trim();
  const row = {
    id: crypto.randomUUID(), user_id: user.id,
    title: String(j.title || 'Untitled role'), company: String(j.company || 'Unknown'),
    location: String(j.location || ''), type: String(j.type || ''),
    url: srcUrl, source: (() => { try { return srcUrl ? new URL(srcUrl).hostname.replace('www.', '') : 'pasted JD'; } catch { return 'pasted JD'; } })(),
    summary: String(j.summary || ''), jd: jd.slice(0, 12000),
    score: Math.max(0, Math.min(100, Number(j.score) || 0)),
    reason: String(j.reason || ''), tags: JSON.stringify((j.tags || []).slice(0, 4).map(String)),
    stage: 'discovered', fingerprint: fp, created_at: Date.now(), updated_at: Date.now()
  };
  await env.DB.prepare(
    `INSERT INTO jobs (id,user_id,title,company,location,type,url,source,summary,jd,score,reason,tags,stage,fingerprint,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(row.id, row.user_id, row.title, row.company, row.location, row.type, row.url, row.source,
    row.summary, row.jd, row.score, row.reason, row.tags, row.stage, row.fingerprint, row.created_at, row.updated_at).run();

  return json({ job: jobOut(row), keyRequirements: j.keyRequirements || [] });
}

async function getOwnJob(env, user, jobId) {
  const job = await env.DB.prepare('SELECT * FROM jobs WHERE id=? AND user_id=?').bind(jobId, user.id).first();
  if (!job) throw new HttpError(404, 'Job not found.');
  return job;
}

async function updateJob(env, user, jobId, body) {
  const job = await getOwnJob(env, user, jobId);
  const sets = [], vals = [];
  if (body.stage !== undefined) {
    if (!STAGES.includes(body.stage)) throw new HttpError(400, 'Invalid stage.');
    sets.push('stage=?'); vals.push(body.stage);
  }
  if (body.notes !== undefined) { sets.push('notes=?'); vals.push(String(body.notes).slice(0, 8000)); }
  if (!sets.length) throw new HttpError(400, 'Nothing to update.');
  sets.push('updated_at=?'); vals.push(Date.now());
  vals.push(job.id);
  await env.DB.prepare(`UPDATE jobs SET ${sets.join(',')} WHERE id=?`).bind(...vals).run();
  const fresh = await env.DB.prepare('SELECT * FROM jobs WHERE id=?').bind(job.id).first();
  return json({ job: jobOut(fresh) });
}

async function deleteJob(env, user, jobId) {
  await getOwnJob(env, user, jobId);
  await env.DB.prepare('DELETE FROM jobs WHERE id=? AND user_id=?').bind(jobId, user.id).run();
  return json({ ok: true });
}

// ---------------- tailoring ----------------

async function tailor(env, user, body, jobId) {
  await spendUnits(env, user, COST.tailor);
  const fresh = await env.DB.prepare('SELECT * FROM users WHERE id=?').bind(user.id).first();

  let job = null;
  if (jobId) job = await getOwnJob(env, user, jobId);

  const jd = String(body.jd || '').trim();
  let task;
  if (job) {
    task = `Tailor my CV for this specific role: ${job.title} at ${job.company} (${job.location}).` +
      (job.summary ? `\nRole summary: ${job.summary}` : '') +
      (job.jd ? `\nFull JD:\n${job.jd.slice(0, 8000)}` : '') +
      (jd ? `\nAdditional JD provided:\n${jd.slice(0, 8000)}` : '');
  } else if (jd) {
    task = `Tailor my CV for this job description:\n${jd.slice(0, 10000)}`;
  } else {
    task = `Produce the strongest general version of my CV for my target roles and preferences.`;
  }

  const out = await askClaude(env, {
    model: MODEL_SMART,
    system: buildSystem(fresh),
    maxTokens: 4000,
    messages: [{
      role: 'user',
      content: `${task}

Requirements:
- Rewrite and reorder bullets to mirror the role's language and priorities. ATS-friendly plain text.
- Keep every fact true to the CV — no invented numbers, employers, or skills.
- Structure: NAME line, contact line, PROFILE, EDUCATION, EXPERIENCE, LEADERSHIP (if relevant), ACHIEVEMENTS, SKILLS, CERTIFICATIONS (if any). Use ALL-CAPS section headers and "-" bullets.
- Return ONLY the full CV text.`
    }]
  });

  if (job) {
    const newStage = job.stage === 'discovered' ? 'preparing' : job.stage;
    await env.DB.prepare('UPDATE jobs SET tailored_cv=?, stage=?, updated_at=? WHERE id=?')
      .bind(out, newStage, Date.now(), job.id).run();
  }
  return json({ cv: out, jobId: job ? job.id : null });
}

// ---------------- outreach ----------------

async function outreach(env, user, body, jobId) {
  await spendUnits(env, user, COST.outreach);
  const fresh = await env.DB.prepare('SELECT * FROM users WHERE id=?').bind(user.id).first();

  let job = null;
  if (jobId) job = await getOwnJob(env, user, jobId);

  const company = job ? job.company : String(body.company || '').trim();
  const role = job ? job.title : String(body.role || '').trim();
  const hrName = String(body.hrName || '').trim();
  if (!company || !role) throw new HttpError(400, 'Company and role are required.');

  const out = await askClaude(env, {
    model: MODEL_SMART,
    system: buildSystem(fresh),
    maxTokens: 1200,
    messages: [{
      role: 'user',
      content: `Write a cold outreach email from me to ${hrName || 'the hiring team'} at ${company} about the ${role} role.${job && job.summary ? ` Role context: ${job.summary}` : ''}

Requirements:
- 130 words max. Genuine and specific, not templated. Reference my 1-2 most relevant experiences for this exact role type.
- Clear ask: a conversation or consideration for the role.
- Do NOT invent any facts about me or about ${company}.
- Format: first line "Subject: ..." then a blank line, then the body, ending with my name.`
    }]
  });

  if (job) {
    const newStage = ['discovered', 'preparing'].includes(job.stage) ? 'preparing' : job.stage;
    await env.DB.prepare('UPDATE jobs SET draft_email=?, stage=?, updated_at=? WHERE id=?')
      .bind(out, newStage, Date.now(), job.id).run();
  }
  return json({ email: out, jobId: job ? job.id : null });
}

// ---------------- advisor chat (persisted) ----------------

async function chatHistory(env, user) {
  const rows = await env.DB.prepare('SELECT role, content FROM chats WHERE user_id=? ORDER BY rowid DESC LIMIT 60')
    .bind(user.id).all();
  return json({ messages: (rows.results || []).reverse() });
}

async function chatClear(env, user) {
  await env.DB.prepare('DELETE FROM chats WHERE user_id=?').bind(user.id).run();
  return json({ ok: true });
}

async function chat(env, user, body) {
  await spendUnits(env, user, COST.chat);
  const fresh = await env.DB.prepare('SELECT * FROM users WHERE id=?').bind(user.id).first();

  const msg = String(body.message || '').trim().slice(0, 8000);
  if (!msg) throw new HttpError(400, 'Empty message.');

  const rows = await env.DB.prepare('SELECT role, content FROM chats WHERE user_id=? ORDER BY rowid DESC LIMIT 28')
    .bind(user.id).all();
  const hist = (rows.results || []).reverse()
    .map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content || '').slice(0, 8000) }))
    .filter(m => m.content);
  while (hist.length && hist[0].role === 'assistant') hist.shift();

  const out = await askClaude(env, {
    model: MODEL_SMART,
    system: buildSystem(fresh) +
      '\n\nROLE: You are also a sharp, honest career strategist. Be direct, push back where needed, no generic advice. Keep answers tight unless asked to go deep.',
    maxTokens: 1600,
    messages: [...hist, { role: 'user', content: msg }]
  });

  const now = Date.now();
  await env.DB.prepare('INSERT INTO chats (id,user_id,role,content,created_at) VALUES (?,?,?,?,?)')
    .bind(crypto.randomUUID(), user.id, 'user', msg, now).run();
  await env.DB.prepare('INSERT INTO chats (id,user_id,role,content,created_at) VALUES (?,?,?,?,?)')
    .bind(crypto.randomUUID(), user.id, 'assistant', out, now + 1).run();

  return json({ text: out });
}

// ---------------- application kit: cover letter, follow-up, interview prep ----------------

async function coverLetter(env, user, jobId) {
  await spendUnits(env, user, COST.cover);
  const fresh = await env.DB.prepare('SELECT * FROM users WHERE id=?').bind(user.id).first();
  const job = await getOwnJob(env, user, jobId);

  const out = await askClaude(env, {
    model: MODEL_SMART,
    system: buildSystem(fresh),
    maxTokens: 1500,
    messages: [{
      role: 'user',
      content: `Write my cover letter for the ${job.title} role at ${job.company}${job.location ? ` (${job.location})` : ''}.${job.summary ? `\nRole context: ${job.summary}` : ''}${job.jd ? `\nFull JD:\n${String(job.jd).slice(0, 8000)}` : ''}

Requirements:
- 220-280 words, plain text. Open with a specific hook about why THIS role/company, not "I am writing to apply".
- Middle: my 2 most relevant real experiences mapped to what the role needs. No invented facts.
- Close with a confident, brief ask.
- Format: "Dear Hiring Team," (or the obvious addressee), body paragraphs, then "Sincerely," and my name. No address headers.
- Return ONLY the letter text.`
    }]
  });

  const newStage = job.stage === 'discovered' ? 'preparing' : job.stage;
  await env.DB.prepare('UPDATE jobs SET cover_letter=?, stage=?, updated_at=? WHERE id=?')
    .bind(out, newStage, Date.now(), job.id).run();
  return json({ cover: out, jobId: job.id });
}

async function followUp(env, user, jobId) {
  await spendUnits(env, user, COST.followup);
  const fresh = await env.DB.prepare('SELECT * FROM users WHERE id=?').bind(user.id).first();
  const job = await getOwnJob(env, user, jobId);
  const days = Math.max(1, Math.round((Date.now() - (job.updated_at || Date.now())) / 86400000));

  const out = await askClaude(env, {
    model: MODEL_SMART,
    system: buildSystem(fresh),
    maxTokens: 700,
    messages: [{
      role: 'user',
      content: `Write a short follow-up email about my application for ${job.title} at ${job.company}, submitted about ${days} day(s) ago.

Requirements:
- Under 90 words. Warm, confident, zero desperation.
- Reaffirm interest with ONE specific, real reason I'm a fit (from my CV). Do not invent facts.
- Soft ask: any update on timeline / happy to share anything further.
- Format: first line "Subject: ..." then a blank line, then the body, ending with my name.
- Return ONLY the email.`
    }]
  });
  return json({ email: out, jobId: job.id });
}

async function interviewPrep(env, user, jobId) {
  await spendUnits(env, user, COST.prep);
  const fresh = await env.DB.prepare('SELECT * FROM users WHERE id=?').bind(user.id).first();
  const job = await getOwnJob(env, user, jobId);

  const out = await askClaude(env, {
    model: MODEL_SMART,
    system: buildSystem(fresh),
    maxTokens: 2500,
    messages: [{
      role: 'user',
      content: `Build my interview prep sheet for ${job.title} at ${job.company}.${job.summary ? `\nRole context: ${job.summary}` : ''}${job.jd ? `\nFull JD:\n${String(job.jd).slice(0, 8000)}` : ''}

Structure (plain text, ALL-CAPS section headers, "-" bullets):
LIKELY QUESTIONS — 6-8 questions this specific interviewer would ask, each followed by an indented "Angle:" line telling me how to answer using MY real experience (name the actual project/role from my CV).
WEAK SPOTS — 2-3 gaps between my CV and this JD, each with how to honestly handle it.
QUESTIONS TO ASK THEM — 4 sharp, role-specific questions that signal depth.
ONE-LINE PITCH — my 25-word answer to "tell me about yourself" for this exact role.

Grounded only in my real CV. Return ONLY the prep sheet.`
    }]
  });

  await env.DB.prepare('UPDATE jobs SET interview_prep=?, updated_at=? WHERE id=?')
    .bind(out, Date.now(), job.id).run();
  return json({ prep: out, jobId: job.id });
}

// ---------------- utils ----------------

async function readJSON(request) {
  try { return await request.json(); }
  catch { throw new HttpError(400, 'Invalid request body.'); }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}
