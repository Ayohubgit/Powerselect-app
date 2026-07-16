require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();
app.set('trust proxy', true); // needed so req.ip reflects the real visitor, not Render's proxy
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
if (!ANTHROPIC_API_KEY) {
  console.warn('WARNING: ANTHROPIC_API_KEY is not set. /api/zip-search will fail until it is.');
}

function buildPrompt(zip, avgMonthly, peakSharePct) {
  return 'A homeowner in ZIP code ' + zip + ' (USA) wants to compare residential electricity plans. ' +
    'Their average usage is about ' + avgMonthly + ' kWh/month, with roughly ' + peakSharePct + '% of that used during afternoon/evening peak hours. ' +
    'Use web search to determine: (1) whether this ZIP is in a deregulated retail-choice electricity market or a regulated utility-monopoly market, ' +
    '(2) the name of the default/incumbent utility that delivers power there, and (3) if it is deregulated, 3-6 real current residential retail electricity plans available there from different companies (or if regulated, the closest available options such as the utility\'s standard rate and any community choice aggregation or green power program). ' +
    'Respond with ONLY a single JSON object and nothing else — no markdown fences, no commentary before or after. Use this exact schema: ' +
    '{"market":"deregulated|regulated|unknown","utility":"string","summary":"1-2 sentence plain-English explanation of what this means for the homeowner","plans":[{"name":"string","company":"string","type":"fixed|tiered|tou|indexed","estimatedRate":0.00,"monthlyFee":0.00,"contractMonths":0,"etf":0,"renewablePercent":0,"peakRate":0.00,"offPeakRate":0.00,"tiers":[{"limit":0,"rate":0.00}],"sourceNote":"short note on where this came from or how confident you are"}]}. ' +
    'For "type":"fixed" or "indexed" use estimatedRate. For "type":"tou" use peakRate/offPeakRate. For "type":"tiered" use tiers (limit null on the last tier). Omit fields that don\'t apply to a plan\'s type rather than guessing. If you cannot find real plans, return an empty plans array and explain why in summary.';
}

function extractJson(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    throw new Error('No JSON object found in model output');
  }
  return JSON.parse(text.slice(start, end + 1));
}

// ---------- Rate limiting ----------
// This is deliberately simple: an in-memory counter, no database. That means
// it resets whenever the server restarts, and only applies per-server-instance —
// plenty good enough to stop a spike from burning through the API budget, but
// swap in something like Redis if this ever needs to scale beyond one instance.

const PER_IP_LIMIT = 5;              // max ZIP searches per visitor per hour
const PER_IP_WINDOW_MS = 60 * 60 * 1000;
const GLOBAL_DAILY_LIMIT = 60;       // max total ZIP searches per day, across all visitors

const ipHits = new Map(); // ip -> array of request timestamps (ms)
let globalCounter = { day: todayKey(), count: 0 };

function todayKey() {
  return new Date().toISOString().slice(0, 10); // e.g. "2026-07-15", resets at UTC midnight
}

function checkRateLimit(ip) {
  const now = Date.now();

  // Roll the global counter over if the day has changed
  const today = todayKey();
  if (globalCounter.day !== today) {
    globalCounter = { day: today, count: 0 };
  }
  if (globalCounter.count >= GLOBAL_DAILY_LIMIT) {
    return { allowed: false, reason: 'global' };
  }

  // Sliding window per visitor
  const recentHits = (ipHits.get(ip) || []).filter((t) => now - t < PER_IP_WINDOW_MS);
  if (recentHits.length >= PER_IP_LIMIT) {
    ipHits.set(ip, recentHits);
    return { allowed: false, reason: 'ip' };
  }

  recentHits.push(now);
  ipHits.set(ip, recentHits);
  globalCounter.count += 1;
  return { allowed: true };
}

// Occasional light cleanup so the ipHits map doesn't grow forever
setInterval(() => {
  const now = Date.now();
  for (const [ip, hits] of ipHits.entries()) {
    const recent = hits.filter((t) => now - t < PER_IP_WINDOW_MS);
    if (recent.length === 0) ipHits.delete(ip);
    else ipHits.set(ip, recent);
  }
}, 15 * 60 * 1000).unref();

app.post('/api/zip-search', async (req, res) => {
  try {
    if (!ANTHROPIC_API_KEY) {
      return res.status(500).json({ error: 'Server is missing ANTHROPIC_API_KEY. Set it in your environment and redeploy.' });
    }

    const clientIp = req.ip || 'unknown';
    const limitCheck = checkRateLimit(clientIp);
    if (!limitCheck.allowed) {
      const message = limitCheck.reason === 'global'
        ? 'This tool has hit its search limit for today — please check back tomorrow.'
        : 'You\'ve hit the search limit for now — try again in a bit.';
      return res.status(429).json({ error: message });
    }

    const { zip, avgMonthly, peakSharePct } = req.body || {};
    if (!zip || typeof zip !== 'string') {
      return res.status(400).json({ error: 'A zip code (string) is required.' });
    }

    const prompt = buildPrompt(
      zip.trim().slice(0, 10),
      Number(avgMonthly) > 0 ? Number(avgMonthly) : 1000,
      Number(peakSharePct) >= 0 ? Number(peakSharePct) : 30
    );

    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1200,
        messages: [{ role: 'user', content: prompt }],
        tools: [{ type: 'web_search_20250305', name: 'web_search' }]
      })
    });

    const data = await upstream.json();

    if (!upstream.ok) {
      console.error('Anthropic API error:', data);
      return res.status(502).json({ error: 'Upstream API error', detail: data });
    }

    const text = (data.content || [])
      .map((block) => (block.type === 'text' ? block.text : ''))
      .join('\n');

    let parsed;
    try {
      parsed = extractJson(text);
    } catch (parseErr) {
      console.error('Could not parse model output as JSON:', text);
      return res.status(502).json({ error: 'Could not parse a clean result from the model.', raw: text });
    }

    res.json(parsed);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'Unexpected server error' });
  }
});

// Simple health check, handy for confirming a deploy is actually live
app.get('/api/health', (req, res) => {
  const today = todayKey();
  const countToday = globalCounter.day === today ? globalCounter.count : 0;
  res.json({
    ok: true,
    hasApiKey: !!ANTHROPIC_API_KEY,
    zipSearchesToday: countToday,
    dailyLimit: GLOBAL_DAILY_LIMIT
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('RateDial server running on port ' + PORT);
});
