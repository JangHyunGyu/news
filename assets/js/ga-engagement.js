(function () {
  "use strict";

  if (window.__gaEngagementTrackerInstalled) {
    return;
  }
  window.__gaEngagementTrackerInstalled = true;

  var HEARTBEAT_MS = 15000;
  var MIN_FLUSH_MS = 1000;
  var activeSince = 0;
  var pendingMs = 0;
  var totalVisibleMs = 0;
  var sequence = 0;
  var isFocused = typeof document.hasFocus === "function" ? document.hasFocus() : true;

  function now() {
    return Date.now();
  }

  function isVisible() {
    return !document.visibilityState || document.visibilityState === "visible";
  }

  function isActive() {
    return isVisible() && isFocused;
  }

  function startActive(timestamp) {
    if (!activeSince) {
      activeSince = timestamp || now();
    }
  }

  function collectActive(timestamp) {
    if (!activeSince) {
      return;
    }
    var current = timestamp || now();
    var delta = Math.max(0, current - activeSince);
    activeSince = current;
    pendingMs += delta;
    totalVisibleMs += delta;
  }

  function stopActive(timestamp) {
    collectActive(timestamp);
    activeSince = 0;
  }

  function sendEngagement(reason, force) {
    var current = now();
    if (isActive()) {
      collectActive(current);
    }
    var duration = Math.round(pendingMs);
    if (duration <= 0 || (!force && duration < MIN_FLUSH_MS)) {
      return;
    }
    if (typeof window.gtag !== "function") {
      return;
    }
    pendingMs = 0;
    sequence += 1;
    try {
      window.gtag("event", "accurate_engagement_time", {
        engagement_time_msec: duration,
        visible_time_msec: duration,
        visible_time_total_msec: Math.round(totalVisibleMs),
        engagement_sequence: sequence,
        engagement_reason: reason || "heartbeat",
        transport_type: "beacon"
      });
    } catch (error) {
      pendingMs += duration;
      sequence -= 1;
    }
  }

  function refreshActiveState() {
    if (isActive()) {
      startActive();
      return;
    }
    stopActive();
    sendEngagement(isVisible() ? "blur" : "hidden", true);
  }

  setInterval(function () {
    if (isActive()) {
      sendEngagement("heartbeat", false);
    } else {
      refreshActiveState();
    }
  }, HEARTBEAT_MS);

  window.addEventListener("focus", function () {
    isFocused = true;
    refreshActiveState();
  }, true);

  window.addEventListener("blur", function () {
    isFocused = false;
    refreshActiveState();
  }, true);

  document.addEventListener("visibilitychange", refreshActiveState, true);

  window.addEventListener("pagehide", function () {
    stopActive();
    sendEngagement("pagehide", true);
  }, true);

  window.addEventListener("beforeunload", function () {
    stopActive();
    sendEngagement("beforeunload", true);
  }, true);

  window.addEventListener("pageshow", function () {
    isFocused = typeof document.hasFocus === "function" ? document.hasFocus() : true;
    refreshActiveState();
  }, true);

  if (typeof document.addEventListener === "function") {
    document.addEventListener("freeze", function () {
      stopActive();
      sendEngagement("freeze", true);
    }, true);
  }

  refreshActiveState();
})();
