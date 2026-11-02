'use strict';
const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const SITE_URL = (process.env.SITE_URL || 'https://ladybugcloud.xubi.org').replace(/\/$/, '');
const OPENAI_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_BASE = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
const CHAT_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
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

const SYSTEM = (live, voice) => `You are "Lady", the friendly customer-support assistant for Ladybug Cloud (${SITE_URL}), a WhatsApp bot hosting service by Ntandomods.

Rules:
- Answer ONLY from the knowledge base and live data below. If you do not know, say so and send the user to "Contact admin" at ${SITE_URL}/#/support (login needed). Never invent prices, bank details, dates, or policies.
- Never ask for or accept passwords, full session IDs ("Ladybug!..."), or bank card numbers. If a user pastes one, tell them to keep it private.
- You cannot see or change anyone's account, coins, bots or payments. Say so if asked, and explain what the user can do in the dashboard.
- Be warm, concise and practical. Give numbered steps for how-tos. Reply in the user's language.
- Use the user's own situation (e.g. 20 coins per day, 140 coin cap) in examples.
- Never promise refunds, approvals, or response times.
${voice ? '- This is a VOICE CALL. Speak naturally in 1 to 3 short sentences. No markdown, no lists, no URLs read out letter by letter, no emoji. Offer to continue.' : '- Light markdown is fine. Keep answers under about 150 words unless steps need more.'}

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

async function chat(messages, voice) {
  const live = await liveData();
  const last = [...messages].reverse().find((m) => m.role === 'user');
  if (!OPENAI_KEY) return fallbackAnswer(last ? last.content : '');
  const r = await fetch(`${OPENAI_BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPENAI_KEY}` },
    body: JSON.stringify({
      model: CHAT_MODEL,
      temperature: 0.3,
      max_tokens: voice ? 220 : 600,
      messages: [{ role: 'system', content: SYSTEM(live, voice) }, ...messages],
    }),
    signal: AbortSignal.timeout(30000),
  });
  if (!r.ok) throw new Error(`LLM error ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j = await r.json();
  return (j.choices?.[0]?.message?.content || '').trim();
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
