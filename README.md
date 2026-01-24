# Connect WhatsApp Embedded Signup Patch

This service temporarily replaces the WordPress `admin-ajax` onboarding flow with a Node.js app that reads/writes the same WordPress database table (`wp_wa_configurations`). It renders a public `/wpp?session=...` landing page for WhatsApp Embedded Signup and finalizes onboarding by calling the Meta Graph API.

## Features
- Validates one-time onboarding sessions stored in `wp_wa_configurations`.
- Captures `code`, `phone_number_id`, and `waba_id`.
- Exchanges code for access token and performs Graph API steps.
- Updates the existing WordPress table without creating new tables.
- Rate limits onboarding completion per IP.

## Environment variables
Create a `.env` file with:

```bash
PORT=3000
BASE_URL=https://connect.moviatech.com.mx
FB_APP_ID=...
FB_CONFIG_ID=...
GRAPH_API_VERSION=v23.0
FB_CLIENT_ID=...
FB_CLIENT_SECRET=...
FB_REDIRECT_URI=https://connect.moviatech.com.mx/wpp
WA_REGISTER_PIN=000000
MYSQL_HOST=...
MYSQL_PORT=3306
MYSQL_USER=...
MYSQL_PASSWORD=...
MYSQL_DATABASE=...
WP_TABLE_PREFIX=wp_
ADMIN_WHITELIST=2,6
TOKEN_TTL_HOURS=72
RATE_LIMIT_PER_MIN=20
```

> `FB_REDIRECT_URI` **must exactly match** the Meta App settings.

## Meta App settings checklist
In the Facebook App configuration:
- **App Domains**: `connect.moviatech.com.mx`
- **JS SDK allowed domains**: `https://connect.moviatech.com.mx`
- **Valid OAuth Redirect URIs**: `https://connect.moviatech.com.mx/wpp`

## Local development
```bash
npm install
npm run dev
```

Visit:
```
http://localhost:3000/wpp?session=<token>
```

## Production deployment (VPS)
1. Install dependencies and create `.env`.
2. Start the service:
   ```bash
   npm install --production
   npm start
   ```
3. Configure your reverse proxy (Traefik/Nginx) to forward HTTPS traffic to `http://127.0.0.1:3000`.

## Dokploy / Docker deployment
By default, Docker Compose maps the container port `3000` to host port `3001` to avoid conflicts if `3000` is already in use. Override with `HOST_PORT` if needed:

```bash
HOST_PORT=3000 docker compose up -d --build
```

## Troubleshooting: redirect_uri mismatch
If you see `redirect_uri mismatch`:
- Confirm `FB_REDIRECT_URI` in `.env` matches the Meta app setting exactly.
- Ensure the domain is listed in **App Domains** and **Valid OAuth Redirect URIs**.
- Double-check there are no trailing slashes or HTTP/HTTPS mismatch.

## Routes
- `GET /health` → returns `ok`
- `GET /wpp?session=...` → serves the Embedded Signup landing page
- `POST /api/onboarding/complete` → finalizes onboarding
