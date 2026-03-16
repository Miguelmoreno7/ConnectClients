const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const express = require("express");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const dotenv = require("dotenv");

dotenv.config();

const { getTableName, withConnection } = require("./db");
const {
  exchangeCodeForToken,
  getPhoneNumberDetails,
  registerPhoneNumber,
  getWabaName,
  subscribeApps,
  exchangeOAuthCodeForToken,
  getFacebookMe,
  getFacebookAccountsWithInstagram,
  getFacebookPagesForUser
} = require("./meta");

const app = express();

const graphVersion = process.env.GRAPH_API_VERSION || "v23.0";
const oauthStateSecret = process.env.OAUTH_STATE_SECRET || process.env.FB_CLIENT_SECRET || "state-secret";
const facebookScopes = (process.env.FACEBOOK_SCOPES || "pages_show_list,pages_read_engagement,pages_manage_metadata,business_management")
  .split(",")
  .map((scope) => scope.trim())
  .filter(Boolean);
const instagramScopes = (process.env.INSTAGRAM_SCOPES || "instagram_basic,instagram_manage_messages,pages_show_list,business_management")
  .split(",")
  .map((scope) => scope.trim())
  .filter(Boolean);

app.use(helmet());
app.use(express.json({ limit: "1mb" }));
app.use("/public", express.static(path.join(__dirname, "..", "public")));

const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: Number(process.env.RATE_LIMIT_PER_MIN || 20),
  standardHeaders: true,
  legacyHeaders: false
});

const validateSessionToken = (session) => {
  if (!session || typeof session !== "string") return false;
  if (session.length < 10 || session.length > 64) return false;
  return /^[A-Za-z0-9_-]+$/.test(session);
};

const maskValue = (value, visible = 4) => {
  if (!value || typeof value !== "string") return "";
  if (value.length <= visible) return "*".repeat(value.length);
  return `${"*".repeat(value.length - visible)}${value.slice(-visible)}`;
};

const signState = (payload) => {
  const raw = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto.createHmac("sha256", oauthStateSecret).update(raw).digest("base64url");
  return `${raw}.${sig}`;
};

const verifyState = (state) => {
  if (!state || typeof state !== "string" || !state.includes(".")) return null;
  const [raw, sig] = state.split(".");
  const expectedSig = crypto.createHmac("sha256", oauthStateSecret).update(raw).digest("base64url");
  if (sig !== expectedSig) return null;
  try {
    return JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    return null;
  }
};

const getSessionRecord = async (connection, session, { lock = false } = {}) => {
  const table = getTableName("wa_configurations");
  const lockClause = lock ? "FOR UPDATE" : "";
  const [rows] = await connection.query(
    `SELECT id, user_id, onboarding_status, onboarding_expires_at
     FROM ${table}
     WHERE onboarding_session = ?
       AND onboarding_status = 'pending'
       AND onboarding_expires_at > NOW()
     LIMIT 1 ${lockClause}`,
    [session]
  );
  return rows?.[0] || null;
};

const getConnectionState = async (userId) => {
  const instagramTable = getTableName("instagram");
  const facebookTable = getTableName("facebook_users");

  return withConnection(async (connection) => {
    const [igRows] = await connection.query(
      `SELECT status, instagram_username, account_type, updated_at, last_error, last_connected_at
       FROM ${instagramTable}
       WHERE user_id = ?
       ORDER BY id DESC
       LIMIT 1`,
      [userId]
    ).catch((error) => {
      if (error.code === "ER_NO_SUCH_TABLE") return [[]];
      throw error;
    });

    const [fbRows] = await connection.query(
      `SELECT status, page_name, updated_at, last_error, last_connected_at
       FROM ${facebookTable}
       WHERE user_id = ?
       ORDER BY id DESC
       LIMIT 1`,
      [userId]
    ).catch((error) => {
      if (error.code === "ER_NO_SUCH_TABLE") return [[]];
      throw error;
    });

    return {
      instagram: igRows?.[0]
        ? {
            status: igRows[0].status,
            label: igRows[0].instagram_username || "Instagram account",
            account_type: igRows[0].account_type || null,
            last_error: igRows[0].last_error || null,
            last_connected_at: igRows[0].last_connected_at || null
          }
        : { status: "not_connected" },
      facebook: fbRows?.[0]
        ? {
            status: fbRows[0].status,
            label: fbRows[0].page_name || "Facebook page",
            last_error: fbRows[0].last_error || null,
            last_connected_at: fbRows[0].last_connected_at || null
          }
        : { status: "not_connected" }
    };
  });
};

