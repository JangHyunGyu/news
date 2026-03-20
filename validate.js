const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
let errors = 0;
let passes = 0;

function check(condition, passMsg, failMsg) {
  if (condition) {
    console.log(`  \u2705 ${passMsg}`);
    passes++;
  } else {
    console.log(`  \u274C ${failMsg}`);
    errors++;
  }
}

function fileExists(relPath) {
  return fs.existsSync(path.join(ROOT, relPath));
}

function readFile(relPath) {
  return fs.readFileSync(path.join(ROOT, relPath), 'utf-8');
}

// ──────────────────────────────────────────────
//  1. Required files
// ──────────────────────────────────────────────
console.log('\n[1] Required Files');

const requiredFiles = [
  'src/index.js',
  'wrangler.toml',
  'schema.sql',
  'package.json',
  'package-lock.json',
  '.gitignore',
  'CNAME',
  'index.html',
  'public/index.html',
  'public/hn/index.html',
  'sitemap.xml',
  'robots.txt',
  'llms.txt',
];

for (const f of requiredFiles) {
  check(fileExists(f), `${f} exists`, `${f} MISSING`);
}

// ──────────────────────────────────────────────
//  2. wrangler.toml validation
// ──────────────────────────────────────────────
console.log('\n[2] wrangler.toml');

const wrangler = readFile('wrangler.toml');

check(
  /^name\s*=\s*".+"$/m.test(wrangler),
  'Has worker name',
  'Missing worker name'
);
check(
  /^main\s*=\s*"src\/index\.js"$/m.test(wrangler),
  'Entry point is src/index.js',
  'Entry point mismatch (expected src/index.js)'
);
check(
  /compatibility_date\s*=\s*"\d{4}-\d{2}-\d{2}"/.test(wrangler),
  'Has compatibility_date',
  'Missing compatibility_date'
);
check(
  /compatibility_flags\s*=\s*\[.*"nodejs_compat".*\]/.test(wrangler),
  'Has nodejs_compat flag',
  'Missing nodejs_compat compatibility flag'
);

// D1 database binding
check(
  /\[\[d1_databases\]\]/.test(wrangler),
  'Has [[d1_databases]] section',
  'Missing [[d1_databases]] section'
);
check(
  /binding\s*=\s*"DB"/.test(wrangler),
  'D1 binding name is "DB"',
  'D1 binding name is not "DB"'
);
check(
  /database_name\s*=\s*"[^"]+"/.test(wrangler),
  'D1 has database_name',
  'D1 missing database_name'
);
check(
  /database_id\s*=\s*"[0-9a-f-]+"/.test(wrangler),
  'D1 has database_id (UUID format)',
  'D1 missing or invalid database_id'
);

// Assets directory
check(
  /\[assets\]/.test(wrangler) && /directory\s*=\s*"\.\/public"/.test(wrangler),
  'Assets directory set to ./public',
  'Missing [assets] directory = "./public"'
);

// Cron triggers
check(
  /\[triggers\]/.test(wrangler) && /crons\s*=/.test(wrangler),
  'Has cron trigger configured',
  'Missing cron trigger configuration'
);

// SITE_URL var
check(
  /\[vars\]/.test(wrangler) && /SITE_URL/.test(wrangler),
  'Has SITE_URL environment variable',
  'Missing SITE_URL variable'
);

// ──────────────────────────────────────────────
//  3. schema.sql validation
// ──────────────────────────────────────────────
console.log('\n[3] schema.sql');

const schema = readFile('schema.sql');

check(
  /CREATE TABLE/i.test(schema),
  'Has CREATE TABLE statement',
  'Missing CREATE TABLE statement'
);
check(
  /CREATE TABLE\s+(IF NOT EXISTS\s+)?news/i.test(schema),
  'Creates "news" table',
  'Missing "news" table definition'
);

// Required columns
const requiredColumns = ['hn_id', 'date', 'rank', 'original_title', 'translated_title', 'summary', 'url', 'score'];
for (const col of requiredColumns) {
  check(
    new RegExp(`\\b${col}\\b`, 'i').test(schema),
    `Column "${col}" defined`,
    `Column "${col}" MISSING from schema`
  );
}

