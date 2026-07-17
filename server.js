require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();
app.set('trust proxy', true); // needed so req.ip reflects the real visitor, not Render's proxy
app.use(cors());
app.use(express.json({ limit: '10mb' })); // bill photos are base64-encoded, so allow a larger body
app.use(express.static('public'));

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
if (!ANTHROPIC_API_KEY) {
  console.warn('WARNING: ANTHROPIC_API_KEY is not set. /api/zip-search will fail until it is.');
}

function buildPrompt(zip, avgMonthly, peakSharePct) {
  return 'A homeowner in ZIP code ' + zip + ' (USA) wants to compare residential electricity plans. ' +
    'Their average usage is about ' + avgMonthly + ' kWh/month, with roughly ' + peakSharePct + '% of that used during afternoon/evening peak hours. ' +
    'Use web search to determine: (1) whether this ZIP is in a deregulated retail-choice electricity market or a regulated utility-monopoly market, ' +
    '(2) the name of the default/incumbent utility that delivers power there, and (3) if it is deregulated, exactly 3 real current residential retail electricity plans available there from different companies (or if regulated, the closest available options such as the utility\'s standard rate and any community choice aggregation or green power program). ' +
    'Respond with ONLY a single JSON object and nothing else — no markdown fences, no commentary before or after. Use this exact schema: ' +
    '{"market":"deregulated|regulated|unknown","utility":"string","summary":"1-2 sentence plain-English explanation of what this means for the homeowner","plans":[{"name":"string","company":"string","type":"fixed|tiered|tou|indexed","estimatedRate":0.00,"monthlyFee":0.00,"contractMonths":0,"etf":0,"renewablePercent":0,"peakRate":0.00,"offPeakRate":0.00,"tiers":[{"limit":0,"rate":0.00}],"sourceNote":"short note on where this came from or how confident you are"}]}. ' +
    'For "type":"fixed" or "indexed" use estimatedRate. For "type":"tou" use peakRate/offPeakRate. For "type":"tiered" use tiers (limit null on the last tier). Omit fields that don\'t apply to a plan\'s type rather than guessing. If you cannot find real plans, return an empty plans array and explain why in summary.';
}

function buildBillScanPrompt() {
  return 'This image or PDF is a residential electricity utility bill. Read it carefully and extract the usage information. ' +
    'Look for: the current billing period\'s total kWh usage, and — if the bill includes a usage history graph or table (common on many utility bills) — as many individual months of kWh usage as you can read. ' +
    'Respond with ONLY a single JSON object and nothing else — no markdown fences, no commentary before or after. Use this exact schema: ' +
    '{"avgMonthlyKwh":0,"billingPeriodKwh":0,"months":[{"label":"string","kwh":0}],"confidence":"high|medium|low","notes":"one short sentence about what you found or any uncertainty"}. ' +
    'If you can only find one billing period\'s usage and no history, set months to an empty array and use billingPeriodKwh and avgMonthlyKwh for that one value. ' +
    'If the image is unclear, isn\'t a utility bill, or you can\'t confidently read numbers, set confidence to "low" and explain briefly in notes rather than guessing at numbers.';
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

const PER_IP_LIMIT = 6;              // max AI-backed requests per visitor per hour (zip search + bill scan combined)
const PER_IP_WINDOW_MS = 60 * 60 * 1000;
const GLOBAL_DAILY_LIMIT = 80;       // max total AI-backed requests per day, across all visitors

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

// ---------- ZIP search cache ----------
// Plan availability for a given ZIP doesn't meaningfully change minute to minute,
// so we cache results per ZIP and reuse them for anyone else searching the same
// ZIP within the cache window. This is the single biggest cost saver here, since
// popular ZIPs get searched by many different visitors.

const ZIP_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const zipCache = new Map(); // normalized zip -> { data, timestamp }

function normalizeZip(zip) {
  return zip.trim().toUpperCase().slice(0, 10);
}

function getCachedZipResult(zip) {
  const entry = zipCache.get(normalizeZip(zip));
  if (!entry) return null;
  if (Date.now() - entry.timestamp > ZIP_CACHE_TTL_MS) {
    zipCache.delete(normalizeZip(zip));
    return null;
  }
  return entry.data;
}

function setCachedZipResult(zip, data) {
  zipCache.set(normalizeZip(zip), { data, timestamp: Date.now() });
}

// Light cleanup for the zip cache too, same idea as the ipHits cleanup above
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of zipCache.entries()) {
    if (now - entry.timestamp > ZIP_CACHE_TTL_MS) zipCache.delete(key);
  }
}, 60 * 60 * 1000).unref();

