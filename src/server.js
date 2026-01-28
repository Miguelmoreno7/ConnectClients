console.log("[ENV CHECK] MYSQL_HOST =", process.env.MYSQL_HOST);
console.log("[ENV CHECK] MYSQL_DATABASE =", process.env.MYSQL_DATABASE);
console.log("[ENV CHECK] MYSQL_PORT =", process.env.MYSQL_PORT);
console.log("[ENV CHECK] FB_REDIRECT_URI =", process.env.FB_REDIRECT_URI);

const fs = require("node:fs/promises");
const path = require("node:path");
const express = require("express");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const dotenv = require("dotenv");

const { getTableName, withConnection } = require("./db");
const {
  exchangeCodeForToken,
  getPhoneNumberDetails,
  registerPhoneNumber,
  getWabaName,
  subscribeApps
} = require("./meta");

dotenv.config();

const app = express();

app.use(
  helmet({
    crossOriginOpenerPolicy: false,
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        "default-src": ["'self'"],
        "script-src": [
          "'self'",
          "'unsafe-inline'",
          "https://connect.facebook.net",
          "https://www.facebook.com",
          "https://web.facebook.com",
        ],
        "connect-src": [
          "'self'",
          "https://graph.facebook.com",
          "https://www.facebook.com",
          "https://web.facebook.com",
        ],
        "img-src": ["'self'", "data:", "https://www.facebook.com", "https://web.facebook.com"],
        "frame-src": ["'self'", "https://www.facebook.com", "https://web.facebook.com"],
      },
    },
  })
);

app.use(express.json({ limit: "1mb" }));
app.use("/public", express.static(path.join(__dirname, "..", "public")));

const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: Number(process.env.RATE_LIMIT_PER_MIN || 20),
  standardHeaders: true,
  legacyHeaders: false
});

const validateSessionToken = (session) => {
  if (!session || typeof session !== "string") {
    return false;
  }
  if (session.length < 10 || session.length > 64) {
    return false;
  }
  return /^[A-Za-z0-9_-]+$/.test(session);
};

const maskValue = (value, visible = 4) => {
  if (!value || typeof value !== "string") {
    return "";
  }
  if (value.length <= visible) {
    return "*".repeat(value.length);
  }
  return `${"*".repeat(value.length - visible)}${value.slice(-visible)}`;
};

const renderWppPage = async ({ session, valid }) => {
  const templatePath = path.join(__dirname, "views", "wpp.html");
  const template = await fs.readFile(templatePath, "utf8");

  if (!valid) {
    return template
      .replace("__FB_APP_ID__", "")
      .replace("__FB_CONFIG_ID__", "")
      .replace("__GRAPH_VERSION__", "v23.0")
      .replace("__SESSION__", "")
      .replace("__BASE_URL__", "")
      .replace(
        "Waiting to start…",
        "Invalid or expired link. Please request a new link."
      )
      .replace('id="embedded-signup"', 'id="embedded-signup" disabled');
  }

  return template
    .replace("__FB_APP_ID__", process.env.FB_APP_ID || "")
    .replace("__FB_CONFIG_ID__", process.env.FB_CONFIG_ID || "")
    .replace("__GRAPH_VERSION__", process.env.GRAPH_API_VERSION || "v23.0")
    .replace("__SESSION__", session)
    .replace("__BASE_URL__", process.env.BASE_URL || "");
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

  const table = getTableName("wa_configurations");
  const [rows] = await withConnection((connection) =>
    connection.query(
      `SELECT id, user_id, onboarding_status, onboarding_expires_at
       FROM ${table}
       WHERE onboarding_session = ?
         AND onboarding_status = 'pending'
         AND onboarding_expires_at > NOW()
       LIMIT 1`,
      [session]
    )
  );

  if (!rows || rows.length === 0) {
    const html = await renderWppPage({ session: "", valid: false });
    res.status(404).send(html);
    return;
  }

  const html = await renderWppPage({ session, valid: true });
  res.send(html);
});

