'use strict';
const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const SITE_URL = (process.env.SITE_URL || 'https://ladybugcloud.xubi.org').replace(/\/$/, '');
const OPENAI_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_BASE = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
const CHAT_MODEL = process.env.OPENAI_MODEL || 'gpt-4o';
const TTS_MODEL = process.env.OPENAI_TTS_MODEL || 'gpt-4o-mini-tts';
const TTS_VOICE = process.env.OPENAI_TTS_VOICE || 'coral';
const STT_MODEL = process.env.OPENAI_STT_MODEL || 'whisper-1';
const ESCALATION_WEBHOOK = process.env.ESCALATION_WEBHOOK_URL || ''; // Discord/Slack-compatible
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '*').split(',').map((s) => s.trim());
const RATE_PER_MIN = parseInt(process.env.RATE_LIMIT_PER_MIN || '20', 10);

const knowledge = fs.readFileSync(path.join(__dirname, 'knowledge.md'), 'utf8');

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '100kb' }));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// ---- CORS (so the widget can be embedded on ladybugcloud.xubi.org) ----
app.use('/api', (req, res, next) => {
  const origin = req.headers.origin;
  if (origin && (ALLOWED_ORIGINS.includes('*') || ALLOWED_ORIGINS.includes(origin))) {
    res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGINS.includes('*') ? '*' : origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ---- tiny in-memory rate limiter ----
const hits = new Map();
function limiter(req, res, next) {
  const key = req.ip;
  const now = Date.now();
  const arr = (hits.get(key) || []).filter((t) => now - t < 60000);
  if (arr.length >= RATE_PER_MIN) return res.status(429).json({ error: 'Too many requests, slow down a little.' });
  arr.push(now);
  hits.set(key, arr);
  next();
}
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of hits) if (!v.some((t) => now - t < 60000)) hits.delete(k);
}, 60000).unref();

// ---- live data from the real platform (cached 60s) ----
let liveCache = { at: 0, text: '' };
async function liveData() {
  if (Date.now() - liveCache.at < 60000) return liveCache.text;
  let text = '';
  try {
    const [prices, status] = await Promise.all([
      fetch(`${SITE_URL}/api/prices`, { signal: AbortSignal.timeout(4000) }).then((r) => r.json()),
      fetch(`${SITE_URL}/api/status`, { signal: AbortSignal.timeout(4000) }).then((r) => r.json()),
    ]);
    const items = (prices.items || [])
      .map((i) => `- ${i.name}: $${i.usd}${i.days ? ` per ${i.days} days` : ''} (ZiG ${i.zig})${i.coins ? ` = ${i.coins} coins` : ''}`)
      .join('\n');
    const s = status.stats || {};
    text =
      `LIVE DATA (fetched ${new Date().toISOString()}):\n` +
      `Exchange rate: ${prices.zigPerUsd} ZiG per USD\n${items}\n` +
      `Platform: ${status.ok ? 'ONLINE' : 'DEGRADED'}, bots running ${s.running}/${s.bots}, users ${s.users}`;
  } catch (e) {
    text = 'LIVE DATA: unavailable right now (use the knowledge base and say numbers may have changed).';
  }
  liveCache = { at: Date.now(), text };
  return text;
}

const SYSTEM = (live, voice) => `You are "Ladybug AI", the intelligent assistant of Ntandomods (the brand of Ntando) and the face of Ladybug Cloud (${SITE_URL}), the WhatsApp bot hosting platform that runs the "Ladybug Mini" bot.

WHO YOU ARE
You are a sharp, general-purpose thinking partner AND the dedicated support brain for Ladybug Cloud and Ntandomods. You can help with anything: coding, WhatsApp bots, hosting, business, maths, writing, research, troubleshooting, ideas. But your home turf and your loyalty are Ladybug Cloud, Ladybug Mini and Ntandomods. When a question touches them, the knowledge base and live data below are the source of truth.

HOW YOU THINK
- Reason carefully before answering: understand what the user really needs, consider the likely causes, check facts against the knowledge base and your tools, then give the single best answer or plan. Do not list five options when one is clearly best.
- You have tools: live platform status, live prices, web search, reading web pages, a calculator and the current time. Use them whenever a fact may be fresh, uncertain, or numeric. Do not guess what a tool can verify. Cite the source URL when you used the web.
- For multi-step problems, work out the steps, then present a clean answer with numbered steps.

HONESTY AND LIMITS (important)
- Never invent Ladybug Cloud prices, bank details, policies, features, or facts about Ntando or Ntandomods that are not in the knowledge base. If unsure, say so and point to Contact admin at ${SITE_URL}/#/support (login needed).
- You CANNOT see or change any user's private account, coins, bots, sessions or payments, and you cannot approve payments or refunds. Say so plainly and explain what the user can do in the dashboard.
- Never ask for or accept passwords, full session IDs ("Ladybug!..."), or card numbers. If someone pastes one, tell them to keep it private.
- Do not help with spamming, ban evasion, account takeover, or harming others. Keep WhatsApp rules in mind.
- Never promise refunds, approvals, or response times.

STYLE
- Warm, confident, concise. Reply in the user's language. Use the user's own situation (20 coins per day, 140 coin cap, 7 day trial) in examples.
${voice ? '- This is a VOICE CALL. Speak naturally in 1 to 4 short sentences. No markdown, no lists, no URLs read out letter by letter, no emoji. Offer to continue.' : '- Light markdown is fine. Keep answers focused; go longer only when the problem needs it.'}

${live}

KNOWLEDGE BASE:
${knowledge}`;

