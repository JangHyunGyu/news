(function () {
  if (window.__NEWS_CLIENT_ERROR_REPORTER__) return;
  window.__NEWS_CLIENT_ERROR_REPORTER__ = true;

  var script = document.currentScript;
  var endpoint = (script && script.getAttribute('data-endpoint')) || '/api/client-errors';
  var appId = (script && script.getAttribute('data-app-id')) || 'news';
  var sent = 0;
  var seen = Object.create(null);
  var MAX_REPORTS_PER_PAGE = 20;

  function safeString(value, fallback) {
    if (value === undefined || value === null) return fallback || '';
    try {
      return String(value);
    } catch {
      return fallback || '';
    }
  }

  function stackFrom(value) {
    if (!value) return '';
    if (value.stack) return safeString(value.stack);
    if (value.error && value.error.stack) return safeString(value.error.stack);
    return '';
  }

  function reasonPayload(reason) {
    if (reason instanceof Error) {
      return {
        message: reason.message || reason.name || 'Unhandled promise rejection',
        stack: reason.stack || '',
        context: { name: reason.name || 'Error' }
      };
    }
    return {
      message: safeString(reason, 'Unhandled promise rejection'),
      stack: reason && reason.stack ? safeString(reason.stack) : '',
      context: { reason: safeString(reason, '') }
    };
  }

  function safeJson(value) {
    try {
      return JSON.stringify(value);
    } catch {
      value.context = { serialization_failed: true };
      return JSON.stringify(value);
    }
  }

  function post(payload) {
    if (sent >= MAX_REPORTS_PER_PAGE || !payload || !payload.message) return;
    if (
      payload.message === 'Script error.' &&
      !payload.stack &&
      !payload.source &&
      !payload.lineno &&
      !payload.colno
    ) {
      return;
    }

    var key = [
      payload.error_type || '',
      payload.message || '',
      payload.source || '',
      payload.lineno || 0,
      payload.colno || 0
    ].join('|');
    if (seen[key]) return;
    seen[key] = true;
    sent += 1;

    payload.app_id = appId;
    payload.url = window.location.href;
    payload.context = Object.assign({
      language: document.documentElement.lang || navigator.language || '',
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
        devicePixelRatio: window.devicePixelRatio || 1
      }
    }, payload.context || {});

    var body = safeJson(payload);
    try {
      if (navigator.sendBeacon) {
        var blob = new Blob([body], { type: 'application/json' });
        if (navigator.sendBeacon(endpoint, blob)) return;
      }
    } catch {}

    try {
      fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: body,
        keepalive: true
      }).catch(function () {});
    } catch {}
  }

  window.addEventListener('error', function (event) {
    var target = event && event.target;
    if (target && target !== window && target !== document) {
      post({
        error_type: 'resource_error',
        message: 'Failed to load resource: ' + safeString(target.tagName || target.nodeName, 'unknown'),
        source: target.currentSrc || target.src || target.href || '',
        lineno: 0,
        colno: 0,
        stack: '',
        context: { tag: target.tagName || target.nodeName || '' }
      });
      return;
    }

    post({
      error_type: 'error',
      message: safeString(event.message, 'Client script error'),
      source: event.filename || '',
      lineno: event.lineno || 0,
      colno: event.colno || 0,
      stack: stackFrom(event),
      context: event.error && event.error.name ? { name: event.error.name } : {}
    });
  }, true);

  window.addEventListener('unhandledrejection', function (event) {
    var details = reasonPayload(event.reason);
    post({
      error_type: 'unhandledrejection',
      message: details.message || 'Unhandled promise rejection',
      source: '',
      lineno: 0,
      colno: 0,
      stack: details.stack || '',
      context: details.context || {}
    });
  }, true);
})();
