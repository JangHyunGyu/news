const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

function getToken() {
  if (process.env.CLOUDFLARE_API_TOKEN) return process.env.CLOUDFLARE_API_TOKEN;
  const candidates = [
    process.env.APPDATA && path.join(process.env.APPDATA, 'xdg.config/.wrangler/config/default.toml'),
    path.join(os.homedir(), '.config/.wrangler/config/default.toml'),
    path.join(os.homedir(), '.wrangler/config/default.toml'),
  ].filter(Boolean);
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    const token = fs.readFileSync(file, 'utf8').match(/^oauth_token\s*=\s*"([^"]+)"/m)?.[1];
    if (token) return token;
  }
  throw new Error('Set CLOUDFLARE_API_TOKEN or log in with Wrangler');
}

async function main() {
  const token = getToken();
  async function api(endpoint, method = 'GET', body) {
    const response = await fetch(`https://api.cloudflare.com/client/v4${endpoint}`, {
      method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const result = await response.json();
    if (!response.ok || !result.success) throw new Error(JSON.stringify(result.errors));
    return result.result;
  }
  let account = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!account) {
    const accounts = await api('/accounts');
    if (accounts.length !== 1) throw new Error('Set CLOUDFLARE_ACCOUNT_ID for the news account');
    account = accounts[0].id;
  }
  const base = `/accounts/${account}/workers/scripts/news`;
  const settings = await api(`${base}/settings`);
  if (!settings.bindings.some(binding => binding.type === 'd1' && (binding.id || binding.database_id) === '4ecff3c0-3def-418e-9861-db758727140e')) {
    throw new Error('Legacy worker database does not match hn-news-db');
  }
  const before = await api(`${base}/schedules`);
  await api(`${base}/schedules`, 'PUT', []);
  const after = await api(`${base}/schedules`);
  if (after.schedules.length) throw new Error('Legacy cron is still enabled');
  console.log(JSON.stringify({ worker: 'news', before, after }));
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
