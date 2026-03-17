// External HTTP client for Meta/Instagram Graph calls.
const crypto = require("node:crypto");
const axios = require("axios");

const graphVersion = process.env.GRAPH_API_VERSION || "v23.0";
const graphBase = `https://graph.facebook.com/${graphVersion}`;

// Creates appsecret_proof for Instagram Graph requests using app secret.
const createAppSecretProof = ({ accessToken, appSecret }) => {
  if (!accessToken || !appSecret) return null;
  return crypto.createHmac("sha256", appSecret).update(accessToken).digest("hex");
};

// Signs an OAuth state payload and attaches iat/exp timestamps.
const createSignedState = ({ payload, secret, ttlMs = 10 * 60 * 1000 }) => {
  const now = Date.now();
  const body = {
    ...payload,
    iat: now,
    exp: now + ttlMs
  };
  const encoded = Buffer.from(JSON.stringify(body)).toString("base64url");
  const signature = crypto
    .createHmac("sha256", secret || "fallback-secret")
    .update(encoded)
    .digest("base64url");

  return `${encoded}.${signature}`;
};

// Verifies signed OAuth state and validates expiry.
const parseSignedState = ({ state, secret }) => {
  if (!state || typeof state !== "string" || !state.includes(".")) return null;
  const [encoded, signature] = state.split(".");
  const expected = crypto
    .createHmac("sha256", secret || "fallback-secret")
    .update(encoded)
    .digest("base64url");

  if (signature !== expected) return null;

  try {
    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    if (!payload.exp || Date.now() > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
};


// Keep WhatsApp helpers intact
// WhatsApp: exchanges embedded signup authorization code for access token.
const exchangeCodeForToken = async ({ code }) => {
  const params = new URLSearchParams({
    client_id: process.env.FB_CLIENT_ID,
    client_secret: process.env.FB_CLIENT_SECRET,
    code,
    grant_type: "authorization_code"
  });

  const response = await axios.post(`${graphBase}/oauth/access_token`, params, {
    headers: { "Content-Type": "application/x-www-form-urlencoded" }
  });

  return response.data;
};

// WhatsApp: reads phone number coexistence/platform details.
const getPhoneNumberDetails = async ({ phoneNumberId, accessToken }) => {
  const response = await axios.get(`${graphBase}/${phoneNumberId}`, {
    params: { fields: "is_on_biz_app,platform_type" },
    headers: { Authorization: `Bearer ${accessToken}` }
  });

  return response.data;
};

// WhatsApp: registers phone number for Cloud API when needed.
const registerPhoneNumber = async ({ phoneNumberId, accessToken, pin }) => {
  const response = await axios.post(
    `${graphBase}/${phoneNumberId}/register`,
    { messaging_product: "whatsapp", pin },
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );

  return response.data;
};

// WhatsApp: fetches WABA display name.
const getWabaName = async ({ wabaId, accessToken }) => {
  const response = await axios.get(`${graphBase}/${wabaId}`, {
    params: { fields: "name" },
    headers: { Authorization: `Bearer ${accessToken}` }
  });

  return response.data;
};

// WhatsApp: subscribes app/webhook to WABA.
const subscribeApps = async ({ wabaId, accessToken }) => {
  const response = await axios.post(
    `${graphBase}/${wabaId}/subscribed_apps`,
    null,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );

  return response.data;
};

// New helpers for Instagram/Facebook OAuth
// Facebook OAuth: exchanges callback code for user token.
const exchangeOAuthCodeForToken = async ({ code, redirectUri }) => {
  const params = new URLSearchParams({
    client_id: process.env.FB_CLIENT_ID,
    client_secret: process.env.FB_CLIENT_SECRET,
    code,
    grant_type: "authorization_code",
    redirect_uri: redirectUri
  });

  const response = await axios.post(`${graphBase}/oauth/access_token`, params, {
    headers: { "Content-Type": "application/x-www-form-urlencoded" }
  });

  return response.data;
};

// Facebook Graph: gets basic user profile for connected account.
const getFacebookMe = async ({ accessToken }) => {
  const response = await axios.get(`${graphBase}/me`, {
    params: { fields: "id,name" },
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  return response.data;
};

// Facebook Graph: gets pages and attached Instagram business accounts.
const getFacebookAccountsWithInstagram = async ({ accessToken }) => {
  const response = await axios.get(`${graphBase}/me/accounts`, {
    params: { fields: "id,name,instagram_business_account{id,username,account_type}" },
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  return response.data;
};

// Facebook Graph: gets manageable pages and permissions.
const getFacebookPagesForUser = async ({ accessToken }) => {
  const response = await axios.get(`${graphBase}/me/accounts`, {
    params: { fields: "id,name,access_token,perms" },
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  return response.data;
};

// Instagram Professional OAuth: exchanges code for IG access token.
const exchangeInstagramCodeForToken = async ({ code, redirectUri }) => {
  const params = new URLSearchParams({
    client_id: process.env.IG_APP_ID || process.env.FB_APP_ID,
    client_secret: process.env.IG_APP_SECRET || process.env.FB_CLIENT_SECRET,
    grant_type: "authorization_code",
    redirect_uri: redirectUri,
    code
  });

  const response = await axios.post("https://api.instagram.com/oauth/access_token", params, {
    headers: { "Content-Type": "application/x-www-form-urlencoded" }
  });

  return response.data;
};

// Instagram Graph: fetches professional account identity using token (+ appsecret_proof).
const getInstagramMe = async ({ accessToken }) => {
  const instagramSecret = process.env.IG_APP_SECRET || process.env.FB_CLIENT_SECRET;
  const appSecretProof = createAppSecretProof({ accessToken, appSecret: instagramSecret });

  const response = await axios.get("https://graph.instagram.com/me", {
    params: {
      fields: "id,username,account_type",
      access_token: accessToken,
      appsecret_proof: appSecretProof || undefined
    }
  });

  return response.data;
};

module.exports = {
  exchangeCodeForToken,
  getPhoneNumberDetails,
  registerPhoneNumber,
  getWabaName,
  subscribeApps,
  exchangeOAuthCodeForToken,
  getFacebookMe,
  getFacebookAccountsWithInstagram,
  getFacebookPagesForUser,
  exchangeInstagramCodeForToken,
  getInstagramMe,
  createSignedState,
  parseSignedState
};
