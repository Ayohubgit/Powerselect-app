# RateDial server

This is the small backend RateDial needs so the "Find plans in your area"
ZIP search can call Claude with web search. It exists for one reason: your
Anthropic API key has to live on a server, never in the browser.

```
ratedial-server/
├── server.js        # the whole backend — one route: POST /api/zip-search
├── package.json
├── .env.example      # copy to .env and fill in your key
└── public/
    └── index.html    # the RateDial app itself (already wired to call /api/zip-search)
```

## Run it locally

1. Install dependencies:
   ```
   npm install
   ```
2. Copy the env example and add your real key:
   ```
   cp .env.example .env
   ```
   Then edit `.env` and set `ANTHROPIC_API_KEY=sk-ant-...` (get one from
   https://console.anthropic.com if you don't have one).
3. Start the server:
   ```
   npm start
   ```
4. Open **http://localhost:3000** in your browser. The whole app should load,
   and typing a ZIP code and clicking "Search providers" should return results.
5. Sanity check the server on its own anytime with:
   ```
   curl http://localhost:3000/api/health
   ```
   `"hasApiKey":true` means your key loaded correctly. `false` means `.env` isn't set up.

## Deploy it somewhere real

Any host that runs a Node.js server works. Two easy free/cheap options:

### Option A — Render.com
1. Push this folder to a GitHub repo.
2. In Render, click **New → Web Service**, connect the repo.
3. Build command: `npm install` — Start command: `npm start`.
4. Under **Environment**, add `ANTHROPIC_API_KEY` with your real key.
5. Deploy. Render gives you a public URL — open it and test the same way as local.

### Option B — Railway.app
1. Push this folder to a GitHub repo.
2. In Railway, **New Project → Deploy from GitHub repo**.
3. Railway auto-detects Node and runs `npm start`.
4. Add the `ANTHROPIC_API_KEY` variable under the project's **Variables** tab.
5. Railway gives you a public domain (or you can attach your own).

Both work the same way conceptually: the platform runs `server.js` for you,
you give it the API key as an environment variable (never commit `.env`),
and it serves the app plus the `/api/zip-search` route on one URL.

## How to actually verify the ZIP search is working after deploy

1. Visit your deployed URL — the calculator should load immediately.
2. Open your browser's dev tools → Network tab.
3. Enter a real ZIP code (e.g. one in Texas, Ohio, or another deregulated
   state) and click **Search providers**.
4. Watch for the `POST /api/zip-search` request:
   - **200 response with a `market` field and a `plans` array** → it's working.
   - **500 "Server is missing ANTHROPIC_API_KEY"** → the env variable isn't
     set on your host, or the server needs a restart after you added it.
   - **502 "Upstream API error"** → check the server logs on your host for
     the `detail` field — usually an invalid/expired key or a billing issue
     on the Anthropic account.
   - **Request never finishes / times out** → the search can genuinely take
     20–40 seconds since it's doing a live web search; give it a bit before
     assuming it's broken.

## Notes

- The calculator (usage input, plan cards, cost ranking) works with **no
  server and no API key at all** — it's plain HTML/JS. Only ZIP search needs
  this backend.
- `window.storage` (the Save/Load buttons) is a Claude.ai-artifact-only
  feature — it won't work once deployed elsewhere. If you want persistence
  after deploying, say so and I can swap it for a real database or even just
  browser `localStorage` for this environment (it's disallowed inside
  Claude.ai artifacts, but fine on your own deployed site).