const updateIntegrationError = async ({ provider, userId, errorMessage, metadata }) => {
  const table = provider === "facebook" ? getTableName("facebook_users") : getTableName("instagram");
  await withConnection((connection) =>
    connection.query(
      `INSERT INTO ${table} (user_id, status, last_error, metadata, updated_at, created_at)
       VALUES (?, 'error', ?, ?, NOW(), NOW())
       ON DUPLICATE KEY UPDATE
         status = VALUES(status),
         last_error = VALUES(last_error),
         metadata = VALUES(metadata),
         updated_at = NOW()`,
      [userId, errorMessage, JSON.stringify(metadata || {})]
    )
  ).catch((error) => {
    if (error.code !== "ER_NO_SUCH_TABLE") {
      console.error(`Failed to save ${provider} error:`, error.message);
    }
  });
};

const renderWppPage = async ({ session, valid }) => {
  const templatePath = path.join(__dirname, "views", "wpp.html");
  const template = await fs.readFile(templatePath, "utf8");

  const page = template
    .replace("__FB_APP_ID__", process.env.FB_APP_ID || "")
    .replace("__FB_CONFIG_ID__", process.env.FB_CONFIG_ID || "")
    .replace("__GRAPH_VERSION__", graphVersion)
    .replace("__SESSION__", session || "")
    .replace("__BASE_URL__", process.env.BASE_URL || "");

  if (valid) {
    return page;
  }

  return page
    .replace("Waiting to start…", "Invalid or expired link. Please request a new link.")
    .replace('id="embedded-signup"', 'id="embedded-signup" disabled')
    .replace('id="instagram-connect"', 'id="instagram-connect" disabled')
    .replace('id="facebook-connect"', 'id="facebook-connect" disabled');
};

app.get("/health", (req, res) => {
  res.send("ok");
});

app.get("/wpp", async (req, res) => {
  const session = req.query.session;
  if (!validateSessionToken(session)) {
    const html = await renderWppPage({ session: "", valid: false });
    res.status(400).send(html);
    return;
  }

  const valid = await withConnection(async (connection) => {
    const record = await getSessionRecord(connection, session);
    return Boolean(record);
  });

  if (!valid) {
    const html = await renderWppPage({ session: "", valid: false });
    res.status(404).send(html);
    return;
  }

  const html = await renderWppPage({ session, valid: true });
  res.send(html);
});

app.get("/api/connections/state", async (req, res) => {
  const session = req.query.session;
  if (!validateSessionToken(session)) {
    res.status(400).json({ ok: false, message: "Invalid session." });
    return;
  }

  const sessionRow = await withConnection((connection) => getSessionRecord(connection, session));
  if (!sessionRow) {
    res.status(404).json({ ok: false, message: "Session not found or expired." });
    return;
  }

  const integrations = await getConnectionState(sessionRow.user_id);
  res.json({
    ok: true,
    whatsapp: { status: "pending" },
    instagram: integrations.instagram,
    facebook: integrations.facebook
  });
});