app.post("/api/onboarding/complete", limiter, async (req, res) => {
  const { session, code, phone_number_id: phoneNumberId, waba_id: wabaId } =
    req.body || {};

  if (!validateSessionToken(session)) {
    res.status(400).json({
      ok: false,
      step: "validate_session",
      message: "Invalid or expired session."
    });
    return;
  }

  if (!code || !phoneNumberId || !wabaId) {
    res.status(400).json({
      ok: false,
      step: "validate_session",
      message: "Missing required onboarding fields."
    });
    return;
  }

  const table = getTableName("wa_configurations");
  const metaTable = getTableName("metausers");

  try {
    const result = await withConnection(async (connection) => {
      await connection.beginTransaction();

      const [sessionRows] = await connection.query(
        `SELECT id, user_id
         FROM ${table}
         WHERE onboarding_session = ?
           AND onboarding_status = 'pending'
           AND onboarding_expires_at > NOW()
         LIMIT 1
         FOR UPDATE`,
        [session]
      );

      if (!sessionRows || sessionRows.length === 0) {
        await connection.rollback();
        return {
          error: {
            status: 400,
            payload: {
              ok: false,
              step: "validate_session",
              message: "Invalid or expired session."
            }
          }
        };
      }

      const { id, user_id: userId } = sessionRows[0];

      if (process.env.ADMIN_WHITELIST) {
        try {
          const [limitRows] = await connection.query(
            `SELECT reached_limit FROM ${metaTable} WHERE user_id = ? LIMIT 1`,
            [userId]
          );
          const reachedLimit = limitRows?.[0]?.reached_limit;
          const whitelist = process.env.ADMIN_WHITELIST.split(",").map((val) =>
            val.trim()
          );
          if (reachedLimit === 1 && !whitelist.includes(String(userId))) {
            await connection.rollback();
            return {
              error: {
                status: 403,
                payload: {
                  ok: false,
                  step: "validate_session",
                  message: "limit reached"
                }
              }
            };
          }
        } catch (error) {
          if (error && error.code !== "ER_NO_SUCH_TABLE") {
            throw error;
          }
        }
      }

      const tokenPayload = await exchangeCodeForToken({ code }).catch((error) => {
        throw new Error(
          `exchange_code:${error?.response?.data?.error?.message || error.message}`
        );
      });
      const accessToken = tokenPayload.access_token;

      if (!accessToken) {
        throw new Error("exchange_code:missing_access_token");
      }

      const numberDetails = await getPhoneNumberDetails({
        phoneNumberId,
        accessToken
      }).catch((error) => {
        throw new Error(
          `verify_number:${error?.response?.data?.error?.message || error.message}`
        );
      });

      let status = "Successfully Connected to Whatsapp Coexistence";
      if (
        !numberDetails?.is_on_biz_app ||
        numberDetails?.platform_type !== "CLOUD_API"
      ) {
        const registerResult = await registerPhoneNumber({
          phoneNumberId,
          accessToken,
          pin: process.env.WA_REGISTER_PIN
        }).catch((error) => {
          throw new Error(
            `register_number:${error?.response?.data?.error?.message || error.message}`
          );
        });

        status = registerResult?.success
          ? "Successfully Connected to Whatsapp Cloud API"
          : "Error";
      }

      const wabaResponse = await getWabaName({ wabaId, accessToken }).catch(
        (error) => {
          throw new Error(
            `waba_name:${error?.response?.data?.error?.message || error.message}`
          );
        }
      );

      const wabaName = wabaResponse?.name || null;

      const webhookResponse = await subscribeApps({
        wabaId,
        accessToken
      }).catch((error) => {
        throw new Error(
          `subscribe_apps:${error?.response?.data?.error?.message || error.message}`
        );
      });

      const webhookStatus = webhookResponse?.success
        ? "Webhook subscription success"
        : "Webhook subscription failure";

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
          [accessToken, wabaId, status, wabaName, phoneNumberId]
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
          [accessToken, phoneNumberId, wabaId, status, wabaName, id]
        );

        if (!updateResult.affectedRows) {
          throw new Error("db_write:session_already_consumed");
        }
      }

      await connection.commit();

      return {
        payload: {
          ok: true,
          status,
          webhook_status: webhookStatus,
          waba_name: wabaName,
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
    const [step, detail] = message.includes(":")
      ? message.split(/:(.+)/)
      : ["unknown", message];

    if (step === "exchange_code") {
      console.error(`Exchange code failed: ${detail}`);
      res.status(502).json({
        ok: false,
        step: "exchange_code",
        message: "Failed to exchange code."
      });
      return;
    }
    if (step === "verify_number") {
      console.error(
        `Verify number failed (${maskValue(phoneNumberId)}): ${detail}`
      );
      res.status(502).json({
        ok: false,
        step: "verify_number",
        message: "Failed to verify phone number."
      });
      return;
    }
    if (step === "register_number") {
      console.error(
        `Register number failed (${maskValue(phoneNumberId)}): ${detail}`
      );
      res.status(502).json({
        ok: false,
        step: "register_number",
        message: "Failed to register phone number."
      });
      return;
    }
    if (step === "waba_name") {
      console.error(`WABA name failed (${maskValue(wabaId)}): ${detail}`);
      res.status(502).json({
        ok: false,
        step: "waba_name",
        message: "Failed to fetch WABA name."
      });
      return;
    }
    if (step === "subscribe_apps") {
      console.error(`Subscribe apps failed (${maskValue(wabaId)}): ${detail}`);
      res.status(502).json({
        ok: false,
        step: "subscribe_apps",
        message: "Failed to subscribe apps."
      });
      return;
    }
    if (step === "db_write") {
      console.error(`DB write failed: ${detail}`);
      res.status(409).json({
        ok: false,
        step: "db_write",
        message: "Session already consumed."
      });
      return;
    }

    console.error(`Unhandled onboarding error: ${detail}`);
    res.status(500).json({
      ok: false,
      step: "unknown",
      message: "Unexpected server error."
    });
  }
});

const port = Number(process.env.PORT || 3000);
app.listen(port, "0.0.0.0", () => {
  console.log(`Server listening on port ${port}`);
});
