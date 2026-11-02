# Ladybug Cloud Support AI ("Lady")

Text + voice-call support assistant for https://ladybugcloud.xubi.org. Answers from `knowledge.md` plus live prices/status pulled from the platform.

## Deploy on Render
1. Push this folder to a GitHub repo.
2. Render > New > Blueprint > pick the repo (reads `render.yaml`).
3. Set `OPENAI_API_KEY` when prompted. Done: your URL is `https://ladybug-support-ai.onrender.com`.

Without a key it runs in "basic mode" (keyword FAQ answers, browser voice only).

## Voice
- Click **Call Lady**: hands-free loop (listen > think > speak). Chrome/Edge/Safari use built-in speech recognition. Other browsers use server speech-to-text (needs the OpenAI key).
- Lady's voice uses OpenAI TTS when a key is set, otherwise the browser voice.

## Embed on the Ladybug Cloud site
Add before `</body>`: `<script src="https://YOUR-SERVICE.onrender.com/widget.js" defer></script>`

## Env vars
OPENAI_API_KEY, OPENAI_MODEL (gpt-4o-mini), OPENAI_TTS_VOICE (coral), SITE_URL, ALLOWED_ORIGINS, ESCALATION_WEBHOOK_URL (Discord/Slack), RATE_LIMIT_PER_MIN.

Edit `knowledge.md` to change what Lady knows. Free Render plan sleeps after 15 min idle (first request is slow); use Starter ($7) for a snappy call experience.
