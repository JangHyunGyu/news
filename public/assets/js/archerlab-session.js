(() => {
  'use strict';
  // The hub owns the visible account entry. Services only synchronize identity.
  if (location.hostname === 'archerlab.dev' || window.archerlabAccount) return;
  const services = ['game', 'nevergrad', 'karma', 'harem', 'cupid', 'chatbot', 'golf', 'itstory', 'news', 'chat'];
  const key = location.hostname.split('.')[0];
  if (location.hostname !== `${key}.archerlab.dev` || !services.includes(key)) return;
  const account = 'https://account.archerlab.dev';
  const sessionApi = `https://sessions.archerlab.dev/${key}`;
  let user = null;
  let pending = null;
  let resolveReady;
  const ready = new Promise(resolve => { resolveReady = resolve; });

  async function api(base, path, body) {
    const response = await fetch(base + path, {
      credentials: 'include', cache: 'no-store', signal: AbortSignal.timeout(8000),
      ...(body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {})
    });
    if (!response.ok) throw new Error('session_unavailable');
    return response.json();
  }
  function publish(member) {
    // Display identity is not a permission check. Servers must validate the HttpOnly session.
    user = member ? Object.freeze({ id: member.id, name: member.name }) : null;
    window.dispatchEvent(new CustomEvent('archerlab:session', { detail: user }));
  }
  async function synchronize() {
    try {
      // Guests need one background request and no service cookie or redirect.
      const central = await api(account, '/api/status', {});
      if (!central.user) { publish(null); return; }
      const local = await api(sessionApi, '/_account/session', {});
      if (local.user?.id === central.user.id) { publish(local.user); return; }
      const prepared = await api(sessionApi, '/_account/prepare', {
        csrf: local.csrf, returnPath: location.pathname + location.search + location.hash
      });
      const ticket = await api(account, '/api/sso', { csrf: central.csrf, request: prepared.request });
      await api(sessionApi, '/_account/complete', { csrf: local.csrf, request: prepared.request, code: ticket.code });
      publish((await api(sessionApi, '/_account/session', {})).user);
    } catch { publish(null); }
    finally {
      resolveReady(user);
      // Packed apps can clear listeners with document.open() during startup.
      bindEvents();
    }
  }
  function refresh() {
    if (!pending) pending = synchronize().finally(() => { pending = null; });
    return pending;
  }
  function visible() { if (document.visibilityState === 'visible') void refresh(); }
  function restored(event) { if (event.persisted) void refresh(); }
  function bindEvents() {
    document.addEventListener('visibilitychange', visible);
    window.addEventListener('pageshow', restored);
  }
  Object.defineProperty(window, 'archerlabAccount', {
    value: Object.freeze({ ready, refresh, get user() { return user; } }), configurable: true
  });
  let started = false;
  function start() {
    if (started) return;
    started = true;
    if ('requestIdleCallback' in window) window.requestIdleCallback(() => { void refresh(); }, { timeout: 2000 });
    else setTimeout(() => { void refresh(); }, 0);
  }
  // Auth never delays the page's first paint; the timer survives packed document replacement.
  window.addEventListener('load', start, { once: true });
  setTimeout(start, 2500);
  if (document.readyState === 'complete') start();
})();
