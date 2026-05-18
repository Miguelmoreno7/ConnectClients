// Frontend controller for onboarding UI (WhatsApp + Instagram + Facebook).
(() => {
  // Resolve DOM nodes used by channel connection actions and status text.
  const statusEl = document.getElementById("status");
  const buttonEl = document.getElementById("embedded-signup");
  const instagramButtonEl = document.getElementById("instagram-connect");
  const facebookButtonEl = document.getElementById("facebook-connect");
  const whatsappBadgeEl = document.getElementById("status-whatsapp");
  const instagramBadgeEl = document.getElementById("status-instagram");
  const facebookBadgeEl = document.getElementById("status-facebook");

  // Mutable state for WhatsApp embedded signup completion flow.
  const state = {
    code: null,
    phoneNumberId: null,
    wabaId: null,
    submitting: false,
    allowedChannels: {
      whatsapp: true,
      instagram: true,
      facebook: true
    }
  };

  // Updates main status message with optional success/error styling.
  const setStatus = (message, type) => {
    statusEl.textContent = message;
    statusEl.classList.remove("status-success", "status-error");
    if (type === "success") {
      statusEl.classList.add("status-success");
    }
    if (type === "error") {
      statusEl.classList.add("status-error");
    }
  };

  // Disables/enables a specific button while async action is in flight.
  const setButtonBusy = (button, busy) => {
    if (!button) return;
    button.disabled = busy;
  };

  const setBubble = (badge, text, cls) => {
    if (!badge) return;
    badge.textContent = text;
    badge.classList.remove("connected", "error", "connecting");
    if (cls) badge.classList.add(cls);
  };

  const applyProviderState = ({ provider, status: providerStatus, label, allowed = true }) => {
    const map = {
      instagram: { button: instagramButtonEl, badge: instagramBadgeEl },
      facebook: { button: facebookButtonEl, badge: facebookBadgeEl },
      whatsapp: { button: buttonEl, badge: whatsappBadgeEl }
    };

    const target = map[provider];
    if (!target) return;

    if (!allowed) {
      setBubble(target.badge, "Not allowed", "error");
      setButtonBusy(target.button, true);
      return;
    }

    if (providerStatus === "connected" || providerStatus === "completed") {
      setBubble(target.badge, label ? `Connected: ${label}` : "Connected", "connected");
      setButtonBusy(target.button, true);
      return;
    }

    if (providerStatus === "error" || providerStatus === "failed") {
      setBubble(target.badge, "Error", "error");
      setButtonBusy(target.button, false);
      return;
    }

    if (providerStatus === "connecting" || providerStatus === "pending") {
      setBubble(target.badge, "Connecting", "connecting");
      setButtonBusy(target.button, false);
      return;
    }

    setBubble(target.badge, "Not connected", null);
    setButtonBusy(target.button, false);
  };

  const refreshConnectionState = async () => {
    try {
      const response = await fetch(
        `/api/connections/state?session=${encodeURIComponent(window.__APP_CONFIG__.session)}`
      );
      const data = await response.json();
      if (!response.ok || !data.ok) return;

      state.allowedChannels = {
        whatsapp: data.allowed_channels?.whatsapp !== false,
        instagram: data.allowed_channels?.instagram !== false,
        facebook: data.allowed_channels?.facebook !== false
      };

      applyProviderState({
        provider: "instagram",
        status: data.instagram?.status,
        label: data.instagram?.label,
        allowed: state.allowedChannels.instagram
      });
      applyProviderState({
        provider: "facebook",
        status: data.facebook?.status,
        label: data.facebook?.label,
        allowed: state.allowedChannels.facebook
      });
      applyProviderState({
        provider: "whatsapp",
        status: data.whatsapp?.status,
        allowed: state.allowedChannels.whatsapp
      });
    } catch {
      // Best effort, keep UI defaults if state endpoint fails.
    }
  };

  // Sends WhatsApp completion request once code + WA IDs are available.
  const validateAndSubmit = async () => {
    if (
      !state.code ||
      !state.phoneNumberId ||
      !state.wabaId ||
      state.submitting
    ) {
      return;
    }

    state.submitting = true;
    buttonEl.disabled = true;
    setStatus("Completing onboarding…");

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
        const message = data.message || "Onboarding failed. Please try again.";
        setStatus(message, "error");
        state.submitting = false;
        buttonEl.disabled = false;
        return;
      }

      setStatus("Connected ✅", "success");
      applyProviderState({ provider: "whatsapp", status: "connected" });
    } catch (error) {
      setStatus("Unexpected error. Please retry.", "error");
      state.submitting = false;
      buttonEl.disabled = false;
    }
  };

  // Handles FB.login callback for WhatsApp embedded signup.
  const fbLoginCallback = (response) => {
    console.log("[FB.login callback]", response);

    const auth = response && response.authResponse;

    // En embedded signup, a veces el callback llega sin code aunque el popup siga/esté iniciando.
    // No lo trates como error inmediato.
    if (auth && auth.code) {
      state.code = auth.code;
      setStatus("Facebook auth complete. Waiting for WhatsApp data…");
      validateAndSubmit(); // esto solo debe enviar si ya tienes WA data también
      return;
    }

    // Si hay error explícito, sí muéstralo
    if (response && response.error) {
      setStatus(`Facebook login error: ${response.error.message || "Unknown"}`, "error");
      return;
    }

    // Si no hay code, solo informa y espera (no error)
    setStatus("Facebook popup opened. Complete the flow to continue…");
  };


  // Starts WhatsApp Embedded Signup popup flow.
  const launchEmbeddedSignup = () => {
    if (!state.allowedChannels.whatsapp) {
      setStatus("WhatsApp is not allowed for this onboarding link.", "error");
      return;
    }
    if (typeof window.initFacebookSDKOnce === "function") {
      window.initFacebookSDKOnce();
    }
    if (!window.FB) {
      setStatus("Facebook SDK not loaded yet.", "error");
      return;
    }
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

  // Starts OAuth flow for Instagram/Facebook via backend start endpoint.
  const startOAuthConnection = async (provider, button, label) => {
    if (!button) return;
    if (!state.allowedChannels[provider]) {
      setStatus(`${label} is not allowed for this onboarding link.`, "error");
      return;
    }
    try {
      setButtonBusy(button, true);
      setStatus(`Starting ${label} connection…`);
      applyProviderState({ provider, status: "connecting" });

      const response = await fetch(
        `/api/oauth/${provider}/start?session=${encodeURIComponent(window.__APP_CONFIG__.session)}`
      );
      const data = await response.json();

      if (!response.ok || !data.ok || !data.auth_url) {
        throw new Error(data.message || `Unable to start ${label} connection.`);
      }

      window.location.href = data.auth_url;
    } catch (error) {
      setStatus(error.message || `Failed to start ${label} connection.`, "error");
      setButtonBusy(button, false);
    }
  };

  buttonEl.addEventListener("click", launchEmbeddedSignup);

  if (instagramButtonEl) {
    instagramButtonEl.addEventListener("click", () =>
      startOAuthConnection("instagram", instagramButtonEl, "Instagram")
    );
  }

  if (facebookButtonEl) {
    facebookButtonEl.addEventListener("click", () =>
      startOAuthConnection("facebook", facebookButtonEl, "Facebook")
    );
  }

  const allowedOrigins = new Set([
    "https://www.facebook.com",
    "https://web.facebook.com"
  ]);

  // Listens for WA_EMBEDDED_SIGNUP postMessage events from FB origins.
  window.addEventListener("message", (event) => {
    if (!allowedOrigins.has(event.origin)) {
      return;
    }

    let payload;
    try {
      payload = typeof event.data === "string" ? JSON.parse(event.data) : event.data;
    } catch (error) {
      return;
    }

    if (!payload || payload.type !== "WA_EMBEDDED_SIGNUP") {
      return;
    }

    const eventName = payload.event;
    if (
      eventName === "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING" ||
      eventName === "FINISH"
    ) {
      const data = payload.data || {};
      state.phoneNumberId = data.phone_number_id;
      state.wabaId = data.waba_id;
      setStatus("WhatsApp data received. Completing onboarding…");
      validateAndSubmit();
    } else if (eventName === "CANCEL") {
      setStatus("Signup cancelled.", "error");
    } else if (eventName === "ERROR") {
      setStatus("Signup error. Please retry.", "error");
    }
  });

  // Reads callback query params to show user-friendly social connection result.
  const query = new URLSearchParams(window.location.search);
  const provider = query.get("provider");
  const status = query.get("status");
  if (provider && status === "connected") {
    setStatus(`${provider} connected successfully ✅`, "success");
    applyProviderState({ provider, status: "connected" });
  } else if (provider && status === "error") {
    setStatus(`${provider} connection failed. Please retry.`, "error");
    setButtonBusy(instagramButtonEl, false);
    setButtonBusy(facebookButtonEl, false);
    applyProviderState({ provider, status: "error" });
  }

  refreshConnectionState();
})();
