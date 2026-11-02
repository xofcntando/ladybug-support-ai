'use strict';
const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const SITE_URL = (process.env.SITE_URL || 'https://ladybugcloud.xubi.org').replace(/\/$/, '');
// ---- AI provider: set ONE of these keys on Render and advanced mode switches on ----
const PROVIDERS = [
  { env: 'OPENAI_API_KEY', name: 'openai', base: 'https://api.openai.com/v1', model: 'gpt-4o', stt: 'whisper-1', tts: true },
  { env: 'GROQ_API_KEY', name: 'groq', base: 'https://api.groq.com/openai/v1', model: 'llama-3.3-70b-versatile', stt: 'whisper-large-v3-turbo', tts: false },
  { env: 'GEMINI_API_KEY', name: 'gemini', base: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-2.0-flash', stt: null, tts: false },
  { env: 'OPENROUTER_API_KEY', name: 'openrouter', base: 'https://openrouter.ai/api/v1', model: 'meta-llama/llama-3.3-70b-instruct:free', stt: null, tts: false },
];
const PROVIDER = PROVIDERS.find((p) => (process.env[p.env] || '').trim().length > 10) || null;
const OPENAI_KEY = PROVIDER ? process.env[PROVIDER.env].trim() : '';
const OPENAI_BASE = (process.env.OPENAI_BASE_URL || (PROVIDER && PROVIDER.base) || '').replace(/\/$/, '');
const CHAT_MODEL = process.env.CHAT_MODEL || ((PROVIDER && PROVIDER.name === 'openai') || process.env.OPENAI_BASE_URL ? process.env.OPENAI_MODEL : '') || (PROVIDER && PROVIDER.model) || 'gpt-4o';
const TTS_ENABLED = !!(PROVIDER && PROVIDER.tts);
const STT_MODEL = process.env.OPENAI_STT_MODEL || (PROVIDER && PROVIDER.stt) || '';
const TTS_MODEL = process.env.OPENAI_TTS_MODEL || 'gpt-4o-mini-tts';
const TTS_VOICE = process.env.OPENAI_TTS_VOICE || 'coral';
// Keyless default brain (works with no account). Disable with USE_KNIGHT=false.
const KNIGHT_URL = process.env.KNIGHT_API_URL || 'https://knightbotapi.stream/api/ai/chat';
const KNIGHT_KEY = process.env.KNIGHT_API_KEY || 'knight';
const USE_KNIGHT = !PROVIDER && process.env.USE_KNIGHT !== 'false';
let aiHealthy = !!PROVIDER || USE_KNIGHT;
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

const TONES = {
  friendly: 'warm, upbeat and caring, like a friendly colleague who is glad to help',
  casual: 'relaxed and casual, like a clever mate texting back; light slang is fine, never rude',
  professional: 'polished and professional, courteous but still natural and never stiff',
  playful: 'playful and witty with light humour, but always useful first',
  calm: 'calm, patient and reassuring, especially good with stressed or confused people',
};
const LENGTHS = { short: 'Keep replies very short: usually 1 to 2 sentences.', normal: 'Keep replies compact: a few sentences unless the problem needs more.', detailed: 'Give thorough, well-organised answers when helpful.' };
function cleanStyle(st) {
  st = st && typeof st === 'object' ? st : {};
  return {
    name: String(st.name || 'Ladybug AI').replace(/[^\p{L}\p{N} _.-]/gu, '').slice(0, 24) || 'Ladybug AI',
    tone: TONES[st.tone] ? st.tone : 'friendly',
    length: LENGTHS[st.length] ? st.length : 'normal',
    emoji: !!st.emoji,
  };
}
const SYSTEM = (live, voice, st = cleanStyle(), kb = knowledge) => `You are "${st.name}", the intelligent assistant of Ntandomods, the intelligent assistant of Ntandomods (the brand of Ntando) and the face of Ladybug Cloud (${SITE_URL}), the WhatsApp bot hosting platform that runs the "Ladybug Mini" bot.

WHO YOU ARE
You were built in Zimbabwe by Ntando, a real developer, and you are proud of that. You understand the local context: ZiG and USD, bank transfers, Africa/Harare time, and that many users speak English, Shona or Ndebele (reply in whichever the user uses).
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

HOW YOU TALK (very important)
- Talk like a real person, not a manual. Personality: ${TONES[st.tone]}. ${LENGTHS[st.length]}
- Use contractions ("you're", "it's", "I'll"). Vary your sentences. React first when it fits ("Ah, that's annoying", "Nice, easy fix", "Hmm, let me check"), then help.
- Never open with "Certainly", "Absolutely", "Great question" or "As an AI". Don't repeat the question back. Don't lecture or dump everything you know.
- Ask at most one short follow-up question, and only when you really need it. Remember what was said earlier in the chat and refer back to it naturally.
- If you're unsure, say so the way a person would ("I'm not 100% sure, but..."). If the user is frustrated, acknowledge it briefly first.
- ${st.emoji ? 'An occasional emoji is fine.' : 'Do not use emoji.'}

STYLE
- Confident and concise. Reply in the user's language. Use the user's own situation (20 coins per day, 140 coin cap, 7 day trial) in examples.
${voice ? '- This is a LIVE VOICE CALL, so write exactly what you would say out loud: 1 to 3 short, natural sentences, spoken-style, with the odd "yeah", "okay", "right". No markdown, no lists, no emoji, no URLs read out; say "I will put the link in the chat" instead. Numbers spoken naturally ("twenty coins a day").' : '- Light markdown is fine. Keep answers focused; go longer only when the problem needs it.'}

${live}

KNOWLEDGE BASE:
${kb}`;

// ---- basic mode (no AI key): short, human, spoken-style answers, never a raw document dump ----
const INTENTS = [
  [/^(hi|hey|hello|hie|howzit|sawubona|mhoro|makadii|good (morning|afternoon|evening))\b/i, (n) => `Hey, it's ${n} from Ntandomods. I can help with linking your number, coins, pricing or payments. What do you need?`],
  [/(pair|link|connect|session|code|get started|set ?up|start)/i, () => `Easy. In your dashboard, create a bot, type your number with the country code and tap Get code. Then in WhatsApp open Linked devices, choose Link with phone number, and enter the eight digit code. It only lasts about a minute, so just ask for a new one if it fails.`],
  [/(price|pricing|cost|how much|plan|unlimited|subscribe|subscription|dollar|zig|cheap)/i, () => `You get seven days free. After that, hosting costs twenty coins a day, and you can claim twenty free coins every day. Or Unlimited is three dollars a month, so you never have to claim. Auto-claim is two dollars, and an extra bot slot is one dollar.`],
  [/(coin|claim|balance|paused|pause|ran out|run out)/i, () => `Hosting one bot costs twenty coins a day, and you can claim twenty free coins every twenty four hours from the dashboard. If your balance runs out the bot just pauses, nothing gets deleted. Claim your coins, press Start, and it's back.`],
  [/(pay|payment|bank|nsb|transfer|proof|receipt|paid)/i, () => `You pay by bank transfer in dollars or ZiG. The bank details are on the Pay page once you're logged in. After paying, send your proof through the Pay page or message the admin from your dashboard. The admin confirms it by hand, so it can take a little while.`],
  [/(referral|refer|invite|friend|bonus)/i, () => `Share your referral link from the dashboard. Your friend gets twenty bonus coins when they join, and you get forty once their bot has been online for ten minutes. You can earn up to ten rewards a month.`],
  [/(not respond|no respon|stopped|offline|not working|doesn.t work|silent|crash|restart|logged out|error)/i, () => `Okay, let's check a few things. First, is the bot paused on your dashboard? If so, claim coins and hit Start. If it's running, look at the live logs and make sure you're using the right prefix, which is a dot by default. Also check that the linked device still shows up in WhatsApp. If it's gone, pair again to get a new session.`],
  [/(admin|human|person|contact|support|refund|ban|banned|password|forgot)/i, (n, c) => `For that one you'll need the admin. Log in and open Contact admin on the website, then explain what happened. I can't see or change accounts or approve payments myself.`],
  [/(command|feature|what can|menu|sticker|download|ai\b)/i, () => `Ladybug Mini has owner tools, group admin tools like anti link and welcome messages, downloaders for YouTube, TikTok and more, plus stickers, translate and an AI command. The default prefix is a dot, so dot menu shows everything.`],
];
async function fallbackAnswer(q, name, voice) {
  const c = { site: SITE_URL };
  if (/(status|online|up right now|is the (site|platform))/i.test(q)) {
    try {
      const j = await (await fetch(`${SITE_URL}/api/status`, { signal: AbortSignal.timeout(4000) })).json();
      return `Yep, the platform is ${j.ok ? 'online' : 'having some trouble'} right now, with ${j.stats.running} of ${j.stats.bots} bots running.`;
    } catch (e) {}
  }
  for (const [re, fn] of INTENTS) if (re.test(q)) return fn(name, c);
  return `I'm running in basic mode right now, so I can only help with the Ladybug Cloud basics: linking your number, coins, pricing, payments and troubleshooting. Try asking about one of those, or reach the admin through Contact admin.`;
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

// Turn written text into something a person would actually say out loud (no slashes, symbols, URLs).
function speakable(t) {
  return String(t)
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/[^\s)]+/gi, 'the website')
    .replace(/(^|\s)#\/[\w\/-]*/g, ' the page ')
    .replace(/\b24\s*\/\s*7\b/g, 'twenty four seven')
    .replace(/\$\s?(\d+(?:\.\d+)?)\s*\/\s*(month|mo)\b/gi, '$1 dollars a month')
    .replace(/\$\s?1\b(?!\d)/g, 'one dollar').replace(/\$\s?(\d+(?:\.\d+)?)/g, '$1 dollars')
    .replace(/(\d+)\s*\/\s*(day|d)\b/gi, '$1 a day')
    .replace(/\/\s*(month|mo)\b/gi, ' a month')
    .replace(/\/\s*(day|week|year)\b/gi, ' a $1')
    .replace(/\band\/or\b/gi, 'and or')
    .replace(/\s*(->|=>|→)\s*/g, ' to ')
    .replace(/[`*_~#>|\\^<>{}\[\]]/g, ' ')
    .replace(/(^|\n)\s*(?:[-•]|\d+[.)])\s+/g, '$1')
    .replace(/&/g, ' and ')
    .replace(/%/g, ' percent')
    .replace(/\//g, ' ')
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '')
    .replace(/\s*\n+\s*/g, '. ')
    .replace(/\.\s*\./g, '.')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([.,!?])/g, '$1')
    .trim();
}

// ---------------- keyless brain (Knight API) ----------------
// This free endpoint is a single GET with ~750 usable characters, so the prompt is built to a strict budget.
const FACTS = [
  { re: /ntando|ntandomods|who (made|built|created|owns)|developer|zimbabwe|about (you|us)|who are you/i, t: 'Ntandomods is the brand of Ntando, a real developer from Zimbabwe. Products: Ladybug Cloud (bot hosting), Ladybug Mini (WhatsApp bot), Ladybug AI (this assistant).' },
  { re: /pair|link|connect|session|code|set ?up|get started|start|number|linked/i, t: 'Pairing: dashboard, create bot, enter number with country code, tap Get code (8 digits, lasts about 60s), then WhatsApp Linked devices, Link with phone number, type the code. Then press Start.' },
  { re: /price|pricing|cost|how much|plan|unlimited|subscri|dollar|zig|cheap|auto-?claim|slot|trial|free/i, t: '7 days free. Then 20 coins a day; claim 20 free coins every 24h (cap 140). Unlimited $3/month needs no coins. Auto-claim $2/month. Extra bot slot $1/month. 100 coins cost $1.' },
  { re: /coin|claim|balance|paus|ran out|run out/i, t: 'Hosting costs 20 coins a day. Claim 20 free coins every 24h (cap 140). If coins run out the bot pauses, nothing is deleted; claim coins and press Start.' },
  { re: /pay|bank|nsb|transfer|proof|receipt|paid|ecocash/i, t: 'Pay by bank transfer in USD or ZiG to the NSB accounts on the Pay page, then send proof on the Pay page or message the admin. The admin confirms by hand.' },
  { re: /referr|invite|friend|bonus/i, t: 'Referral: friend gets 20 bonus coins at signup, you get 40 when their bot is online 10 minutes. Max 10 rewards a month.' },
  { re: /not respon|no respon|stopp|offline|not working|silent|crash|restart|logged out|error|broken|reply|replying/i, t: 'Bot silent? Check if it is paused (claim coins, press Start), read the live logs, prefix is a dot by default, check Linked devices in WhatsApp; if the device is gone, pair again.' },
  { re: /command|feature|what can|menu|sticker|download|\.ai|prefix/i, t: 'Ladybug Mini commands: owner (.autostatus .setprefix), admin (.antilink .welcome .tagall), downloader (.play .ytmp4 .tiktok), general (.ai .sticker .translate). Default prefix is a dot.' },
  { re: /admin|human|refund|ban|account|password|forgot|contact|support|recover/i, t: 'You cannot see accounts or approve payments. For refunds, bans or recovery, log in and use Contact admin on the website.' },
];
const SHORT_TONE = { friendly: 'warm', casual: 'relaxed', professional: 'polished', playful: 'witty', calm: 'calm' };
const SHORT_LEN = { short: 'max 2 short sentences', normal: 'max 3 short sentences', detailed: 'a short paragraph' };
let knightQ = Promise.resolve();
function knightFetch(url) {
  const run = async () => {
    for (let i = 0; i < 2; i++) {
      const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 LadybugAI' }, signal: AbortSignal.timeout(30000) });
      if (r.status === 429 && i === 0) { await new Promise((x) => setTimeout(x, 1800)); continue; }
      if (!r.ok) throw new Error('knight ' + r.status);
      return r.json();
    }
    throw new Error('knight rate limited');
  };
  const p = knightQ.then(run, run);
  knightQ = p.catch(() => {}).then(() => new Promise((x) => setTimeout(x, 500)));
  return p;
}
async function knightChat(messages, voice, st, live) {
  const users = messages.filter((m) => m.role === 'user');
  const q = (users[users.length - 1]?.content || '').replace(/\s+/g, ' ').slice(0, 170);
  const prevQ = (users[users.length - 2]?.content || '').replace(/\s+/g, ' ');
  const prevA = ([...messages].reverse().find((m, i, arr) => m.role === 'assistant' && arr.indexOf(m) > 0)?.content || '').replace(/\s+/g, ' ');
  let facts = FACTS.filter((f) => f.re.test(q)).slice(0, 2).map((f) => f.t).join(' ');
  if (/\b(status|online|down|working right now)\b/i.test(q)) { const m = /Platform: (\w+), bots running (\d+)\/(\d+)/.exec(live); if (m) facts = `Platform is ${m[1]} now, ${m[2]} of ${m[3]} bots running. ` + facts; }
  if (!facts && prevQ) facts = FACTS.filter((f) => f.re.test(prevQ)).slice(0, 1).map((f) => f.t).join(' ');
  let web = '';
  if (!facts && /\b(search|latest|news|today|current|who is|who was|weather|what is|define|meaning|price of)\b/i.test(q)) {
    const found = await runTool('web_search', { query: q });
    if (found && !/^no results|^tool error/.test(found)) web = 'WEB: ' + found.split('\n\n')[0].replace(/\n/g, ' ').slice(0, 300) + ' ';
  }
  if (!facts && !web) facts = FACTS[0].t;
  const header = `You are ${st.name} (Ntandomods, Zimbabwe), a ${SHORT_TONE[st.tone]}, human-sounding helper for Ladybug Cloud WhatsApp bot hosting, and a smart general assistant. Use contractions, ${SHORT_LEN[st.length]}${st.emoji ? '' : ', no emoji'}${voice ? ', spoken style' : ''}. Never invent prices.`;
  const body = `${header}\n${web ? web : 'FACTS: ' + facts.slice(0, 300)}\n`;
  const tail = (prevQ && prevA ? `User: ${prevQ.slice(0, 80)}\n${st.name}: ${prevA.slice(0, 90)}\n` : '') + `User: ${q}\n${st.name}:`;
  let prompt = body + tail;
  if (prompt.length > 760) prompt = body + `User: ${q}\n${st.name}:`;
  if (prompt.length > 780) prompt = header + '\nFACTS: ' + facts.slice(0, Math.max(0, 780 - header.length - q.length - 40)) + `\nUser: ${q}\n${st.name}:`;
  const url = `${KNIGHT_URL}?apikey=${encodeURIComponent(KNIGHT_KEY)}&q=${encodeURIComponent(prompt)}`;
  const j = await knightFetch(url);
  let text = String(j.result || j.message || j.response || '').trim().replace(/^\s*(Assistant|User)\s*:\s*/i, '');
  text = text.replace(new RegExp('^\\s*' + st.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*:\\s*', 'i'), '').trim();
  if (!text) throw new Error('knight empty');
  return text;
}

const REASONING = /^(o\d|gpt-5)/.test(CHAT_MODEL);
async function chat(messages, voice, st = cleanStyle()) {
  const live = await liveData();
  const last = [...messages].reverse().find((m) => m.role === 'user');
  if (USE_KNIGHT) return knightChat(messages, voice, st, live);
  if (!OPENAI_KEY) return fallbackAnswer(last ? last.content : '', st.name, voice);
  const convo = [{ role: REASONING ? 'developer' : 'system', content: SYSTEM(live, voice, st) }, ...messages];
  for (let step = 0; step < 5; step++) {
    const body = { model: CHAT_MODEL, messages: convo, tools: TOOLS };
    if (REASONING) { body.max_completion_tokens = voice ? 2500 : 6000; body.reasoning_effort = voice ? 'low' : 'medium'; }
    else { body.temperature = 0.7; body.max_tokens = voice ? 300 : 1200; }
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
    let reply;
    try { reply = await chat(messages, !!req.body.voice, cleanStyle(req.body.style)); aiHealthy = !!OPENAI_KEY || USE_KNIGHT; }
    catch (e) {
      console.error('LLM failed, using basic mode:', e.message);
      aiHealthy = false;
      const last = [...messages].reverse().find((m) => m.role === 'user');
      reply = await fallbackAnswer(last ? last.content : '', cleanStyle(req.body.style).name, !!req.body.voice);
    }
    if (req.body.voice) reply = speakable(reply);
    res.json({ reply, mode: (OPENAI_KEY || USE_KNIGHT) && aiHealthy ? 'ai' : 'basic' });
  } catch (e) {
    console.error(e.message);
    res.status(502).json({ error: 'The assistant is unavailable right now. Please try again or contact the admin.' });
  }
});

// Text-to-speech (OpenAI). Browser falls back to speechSynthesis when this 404s.
app.post('/api/tts', limiter, async (req, res) => {
  if (!OPENAI_KEY || !TTS_ENABLED) return res.status(404).json({ error: 'tts disabled' });
  const text = speakable(String(req.body.text || '')).slice(0, 1200);
  const VOICES = ['alloy','ash','coral','echo','fable','nova','onyx','sage','shimmer'];
  const voice = VOICES.includes(req.body.voice) ? req.body.voice : TTS_VOICE;
  const speed = Math.min(1.35, Math.max(0.7, parseFloat(req.body.speed) || 1));
  if (!text) return res.status(400).json({ error: 'No text' });
  try {
    const r = await fetch(`${OPENAI_BASE}/audio/speech`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPENAI_KEY}` },
      body: JSON.stringify(
        TTS_MODEL.startsWith('gpt-4o')
          ? { model: TTS_MODEL, voice, input: text, response_format: 'mp3', instructions: `Speak like a real, friendly person in a relaxed phone conversation: natural rhythm, light emotion, small pauses, not like a news reader or a script. ${speed > 1.1 ? 'Speak a little faster than normal.' : speed < 0.9 ? 'Speak slowly and gently.' : ''}` }
          : { model: TTS_MODEL, voice, input: text, response_format: 'mp3', speed }
      ),
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
  if (!OPENAI_KEY || !STT_MODEL) return res.status(404).json({ error: 'stt disabled' });
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
  res.json({ ai: (!!OPENAI_KEY || USE_KNIGHT) && aiHealthy, provider: PROVIDER ? PROVIDER.name : USE_KNIGHT ? 'knight' : null, tts: TTS_ENABLED, stt: !!(OPENAI_KEY && STT_MODEL), site: SITE_URL, escalation: !!ESCALATION_WEBHOOK })
);
app.get('/healthz', (req, res) => res.send('ok'));

app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

app.listen(PORT, () => console.log(`Ladybug AI listening on :${PORT} | provider=${PROVIDER ? PROVIDER.name + ' ' + CHAT_MODEL : USE_KNIGHT ? 'knight (keyless)' : 'none (basic mode)'}`));
