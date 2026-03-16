const axios = require("axios");

const graphVersion = process.env.GRAPH_API_VERSION || "v23.0";
const graphBase = `https://graph.facebook.com/${graphVersion}`;

const exchangeCodeForToken = async ({ code }) => {
  const params = new URLSearchParams({
    client_id: process.env.FB_CLIENT_ID,
    client_secret: process.env.FB_CLIENT_SECRET,
    code: code,
    grant_type: "authorization_code"
  });

  const response = await axios.post(`${graphBase}/oauth/access_token`, params, {
    headers: { "Content-Type": "application/x-www-form-urlencoded" }
  });

  return response.data;
};

const getPhoneNumberDetails = async ({ phoneNumberId, accessToken }) => {
  const response = await axios.get(`${graphBase}/${phoneNumberId}`, {
    params: { fields: "is_on_biz_app,platform_type" },
    headers: { Authorization: `Bearer ${accessToken}` }
  });

  return response.data;
};

const registerPhoneNumber = async ({ phoneNumberId, accessToken, pin }) => {
  const response = await axios.post(
    `${graphBase}/${phoneNumberId}/register`,
    { messaging_product: "whatsapp", pin },
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );

  return response.data;
};

const getWabaName = async ({ wabaId, accessToken }) => {
  const response = await axios.get(`${graphBase}/${wabaId}`, {
    params: { fields: "name" },
    headers: { Authorization: `Bearer ${accessToken}` }
  });

  return response.data;
};

const subscribeApps = async ({ wabaId, accessToken }) => {
  const response = await axios.post(
    `${graphBase}/${wabaId}/subscribed_apps`,
    null,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );

  return response.data;
};

module.exports = {
  exchangeCodeForToken,
  getPhoneNumberDetails,
  registerPhoneNumber,
  getWabaName,
  subscribeApps
};