// ---- offline fallback when no API key is configured ----
function fallbackAnswer(q) {
  const words = q.toLowerCase().split(/\W+/).filter((w) => w.length > 3);
  const sections = knowledge.split(/\n(?=## )/);
  let best = null, score = 0;
  for (const s of sections) {
    const low = s.toLowerCase();
    const sc = words.reduce((a, w) => a + (low.includes(w) ? 1 : 0), 0);
    if (sc > score) { score = sc; best = s; }
  }
  if (!best) return `I'm in basic mode right now. Please contact the admin at ${SITE_URL}/#/support.`;
  return best.replace(/^## /, '').trim().slice(0, 900);
}

// ---------------- tools: gives the assistant real "access" ----------------
const net = require('net');
const dns = require('dns').promises;
async function safeUrl(u) {
  const url = new URL(u);
  if (!/^https?:$/.test(url.protocol)) throw new Error('only http(s) allowed');
  const addrs = await dns.lookup(url.hostname, { all: true });
  for (const { address } of addrs) {
    if (net.isIP(address) === 4) {
      const [a, b] = address.split('.').map(Number);
      if (a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224) throw new Error('blocked address');
    } else if (/^(::1|fc|fd|fe80)/i.test(address)) throw new Error('blocked address');
  }
  return url.toString();
}
function htmlToText(html) {
  return html.replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ').trim();
}
const TOOLS = [
  { name: 'platform_status', description: 'Live Ladybug Cloud status: platform online, bots running, user count, uptime.', parameters: { type: 'object', properties: {} } },
  { name: 'platform_prices', description: 'Live Ladybug Cloud prices in USD and ZiG and the exchange rate.', parameters: { type: 'object', properties: {} } },
  { name: 'web_search', description: 'Search the web for current information. Returns titles, URLs and snippets.', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
  { name: 'read_url', description: 'Fetch a public web page and return its readable text (first ~6000 chars).', parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } },
  { name: 'calculate', description: 'Evaluate a maths expression with + - * / ^ ( ) and numbers, e.g. coin or price arithmetic.', parameters: { type: 'object', properties: { expression: { type: 'string' } }, required: ['expression'] } },
  { name: 'current_time', description: 'Current date and time in UTC and Africa/Harare.', parameters: { type: 'object', properties: {} } },
].map((f) => ({ type: 'function', function: f }));

async function runTool(name, args) {
  try {
    if (name === 'platform_status') return JSON.stringify(await (await fetch(`${SITE_URL}/api/status`, { signal: AbortSignal.timeout(6000) })).json()).slice(0, 3000);
    if (name === 'platform_prices') return JSON.stringify(await (await fetch(`${SITE_URL}/api/prices`, { signal: AbortSignal.timeout(6000) })).json());
    if (name === 'current_time') { const d = new Date(); return `UTC ${d.toISOString()} | Harare ${d.toLocaleString('en-GB', { timeZone: 'Africa/Harare' })}`; }
    if (name === 'calculate') {
      const e = String(args.expression || '').replace(/\^/g, '**');
      if (!/^[0-9+\-*/().,%\s*]+$/.test(e) || e.length > 200) return 'invalid expression';
      return String(Function(`"use strict";return (${e.replace(/,/g, '')})`)());
    }
    if (name === 'web_search') {
      const r = await fetch('https://html.duckduckgo.com/html/?q=' + encodeURIComponent(args.query), { headers: { 'User-Agent': 'Mozilla/5.0 LadybugAI' }, signal: AbortSignal.timeout(10000) });
      const html = await r.text();
      const out = [];
      const re = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
      let m;
      while ((m = re.exec(html)) && out.length < 6) {
        let href = m[1]; const u = /uddg=([^&]+)/.exec(href); if (u) href = decodeURIComponent(u[1]);
        out.push(`${htmlToText(m[2])}\n${href}\n${htmlToText(m[3])}`);
      }
      return out.length ? out.join('\n\n') : 'no results (search may be rate limited)';
    }
    if (name === 'read_url') {
      const url = await safeUrl(String(args.url || ''));
      const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 LadybugAI' }, redirect: 'follow', signal: AbortSignal.timeout(10000) });
      const t = await r.text();
      return htmlToText(t).slice(0, 6000) || 'empty page';
    }
  } catch (e) { return 'tool error: ' + e.message; }
  return 'unknown tool';
}

const REASONING = /^(o\d|gpt-5)/.test(CHAT_MODEL);
async function chat(messages, voice) {
  const live = await liveData();
  const last = [...messages].reverse().find((m) => m.role === 'user');
  if (!OPENAI_KEY) return fallbackAnswer(last ? last.content : '');
  const convo = [{ role: REASONING ? 'developer' : 'system', content: SYSTEM(live, voice) }, ...messages];
  for (let step = 0; step < 5; step++) {
    const body = { model: CHAT_MODEL, messages: convo, tools: TOOLS };
    if (REASONING) { body.max_completion_tokens = voice ? 2500 : 6000; body.reasoning_effort = voice ? 'low' : 'medium'; }
    else { body.temperature = 0.4; body.max_tokens = voice ? 300 : 1200; }
    if (step === 4) body.tool_choice = 'none';
    const r = await fetch(`${OPENAI_BASE}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPENAI_KEY}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60000),
    });
    if (!r.ok) throw new Error(`LLM error ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const msg = (await r.json()).choices?.[0]?.message;
    if (!msg) throw new Error('empty LLM response');
    if (!msg.tool_calls || !msg.tool_calls.length) return (msg.content || '').trim();
    convo.push(msg);
    for (const tc of msg.tool_calls) {
      let args = {}; try { args = JSON.parse(tc.function.arguments || '{}'); } catch (e) {}
      convo.push({ role: 'tool', tool_call_id: tc.id, content: String(await runTool(tc.function.name, args)).slice(0, 7000) });
    }
  }
  return 'Sorry, I could not finish that. Please try again.';
}

function cleanMessages(arr) {
  if (!Array.isArray(arr)) return [];
  return arr
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .slice(-16)
    .map((m) => ({ role: m.role, content: m.content.slice(0, 2000) }));
}

app.post('/api/chat', limiter, async (req, res) => {
  try {
    const messages = cleanMessages(req.body.messages);
    if (!messages.length) return res.status(400).json({ error: 'No messages' });
    const reply = await chat(messages, !!req.body.voice);
    res.json({ reply, mode: OPENAI_KEY ? 'ai' : 'basic' });
  } catch (e) {
    console.error(e.message);
    res.status(502).json({ error: 'The assistant is unavailable right now. Please try again or contact the admin.' });
  }
});

// Text-to-speech (OpenAI). Browser falls back to speechSynthesis when this 404s.
app.post('/api/tts', limiter, async (req, res) => {
  if (!OPENAI_KEY) return res.status(404).json({ error: 'tts disabled' });
  const text = String(req.body.text || '').slice(0, 1200);
  if (!text) return res.status(400).json({ error: 'No text' });
  try {
    const r = await fetch(`${OPENAI_BASE}/audio/speech`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPENAI_KEY}` },
      body: JSON.stringify({ model: TTS_MODEL, voice: TTS_VOICE, input: text, response_format: 'mp3' }),
      signal: AbortSignal.timeout(30000),
    });
    if (!r.ok) return res.status(502).json({ error: 'tts failed' });
    res.setHeader('Content-Type', 'audio/mpeg');
    res.send(Buffer.from(await r.arrayBuffer()));
  } catch (e) {
    res.status(502).json({ error: 'tts failed' });
  }
});

// Speech-to-text (OpenAI) for browsers without built-in recognition (e.g. Firefox)
app.post('/api/stt', limiter, upload.single('audio'), async (req, res) => {
  if (!OPENAI_KEY) return res.status(404).json({ error: 'stt disabled' });
  if (!req.file) return res.status(400).json({ error: 'No audio' });
  try {
    const form = new FormData();
    form.append('model', STT_MODEL);
    form.append('file', new Blob([req.file.buffer], { type: req.file.mimetype || 'audio/webm' }), req.file.originalname || 'audio.webm');
    const r = await fetch(`${OPENAI_BASE}/audio/transcriptions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${OPENAI_KEY}` },
      body: form,
      signal: AbortSignal.timeout(30000),
    });
    if (!r.ok) return res.status(502).json({ error: 'stt failed' });
    const j = await r.json();
    res.json({ text: (j.text || '').trim() });
  } catch (e) {
    res.status(502).json({ error: 'stt failed' });
  }
});

// Optional: send a conversation summary to the admin via webhook (Discord/Slack)
app.post('/api/escalate', limiter, async (req, res) => {
  const note = String(req.body.note || '').slice(0, 500);
  const contact = String(req.body.contact || '').slice(0, 120);
  const transcript = cleanMessages(req.body.messages).map((m) => `${m.role}: ${m.content}`).join('\n').slice(-1500);
  if (!ESCALATION_WEBHOOK) return res.json({ ok: false, hint: `${SITE_URL}/#/support` });
  try {
    const content = `**Support escalation**\nContact: ${contact || 'n/a'}\nNote: ${note || 'n/a'}\n\`\`\`\n${transcript}\n\`\`\``.slice(0, 1900);
    await fetch(ESCALATION_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content, text: content }),
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(502).json({ ok: false });
  }
});

app.get('/api/config', (req, res) =>
  res.json({ ai: !!OPENAI_KEY, tts: !!OPENAI_KEY, stt: !!OPENAI_KEY, site: SITE_URL, escalation: !!ESCALATION_WEBHOOK })
);
app.get('/healthz', (req, res) => res.send('ok'));

app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

app.listen(PORT, () => console.log(`Ladybug support AI listening on :${PORT} (ai=${!!OPENAI_KEY})`));
