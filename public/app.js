(() => {
  const statusEl = document.getElementById("status");
  const buttonEl = document.getElementById("embedded-signup");

  const state = {
    code: null,
    phoneNumberId: null,
    wabaId: null,
    submitting: false
  };

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
    } catch (error) {
      setStatus("Unexpected error. Please retry.", "error");
      state.submitting = false;
      buttonEl.disabled = false;
    }
  };

  window.fbAsyncInit = function () {
    window.FB.init({
      appId: window.__APP_CONFIG__.appId,
      autoLogAppEvents: true,
      xfbml: true,
      version: window.__APP_CONFIG__.graphVersion
    });
  };

  const fbLoginCallback = (response) => {
    const auth = response && response.authResponse;
    if (auth && auth.code) {
      state.code = auth.code;
      setStatus("Facebook auth complete. Waiting for WhatsApp data…");
      validateAndSubmit();
    } else {
      setStatus("Facebook login was cancelled or failed.", "error");
    }
  };

  const launchEmbeddedSignup = () => {
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

  buttonEl.addEventListener("click", launchEmbeddedSignup);

  const allowedOrigins = new Set([
    "https://www.facebook.com",
    "https://web.facebook.com"
  ]);

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
})();
