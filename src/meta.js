const axios = require("axios");

const graphVersion = process.env.GRAPH_API_VERSION || "v23.0";
const graphBase = `https://graph.facebook.com/${graphVersion}`;

const exchangeCodeForToken = async ({ code, redirectUri }) => {
  const params = new URLSearchParams({
    client_id: process.env.FB_CLIENT_ID,
    client_secret: process.env.FB_CLIENT_SECRET,
    code,
    grant_type: "authorization_code",
    redirect_uri: redirectUri || process.env.FB_REDIRECT_URI
  });

  const response = await axios.post(`${graphBase}/oauth/access_token`, params, {
    headers: { "Content-Type": "application/x-www-form-urlencoded" }
  });

  return response.data;
};

const graphGet = async (path, { accessToken, params } = {}) => {
  const response = await axios.get(`${graphBase}${path}`, {
    params,
    headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : undefined
  });
  return response.data;
};

const graphPost = async (path, { accessToken, body, params } = {}) => {
  const response = await axios.post(`${graphBase}${path}`, body || null, {
    params,
    headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : undefined
  });
  return response.data;
};

const getPhoneNumberDetails = async ({ phoneNumberId, accessToken }) =>
  graphGet(`/${phoneNumberId}`, {
    accessToken,
    params: { fields: "is_on_biz_app,platform_type" }
  });

const registerPhoneNumber = async ({ phoneNumberId, accessToken, pin }) =>
  graphPost(`/${phoneNumberId}/register`, {
    accessToken,
    body: { messaging_product: "whatsapp", pin }
  });

const getWabaName = async ({ wabaId, accessToken }) =>
  graphGet(`/${wabaId}`, {
    accessToken,
    params: { fields: "name" }
  });

const subscribeApps = async ({ wabaId, accessToken }) =>
  graphPost(`/${wabaId}/subscribed_apps`, { accessToken });

module.exports = {
  exchangeCodeForToken,
  graphGet,
  graphPost,
  getPhoneNumberDetails,
  registerPhoneNumber,
  getWabaName,
  subscribeApps
};