app.get("/api/oauth/:provider/start", async (req, res) => {
  const { provider } = req.params;
  const session = req.query.session;

  if (!["instagram", "facebook"].includes(provider)) {
    res.status(404).json({ ok: false, message: "Unsupported provider." });
    return;
  }

  if (!validateSessionToken(session)) {
    res.status(400).json({ ok: false, message: "Invalid session." });
    return;
  }

  const sessionRow = await withConnection((connection) => getSessionRecord(connection, session));
  if (!sessionRow) {
    res.status(404).json({ ok: false, message: "Session not found or expired." });
    return;
  }

  const callbackPath = provider === "instagram" ? "/api/oauth/instagram/callback" : "/api/oauth/facebook/callback";
  const redirectUri = `${process.env.BASE_URL}${callbackPath}`;
  const state = signState({
    provider,
    session,
    userId: sessionRow.user_id,
    ts: Date.now()
  });

  const scopes = provider === "instagram" ? instagramScopes : facebookScopes;
  const params = new URLSearchParams({
    client_id: process.env.FB_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: scopes.join(","),
    state
  });

  res.json({
    ok: true,
    auth_url: `https://www.facebook.com/${graphVersion}/dialog/oauth?${params.toString()}`
  });
});

app.get("/api/oauth/:provider/callback", async (req, res) => {
  const { provider } = req.params;
  if (!["instagram", "facebook"].includes(provider)) {
    res.status(404).send("Unsupported provider");
    return;
  }

  const { code, state, error, error_description: errorDescription } = req.query;
  const statePayload = verifyState(state);

  if (!statePayload || statePayload.provider !== provider || !validateSessionToken(statePayload.session)) {
    res.status(400).send("Invalid callback state");
    return;
  }

  const session = statePayload.session;
  const userId = Number(statePayload.userId);

  if (error) {
    await updateIntegrationError({
      provider,
      userId,
      errorMessage: `${error}: ${errorDescription || "OAuth cancelled"}`,
      metadata: { callback_error: error }
    });
    res.redirect(`/wpp?session=${encodeURIComponent(session)}&provider=${provider}&status=error`);
    return;
  }

  try {
    const callbackPath = provider === "instagram" ? "/api/oauth/instagram/callback" : "/api/oauth/facebook/callback";
    const redirectUri = `${process.env.BASE_URL}${callbackPath}`;

    const tokenData = await exchangeOAuthCodeForToken({ code, redirectUri });
    const accessToken = tokenData.access_token;

    if (!accessToken) {
      throw new Error("missing_access_token");
    }

    if (provider === "instagram") {
      const me = await getFacebookMe({ accessToken });

      const pages = await getFacebookAccountsWithInstagram({ accessToken });

      const pageWithIg = (pages.data || []).find((page) => page.instagram_business_account?.id);
      if (!pageWithIg) {
        throw new Error("instagram_professional_account_required");
      }

      const ig = pageWithIg.instagram_business_account;
      const instagramTable = getTableName("instagram");
      await withConnection((connection) =>
        connection.query(
          `INSERT INTO ${instagramTable}
          (user_id, status, instagram_user_id, instagram_username, account_type, access_token,
          refresh_token, token_expires_at, scopes, auth_code, raw_auth_payload, raw_response,
          created_at, updated_at, last_connected_at, last_error, metadata)
          VALUES (?, 'connected', ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, NOW(), NOW(), NOW(), NULL, ?)
          ON DUPLICATE KEY UPDATE
            status = VALUES(status),
            instagram_user_id = VALUES(instagram_user_id),
            instagram_username = VALUES(instagram_username),
            account_type = VALUES(account_type),
            access_token = VALUES(access_token),
            scopes = VALUES(scopes),
            auth_code = VALUES(auth_code),
            raw_auth_payload = VALUES(raw_auth_payload),
            raw_response = VALUES(raw_response),
            updated_at = NOW(),
            last_connected_at = NOW(),
            last_error = NULL,
            metadata = VALUES(metadata)`,
          [
            userId,
            ig.id,
            ig.username || null,
            ig.account_type || null,
            accessToken,
            JSON.stringify(instagramScopes),
            code,
            JSON.stringify(tokenData),
            JSON.stringify({ me, page: pageWithIg, ig }),
            JSON.stringify({ page_id: pageWithIg.id, page_name: pageWithIg.name, fb_user_id: me.id })
          ]
        )
      );
    }

    if (provider === "facebook") {
      const me = await getFacebookMe({ accessToken });
      const pages = await getFacebookPagesForUser({ accessToken });
      const firstPage = pages.data?.[0] || null;

      const facebookTable = getTableName("facebook_users");
      await withConnection((connection) =>
        connection.query(
          `INSERT INTO ${facebookTable}
          (user_id, status, facebook_user_id, page_id, page_name, access_token,
          refresh_token, token_expires_at, scopes, auth_code, raw_auth_payload, raw_response,
          created_at, updated_at, last_connected_at, last_error, metadata)
          VALUES (?, 'connected', ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, NOW(), NOW(), NOW(), NULL, ?)
          ON DUPLICATE KEY UPDATE
            status = VALUES(status),
            facebook_user_id = VALUES(facebook_user_id),
            page_id = VALUES(page_id),
            page_name = VALUES(page_name),
            access_token = VALUES(access_token),
            scopes = VALUES(scopes),
            auth_code = VALUES(auth_code),
            raw_auth_payload = VALUES(raw_auth_payload),
            raw_response = VALUES(raw_response),
            updated_at = NOW(),
            last_connected_at = NOW(),
            last_error = NULL,
            metadata = VALUES(metadata)`,
          [
            userId,
            me.id,
            firstPage?.id || null,
            firstPage?.name || null,
            accessToken,
            JSON.stringify(facebookScopes),
            code,
            JSON.stringify(tokenData),
            JSON.stringify({ me, pages }),
            JSON.stringify({ page_perms: firstPage?.perms || [] })
          ]
        )
      );
    }

    res.redirect(`/wpp?session=${encodeURIComponent(session)}&provider=${provider}&status=connected`);
  } catch (error) {
    const errMsg = error?.response?.data?.error?.message || error.message || "oauth_error";
    await updateIntegrationError({
      provider,
      userId,
      errorMessage: errMsg,
      metadata: { code: maskValue(code || "") }
    });
    console.error(`${provider} callback error: ${errMsg}`);
    res.redirect(`/wpp?session=${encodeURIComponent(session)}&provider=${provider}&status=error`);
  }
});

