(() => {
  const statusEl = document.getElementById("status");
  const whatsappBtn = document.getElementById("embedded-signup");
  const instagramBtn = document.getElementById("instagram-connect");
  const facebookBtn = document.getElementById("facebook-connect");

  const channelStatusEls = {
    whatsapp: document.getElementById("status-whatsapp"),
    instagram: document.getElementById("status-instagram"),
    facebook: document.getElementById("status-facebook")
  };


  const state = {
    code: null,
    phoneNumberId: null,
    wabaId: null,
    submittingWhatsApp: false,
    connectingSocial: false
  };

  let fbSdkReady = false;

  const initFacebookSdk = () => {
    if (fbSdkReady || !window.FB) return;
    window.FB.init({
      appId: window.__APP_CONFIG__.appId,
      autoLogAppEvents: true,
      xfbml: true,
      version: window.__APP_CONFIG__.graphVersion
    });
    fbSdkReady = true;
  };

  const statusMap = {
    not_connected: { text: "Not connected", className: "" },
    pending: { text: "Not connected", className: "" },
    connecting: { text: "Connecting", className: "connecting" },
    connected: { text: "Connected", className: "connected" },
    error: { text: "Error", className: "error" }
  };

  const setStatus = (message, type) => {
    statusEl.textContent = message;
    statusEl.classList.remove("status-success", "status-error");
    if (type === "success") statusEl.classList.add("status-success");
    if (type === "error") statusEl.classList.add("status-error");
  };

  const setChannelStatus = (channel, status, extraText) => {
    const target = channelStatusEls[channel];
    if (!target) return;
    const normalized = statusMap[status] ? status : "not_connected";
    const mapped = statusMap[normalized];
    target.classList.remove("connected", "error", "connecting");
    if (mapped.className) target.classList.add(mapped.className);
    target.textContent = extraText ? `${mapped.text}: ${extraText}` : mapped.text;
  };

  const query = new URLSearchParams(window.location.search);
  const callbackProvider = query.get("provider");
  const callbackStatus = query.get("status");

  if (callbackProvider && callbackStatus === "connected") {
    setStatus(`${callbackProvider} connected successfully ✅`, "success");
  } else if (callbackProvider && callbackStatus === "error") {
    setStatus(`${callbackProvider} connection failed. Please retry.`, "error");
  }

  const refreshConnectionState = async () => {
    try {
      const response = await fetch(`/api/connections/state?session=${encodeURIComponent(window.__APP_CONFIG__.session)}`);
      const data = await response.json();
      if (!response.ok || !data.ok) return;

      setChannelStatus("whatsapp", data.whatsapp?.status || "not_connected");
      setChannelStatus(
        "instagram",
        data.instagram?.status || "not_connected",
        data.instagram?.label || ""
      );
      setChannelStatus(
        "facebook",
        data.facebook?.status || "not_connected",
        data.facebook?.label || ""
      );
    } catch {
      // best effort state refresh
    }
  };

  const validateAndSubmitWhatsApp = async () => {
    if (!state.code || !state.phoneNumberId || !state.wabaId || state.submittingWhatsApp) return;

    state.submittingWhatsApp = true;
    whatsappBtn.disabled = true;
    setChannelStatus("whatsapp", "connecting");
    setStatus("Completing WhatsApp onboarding…");

    try {
      const response = await fetch("/api/onboarding/complete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session: window.__APP_CONFIG__.session,
          code: state.code,
          phone_number_id: state.phoneNumberId,
          waba_id: state.wabaId
        })
      });
      const data = await response.json();

      if (!response.ok || !data.ok) {
        setStatus(data.message || "WhatsApp onboarding failed. Please try again.", "error");
        setChannelStatus("whatsapp", "error");
        state.submittingWhatsApp = false;
        whatsappBtn.disabled = false;
        return;
      }

      setStatus("WhatsApp connected ✅", "success");
      setChannelStatus("whatsapp", "connected", data.waba_name || "");
    } catch {
      setStatus("Unexpected error. Please retry.", "error");
      setChannelStatus("whatsapp", "error");
      state.submittingWhatsApp = false;
      whatsappBtn.disabled = false;
    }
  };

  const startOAuth = async (provider) => {
    if (state.connectingSocial) return;
    state.connectingSocial = true;

    const btn = provider === "instagram" ? instagramBtn : facebookBtn;
    btn.disabled = true;
    setChannelStatus(provider, "connecting");

    try {
      const response = await fetch(
        `/api/oauth/${provider}/start?session=${encodeURIComponent(window.__APP_CONFIG__.session)}`
      );
      const data = await response.json();
      if (!response.ok || !data.ok || !data.auth_url) {
        throw new Error(data.message || "Unable to start auth");
      }
      window.location.href = data.auth_url;
    } catch (error) {
      setChannelStatus(provider, "error");
      setStatus(error.message || `Failed to start ${provider} connection`, "error");
      btn.disabled = false;
      state.connectingSocial = false;
    }
  };

  window.fbAsyncInit = function () {
    initFacebookSdk();
  };

  const fbLoginCallback = (response) => {
    const auth = response && response.authResponse;
    if (auth && auth.code) {
      state.code = auth.code;
      setStatus("Facebook auth complete. Waiting for WhatsApp data…");
      validateAndSubmitWhatsApp();
    } else {
      setStatus("Facebook login was cancelled or failed.", "error");
      setChannelStatus("whatsapp", "error");
    }
  };

  const launchEmbeddedSignup = () => {
    initFacebookSdk();
    if (!window.FB || !fbSdkReady) {
      setStatus("Facebook SDK is still loading. Please try again in a moment.", "error");
      return;
    }
    setChannelStatus("whatsapp", "connecting");
    setStatus("Launching WhatsApp Embedded Signup…");
    window.FB.login(fbLoginCallback, {
      config_id: window.__APP_CONFIG__.configId,
      response_type: "code",
      override_default_response_type: true,
      extras: {
        setup: {},
        featureType: "whatsapp_business_app_onboarding",
        sessionInfoVersion: "3"
      }
    });
  };

  whatsappBtn.addEventListener("click", launchEmbeddedSignup);
  instagramBtn.addEventListener("click", () => startOAuth("instagram"));
  facebookBtn.addEventListener("click", () => startOAuth("facebook"));

  const allowedOrigins = new Set(["https://www.facebook.com", "https://web.facebook.com"]);

  window.addEventListener("message", (event) => {
    if (!allowedOrigins.has(event.origin)) return;

    let payload;
    try {
      payload = typeof event.data === "string" ? JSON.parse(event.data) : event.data;
    } catch {
      return;
    }

    if (!payload || payload.type !== "WA_EMBEDDED_SIGNUP") return;

    const eventName = payload.event;
    if (eventName === "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING" || eventName === "FINISH") {
      const data = payload.data || {};
      state.phoneNumberId = data.phone_number_id;
      state.wabaId = data.waba_id;
      setStatus("WhatsApp data received. Completing onboarding…");
      validateAndSubmitWhatsApp();
    } else if (eventName === "CANCEL") {
      setStatus("WhatsApp signup cancelled.", "error");
      setChannelStatus("whatsapp", "error");
    } else if (eventName === "ERROR") {
      setStatus("WhatsApp signup error. Please retry.", "error");
      setChannelStatus("whatsapp", "error");
    }
  });

  initFacebookSdk();
  refreshConnectionState();
})();
