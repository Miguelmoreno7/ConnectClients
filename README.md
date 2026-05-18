# Connect WhatsApp / Instagram / Facebook Onboarding Patch

This service replaces the WordPress `admin-ajax` onboarding flow with a Node.js app that reads/writes the same WordPress MySQL database.

It keeps WhatsApp onboarding in `wp_wa_configurations` and adds parallel social integrations in:
- `wp_instagram_users`
- `wp_facebook_users`

## Features
- Public onboarding landing: `/wpp?session=...`
- Step 1 buttons with matching UI style:
  - Connect WhatsApp
  - Connect Instagram (Professional)
  - Connect Facebook (Pages/business)
- User-aware persistence using the same session→`user_id` linkage as WhatsApp.
- One service with server-side OAuth handling and callback redirects back to onboarding.

## Environment variables
Create a `.env` file:

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
OAUTH_STATE_SECRET=change-me
SESSION_SECRET=change-me
FACEBOOK_SCOPES=pages_show_list,pages_read_engagement,pages_manage_metadata,business_management
IG_APP_ID=...
IG_APP_SECRET=...
INSTAGRAM_SCOPES=instagram_business_basic,instagram_business_content_publish,instagram_business_manage_comments
```

## Required DB schema changes
1) Existing WhatsApp table updates (already requested):
- `wp_wa_configurations.onboarding_session`
- `wp_wa_configurations.onboarding_expires_at`
- `wp_wa_configurations.onboarding_status`
- `wp_wa_configurations.onboarding_consumed_at`
- `wp_wa_configurations.allowedChannels` CSV of enabled channels for the exact onboarding hash, for example `WHATSAPP,INSTAGRAM` or `WHATSAPP,INSTAGRAM,FACEBOOK`.
- Social status columns on `wp_wa_configurations` for per-hash tracking:
  - `instagram_connected`
  - `facebook_connected`
  - Values supported by the app: `1/0`, `true/false`, or `connected/not_connected`.

2) New social integration tables:
- Ensure `wp_instagram_users` and `wp_facebook_users` already exist in MySQL before starting the app.
- `wp_facebook_users` should support one row per connected page and must include `user_access_token` and `page_access_token`.
- `wp_facebook_users` must allow multiple rows for the same `user_id`; use a unique key on `(user_id, page_id)` (or no `user_id`-only unique key) so multiple selected Facebook Pages can be saved.
- During Facebook onboarding, each connected page is also subscribed to app webhooks using `POST /{page-id}/subscribed_apps` with `subscribed_fields=messages,messaging_postbacks,message_deliveries,message_reads,standby,feed`.
- The app reads social status for the landing UI from the `wp_wa_configurations` row that matches the current `onboarding_session` hash.

## Meta app settings checklist
- **App Domains**: `connect.moviatech.com.mx`
- **JS SDK allowed domains**: `https://connect.moviatech.com.mx`
- **Valid OAuth Redirect URIs**:
  - `https://connect.moviatech.com.mx/wpp`
  - `https://connect.moviatech.com.mx/api/oauth/instagram/callback`
  - `https://connect.moviatech.com.mx/api/oauth/facebook/callback`

## Local development
```bash
npm install
npm run dev
```

## Docker / Dokploy deployment
```bash
docker compose up -d --build
```

By default, docker-compose maps container `3000` to a random free host port. Override if needed:
```bash
HOST_PORT=3000 docker compose up -d --build
```

## Routes
- `GET /health` → `ok`
- `GET /wpp?session=...` → onboarding page
- `GET /api/connections/state?session=...` → provider statuses
- `GET /api/oauth/instagram/start?session=...` → start Instagram OAuth
- `GET /api/oauth/instagram/callback` → Instagram callback
- `GET /api/oauth/facebook/start?session=...` → start Facebook OAuth
- `GET /api/oauth/facebook/callback` → Facebook callback
- `POST /api/onboarding/complete` → finish WhatsApp Embedded Signup

## Troubleshooting: redirect_uri mismatch
- Verify callback URLs in Meta exactly match `.env`/deployment URL.
- Check HTTP vs HTTPS and trailing slash mismatches.