app.post("/api/onboarding/complete", limiter, async (req, res) => {
  const { session, code, phone_number_id: phoneNumberId, waba_id: wabaId } = req.body || {};

  if (!validateSessionToken(session)) {
    res.status(400).json({ ok: false, step: "validate_session", message: "Invalid or expired session." });
    return;
  }

  if (!code || !phoneNumberId || !wabaId) {
    res.status(400).json({ ok: false, step: "validate_session", message: "Missing required onboarding fields." });
    return;
  }

  const table = getTableName("wa_configurations");
  const metaTable = getTableName("metausers");

  try {
    const result = await withConnection(async (connection) => {
      await connection.beginTransaction();

      const sessionRecord = await getSessionRecord(connection, session, { lock: true });
      if (!sessionRecord) {
        await connection.rollback();
        return {
          error: {
            status: 400,
            payload: { ok: false, step: "validate_session", message: "Invalid or expired session." }
          }
        };
      }

      const { id, user_id: userId } = sessionRecord;

      if (process.env.ADMIN_WHITELIST) {
        try {
          const [limitRows] = await connection.query(
            `SELECT reached_limit FROM ${metaTable} WHERE user_id = ? LIMIT 1`,
            [userId]
          );
          const reachedLimit = limitRows?.[0]?.reached_limit;
          const whitelist = process.env.ADMIN_WHITELIST.split(",").map((v) => v.trim());
          if (reachedLimit === 1 && !whitelist.includes(String(userId))) {
            await connection.rollback();
            return {
              error: {
                status: 403,
                payload: { ok: false, step: "validate_session", error: "limit reached", message: "limit reached" }
              }
            };
          }
        } catch (error) {
          if (error.code !== "ER_NO_SUCH_TABLE") throw error;
        }
      }

      const tokenPayload = await exchangeCodeForToken({ code }).catch((error) => {
        throw new Error(`exchange_code:${error?.response?.data?.error?.message || error.message}`);
      });
      const accessToken = tokenPayload.access_token;
      if (!accessToken) throw new Error("exchange_code:missing_access_token");

      const numberDetails = await getPhoneNumberDetails({ phoneNumberId, accessToken }).catch((error) => {
        throw new Error(`verify_number:${error?.response?.data?.error?.message || error.message}`);
      });

      let status = "Successfully Connected to Whatsapp Coexistence";
      if (!numberDetails?.is_on_biz_app || numberDetails?.platform_type !== "CLOUD_API") {
        const registerResult = await registerPhoneNumber({
          phoneNumberId,
          accessToken,
          pin: process.env.WA_REGISTER_PIN
        }).catch((error) => {
          throw new Error(`register_number:${error?.response?.data?.error?.message || error.message}`);
        });

        status = registerResult?.success ? "Successfully Connected to Whatsapp Cloud API" : "Error";
      }

      const wabaResponse = await getWabaName({ wabaId, accessToken }).catch((error) => {
        throw new Error(`waba_name:${error?.response?.data?.error?.message || error.message}`);
      });

      const webhookResponse = await subscribeApps({ wabaId, accessToken }).catch((error) => {
        throw new Error(`subscribe_apps:${error?.response?.data?.error?.message || error.message}`);
      });

      const webhookStatus = webhookResponse?.success ? "Webhook subscription success" : "Webhook subscription failure";

      const [existingRows] = await connection.query(
        `SELECT COUNT(*) AS cnt FROM ${table} WHERE phone_number_id = ? LIMIT 1`,
        [phoneNumberId]
      );
      const exists = existingRows?.[0]?.cnt > 0;

      if (exists) {
        await connection.query(
          `UPDATE ${table}
           SET is_active = 1,
               access_token = ?,
               waba_id = ?,
               status = ?,
               waba_name = ?,
               onboarding_status = 'completed',
               onboarding_consumed_at = NOW(),
               onboarding_session = NULL
           WHERE phone_number_id = ?`,
          [accessToken, wabaId, status, wabaResponse?.name || null, phoneNumberId]
        );
      } else {
        const [updateResult] = await connection.query(
          `UPDATE ${table}
           SET access_token = ?,
               phone_number_id = ?,
               waba_id = ?,
               status = ?,
               waba_name = ?,
               is_active = 1,
               onboarding_status = 'completed',
               onboarding_consumed_at = NOW(),
               onboarding_session = NULL
           WHERE id = ?
             AND onboarding_status = 'pending'`,
          [accessToken, phoneNumberId, wabaId, status, wabaResponse?.name || null, id]
        );

        if (!updateResult.affectedRows) throw new Error("db_write:session_already_consumed");
      }

      await connection.commit();

      return {
        payload: {
          ok: true,
          status,
          webhook_status: webhookStatus,
          waba_name: wabaResponse?.name || null,
          phone_number_id: phoneNumberId,
          waba_id: wabaId
        }
      };
    });

    if (result?.error) {
      res.status(result.error.status).json(result.error.payload);
      return;
    }

    res.json(result.payload);
  } catch (error) {
    const message = error?.message || "Unexpected error";
    const [step, detail] = message.includes(":") ? message.split(/:(.+)/) : ["unknown", message];

    if (["exchange_code", "verify_number", "register_number", "waba_name", "subscribe_apps", "db_write"].includes(step)) {
      const codeMap = {
        exchange_code: 502,
        verify_number: 502,
        register_number: 502,
        waba_name: 502,
        subscribe_apps: 502,
        db_write: 409
      };
      res.status(codeMap[step]).json({
        ok: false,
        step,
        message:
          step === "db_write"
            ? "Session already consumed."
            : `Failed at step ${step}.`
      });
      return;
    }

    console.error(`Unhandled onboarding error: ${detail}`);
    res.status(500).json({ ok: false, step: "unknown", message: "Unexpected server error." });
  }
});

const port = Number(process.env.PORT || 3000);
app.listen(port, "0.0.0.0", () => {
  console.log(`Server listening on port ${port}`);
});
