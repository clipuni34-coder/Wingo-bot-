# Wingo Bot

Real-time Wingo game analysis and Big/Small prediction bot.

## Live Demo
**Web URL**: https://smart-robertson-reload-cattle.trycloudflare.com

## Data Source
Connected to `fb999.com` real-time Wingo API (`fb999api.com`). Features:
- Real-time period countdown
- Live game results (20+ history records)
- MD5 signature authentication
- All game modes: 30s, 1m, 3m, 5m, 10m

## Quick Start
```bash
npm install
node server/index.js
```
Visit http://localhost:3001

## Docker
```bash
docker build -t wingo-bot .
docker run -p 3000:3000 wingo-bot
```

## API Endpoints
| Endpoint | Description |
|----------|-------------|
| `/health` | Health check |
| `/api/modes` | Available game modes |
| `/api/wingo?mode=1m` | Live data + analysis |
| `/api/predict?mode=1m` | Big/Small prediction |

## Project Structure
```
wingo-bot/
├── server/        # Express backend (api.js, analyzer.js, index.js)
├── web/           # Mobile-first PWA frontend
├── test/          # Tests
├── Dockerfile
├── docker-compose.yml
└── package.json
```
