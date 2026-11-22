// Canvas (LTI 1.3) launches open the dashboard with a PlugLytics token in the URL
// fragment: /public/dashboard.html#lti_token=...
// Store it the same way a normal sign-in does, then remove it from the address bar.
// Loaded before app.js, which reads the stored token when it starts.
(function () {
  var match = /[#&]lti_token=([^&]+)/.exec(window.location.hash || "");
  if (!match) return;
  try {
    window.localStorage.setItem("pluglytics_token", decodeURIComponent(match[1]));
  } catch (error) {
    // Storage can be blocked inside a frame; the user can still sign in normally.
  }
  window.history.replaceState(null, "", window.location.pathname + window.location.search);
})();