// Indexes
check(
  /CREATE\s+(UNIQUE\s+)?INDEX/i.test(schema),
  'Has index definitions',
  'Missing index definitions'
);
check(
  /idx_news_date\b/.test(schema),
  'Has idx_news_date index',
  'Missing idx_news_date index'
);
check(
  /idx_news_date_rank\b/.test(schema),
  'Has idx_news_date_rank unique index',
  'Missing idx_news_date_rank index'
);

// ──────────────────────────────────────────────
//  4. src/index.js entry point
// ──────────────────────────────────────────────
console.log('\n[4] src/index.js');

const srcIndex = readFile('src/index.js');

check(
  srcIndex.includes('export default') || srcIndex.includes('module.exports'),
  'Has module export (Worker entry)',
  'Missing module export'
);
check(
  srcIndex.includes('fetch'),
  'Handles fetch requests',
  'No fetch handler found'
);
check(
  /scheduled|cron/i.test(srcIndex),
  'Has scheduled/cron handler',
  'Missing scheduled/cron handler'
);
check(
  /env\.DB|env\["DB"\]/.test(srcIndex),
  'References D1 database (env.DB)',
  'No D1 database reference found'
);
check(
  /hacker-news|firebaseio/.test(srcIndex),
  'References Hacker News API',
  'No Hacker News API reference found'
);
check(
  /gemini|GEMINI/i.test(srcIndex),
  'References Gemini AI for translation',
  'No Gemini AI reference found'
);

// ──────────────────────────────────────────────
//  5. package.json validation
// ──────────────────────────────────────────────
console.log('\n[5] package.json');

const pkg = JSON.parse(readFile('package.json'));

check(
  typeof pkg.name === 'string' && pkg.name.length > 0,
  `Package name: ${pkg.name}`,
  'Missing package name'
);
check(
  pkg.main === 'src/index.js',
  'main points to src/index.js',
  `main is "${pkg.main}" (expected src/index.js)`
);

// Scripts
check(
  pkg.scripts && pkg.scripts.dev,
  `dev script: "${pkg.scripts?.dev}"`,
  'Missing dev script'
);
check(
  pkg.scripts && pkg.scripts.deploy,
  `deploy script: "${pkg.scripts?.deploy}"`,
  'Missing deploy script'
);
check(
  pkg.scripts?.dev?.includes('wrangler dev'),
  'dev script uses wrangler dev',
  'dev script does not use wrangler dev'
);
check(
  pkg.scripts?.deploy?.includes('wrangler deploy'),
  'deploy script uses wrangler deploy',
  'deploy script does not use wrangler deploy'
);

// D1 init script
check(
  pkg.scripts && pkg.scripts['db:init'],
  `db:init script: "${pkg.scripts?.['db:init']}"`,
  'Missing db:init script'
);

// Dependencies
check(
  (pkg.devDependencies && pkg.devDependencies.wrangler) ||
    (pkg.dependencies && pkg.dependencies.wrangler),
  'wrangler is a dependency',
  'wrangler not found in dependencies'
);

// ──────────────────────────────────────────────
//  6. CNAME
// ──────────────────────────────────────────────
console.log('\n[6] CNAME');

const cname = readFile('CNAME').trim();
check(cname.length > 0, `CNAME has value: ${cname}`, 'CNAME is empty');
check(
  /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(cname),
  'CNAME is valid domain format',
  `CNAME has invalid format: "${cname}"`
);

// ──────────────────────────────────────────────
//  7. robots.txt & sitemap.xml
// ──────────────────────────────────────────────
console.log('\n[7] robots.txt & sitemap.xml');

const robots = readFile('robots.txt');
check(
  robots.includes('User-agent:'),
  'robots.txt has User-agent directive',
  'robots.txt missing User-agent'
);
check(
  /Sitemap:\s*https?:\/\//.test(robots),
  'robots.txt has Sitemap directive',
  'robots.txt missing Sitemap directive'
);

const sitemap = readFile('sitemap.xml');
check(
  sitemap.includes('<?xml') && sitemap.includes('<urlset'),
  'sitemap.xml has valid XML structure',
  'sitemap.xml invalid structure'
);
check(
  sitemap.includes('<loc>'),
  'sitemap.xml has <loc> entries',
  'sitemap.xml has no <loc> entries'
);

// ──────────────────────────────────────────────
//  Summary
// ──────────────────────────────────────────────
console.log('\n' + '='.repeat(50));
console.log(`NEWS validation: ${passes} passed, ${errors} failed`);
console.log('='.repeat(50));

if (errors > 0) {
  process.exit(1);
}