app.post('/api/zip-search', async (req, res) => {
  try {
    if (!ANTHROPIC_API_KEY) {
      return res.status(500).json({ error: 'Server is missing ANTHROPIC_API_KEY. Set it in your environment and redeploy.' });
    }

    const { zip, avgMonthly, peakSharePct } = req.body || {};
    if (!zip || typeof zip !== 'string') {
      return res.status(400).json({ error: 'A zip code (string) is required.' });
    }

    // Serve from cache if we've searched this ZIP recently — free, instant, and
    // doesn't touch the rate limit since no API call happens.
    const cached = getCachedZipResult(zip);
    if (cached) {
      return res.json(Object.assign({}, cached, { fromCache: true }));
    }

    const clientIp = req.ip || 'unknown';
    const limitCheck = checkRateLimit(clientIp);
    if (!limitCheck.allowed) {
      const message = limitCheck.reason === 'global'
        ? 'This tool has hit its search limit for today — please check back tomorrow.'
        : 'You\'ve hit the search limit for now — try again in a bit.';
      return res.status(429).json({ error: message });
    }

    const prompt = buildPrompt(
      zip.trim().slice(0, 10),
      Number(avgMonthly) > 0 ? Number(avgMonthly) : 1000,
      Number(peakSharePct) >= 0 ? Number(peakSharePct) : 30
    );

    const controller = new AbortController();
    // Stay comfortably under typical proxy/host timeouts (Render's free tier can
    // close slow connections) while still giving the web-search-backed call room to finish.
    const timeoutId = setTimeout(() => controller.abort(), 45000);

    let upstream;
    try {
      upstream = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          max_tokens: 1500,
          messages: [{ role: 'user', content: prompt }],
          tools: [{ type: 'web_search_20250305', name: 'web_search' }]
        }),
        signal: controller.signal
      });
    } catch (fetchErr) {
      clearTimeout(timeoutId);
      if (fetchErr.name === 'AbortError') {
        return res.status(504).json({ error: 'The search took too long and timed out. This can happen on slower connections — try again in a moment.' });
      }
      // Covers Node's "terminated" error and other dropped-connection cases
      return res.status(502).json({ error: 'The connection to the search service was interrupted. Please try again.' });
    }
    clearTimeout(timeoutId);

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

    setCachedZipResult(zip, parsed);
    res.json(Object.assign({}, parsed, { fromCache: false }));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'Unexpected server error' });
  }
});

app.post('/api/bill-scan', async (req, res) => {
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

    const { imageBase64, mediaType } = req.body || {};
    if (!imageBase64 || !mediaType) {
      return res.status(400).json({ error: 'An image (imageBase64) and mediaType are required.' });
    }
    const allowedTypes = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'application/pdf'];
    if (allowedTypes.indexOf(mediaType) === -1) {
      return res.status(400).json({ error: 'Unsupported file type. Please upload a PNG, JPEG, WEBP, or PDF.' });
    }

    const isPdf = mediaType === 'application/pdf';
    const contentBlock = isPdf
      ? { type: 'document', source: { type: 'base64', media_type: mediaType, data: imageBase64 } }
      : { type: 'image', source: { type: 'base64', media_type: mediaType, data: imageBase64 } };

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 45000);

    let upstream;
    try {
      upstream = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          max_tokens: 1000,
          messages: [{
            role: 'user',
            content: [ contentBlock, { type: 'text', text: buildBillScanPrompt() } ]
          }]
        }),
        signal: controller.signal
      });
    } catch (fetchErr) {
      clearTimeout(timeoutId);
      if (fetchErr.name === 'AbortError') {
        return res.status(504).json({ error: 'Reading the bill took too long and timed out. Try again in a moment.' });
      }
      return res.status(502).json({ error: 'The connection was interrupted while reading the bill. Please try again.' });
    }
    clearTimeout(timeoutId);

    const data = await upstream.json();

    if (!upstream.ok) {
      console.error('Anthropic API error (bill scan):', data);
      return res.status(502).json({ error: 'Upstream API error', detail: data });
    }

    const text = (data.content || [])
      .map((block) => (block.type === 'text' ? block.text : ''))
      .join('\n');

    let parsed;
    try {
      parsed = extractJson(text);
    } catch (parseErr) {
      console.error('Could not parse bill-scan output as JSON:', text);
      return res.status(502).json({ error: 'Could not read that bill clearly. Try a sharper photo or a different page of the bill.', raw: text });
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
    dailyLimit: GLOBAL_DAILY_LIMIT,
    zipCacheEntries: zipCache.size
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('RateDial server running on port ' + PORT);
});
