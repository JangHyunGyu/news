// news SEO 생성기 — ko only, 3 pages
const fs = require('fs'); const path = require('path');
const SITE = 'https://news.archerlab.dev'; const HOME = '/hn';
const PAGES = [
  { slug:'hackernews-korean', h1:'해커뉴스 한국어 요약 — 매일 자동 번역', title:'해커뉴스 한국어 요약 | 매일 HN 탑10 자동 번역', meta:'Hacker News 탑10 기사를 매일 한국어로 요약. 영어 부담 없이 글로벌 IT 트렌드를 5분 안에 따라잡으세요.', intro:'"해커뉴스 한국어"로 검색하면 대부분 사람이 직접 번역한 옛날 글이 나옵니다. 여기는 매일 자동 업데이트되는 HN 탑10 한국어 요약입니다.' },
  { slug:'developer-news-korea', h1:'개발자 뉴스 추천 — 5분 안에 글로벌 IT 트렌드', title:'개발자 뉴스 추천 | 매일 5분 글로벌 IT 트렌드 따라잡기', meta:'한국 개발자가 5분 만에 글로벌 IT 트렌드를 파악할 수 있는 뉴스 큐레이션. Hacker News 탑10을 한국어 요약으로.', intro:'개발자 뉴스가 부족한 게 아니라, 정리된 게 부족합니다. 매일 글로벌 1순위 토픽 10개만 한국어로 5분 안에.' },
  { slug:'it-news-summary', h1:'IT 뉴스 요약 — 매일 한국어로 자동', title:'IT 뉴스 요약 | 매일 한국어 자동 큐레이션', meta:'매일 자동으로 정리되는 IT 뉴스 한국어 요약. Hacker News 탑10 기반, 광고 없이 깔끔하게.', intro:'"IT 뉴스 요약" 서비스는 많지만 대부분 광고로 도배되거나 업데이트가 멈춰 있습니다. 여기는 매일 자동, 광고 없이.' }
];
const C = {
  why_title:'왜 여기인가',
  why:['매일 새벽 자동 업데이트 — 사람이 직접 큐레이션 안 해도 신선함','전체 한국어 요약 — 영어 본문 안 봐도 핵심 파악','광고·트래커 없음 — 깔끔한 가독성','원문 링크 1클릭 — 더 깊게 보고 싶을 때 바로'],
  how_title:'사용법',
  how:['아래 [지금 보기] 클릭','오늘의 HN 탑10 한국어 요약 확인','관심 있는 글은 원문 링크로 이동'],
  faq_title:'자주 묻는 질문',
  faqs:[
    ['업데이트 주기는?','매일 새벽 자동으로 HN 탑10을 가져와 한국어로 요약합니다.'],
    ['번역 품질은?','LLM 기반 자동 요약으로, 핵심 내용 파악 용도로는 충분합니다. 원문 링크가 함께 제공되어 정확도가 중요한 경우 바로 확인 가능합니다.'],
    ['모바일에서도 잘 보이나요?','네. 모바일 우선으로 디자인되어 있어 출퇴근 5분에 보기 좋습니다.']
  ],
  picks_title:'추천',
  main_name:'HN 탑10 한국어',
  main_desc:'매일 새벽 자동으로 업데이트되는 Hacker News 탑10 한국어 요약. 광고 없음, 가입 없음.',
  cta:'지금 보기 →',
  footer:'© news.archerlab.dev — 매일 한국어 IT 뉴스'
};

const CSS = `*{box-sizing:border-box;margin:0;padding:0}body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Arial,"Noto Sans KR",sans-serif;line-height:1.65;color:#1a1a2a;background:linear-gradient(180deg,#fff7e6 0%,#fff 40%);min-height:100vh}.wrap{max-width:760px;margin:0 auto;padding:32px 20px 80px}h1{font-size:28px;line-height:1.3;margin:24px 0 16px;color:#e65100;text-align:center}h2{font-size:20px;margin:36px 0 12px;color:#bf360c;border-bottom:2px solid #ffe0b2;padding-bottom:6px}p{margin-bottom:14px}ul{margin:12px 0 18px 22px}li{margin-bottom:8px}.intro{font-size:17px;color:#444;background:#fff;border-left:4px solid #ff9800;padding:14px 18px;border-radius:6px;margin:18px 0}.cta-box{text-align:center;margin:36px 0;padding:28px 20px;background:linear-gradient(135deg,#ff9800,#e65100);border-radius:14px}.cta{display:inline-block;background:#fff;color:#e65100;font-weight:700;font-size:18px;padding:14px 32px;border-radius:50px;text-decoration:none}.pick{background:#fff;border:1px solid #ffe0b2;border-radius:10px;padding:16px;margin-bottom:14px}.pick h3{font-size:17px;color:#e65100;margin-bottom:6px}.pick p{font-size:14px;color:#555}.faq{margin-bottom:14px}.faq summary{cursor:pointer;font-weight:600;padding:10px 0}.faq p{padding:6px 0;color:#555;font-size:15px}footer{margin-top:48px;padding-top:20px;border-top:1px solid #ffe0b2;text-align:center;font-size:13px;color:#888}@media(max-width:520px){h1{font-size:23px}h2{font-size:18px}.cta{font-size:16px;padding:12px 26px}}`;

const esc = s => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

function render(p) {
  const url = `${SITE}/seo/${p.slug}.html`;
  const faqLd = {"@context":"https://schema.org","@type":"FAQPage","mainEntity":C.faqs.map(([q,a])=>({"@type":"Question","name":q,"acceptedAnswer":{"@type":"Answer","text":a}}))};
  return `<!DOCTYPE html>
<html lang="ko"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(p.title)}</title><meta name="description" content="${esc(p.meta)}">
<link rel="canonical" href="${url}">
<meta property="og:title" content="${esc(p.title)}"><meta property="og:description" content="${esc(p.meta)}"><meta property="og:url" content="${url}"><meta property="og:type" content="website">
<style>${CSS}</style>
<script type="application/ld+json">${JSON.stringify(faqLd)}</script>
</head><body><div class="wrap">
<h1>${esc(p.h1)}</h1>
<p class="intro">${esc(p.intro)}</p>
<div class="cta-box"><a class="cta" href="${HOME}">${esc(C.cta)}</a></div>
<h2>${esc(C.why_title)}</h2><ul>${C.why.map(w=>`<li>${esc(w)}</li>`).join('')}</ul>
<h2>${esc(C.picks_title)}</h2>
<div class="pick"><h3>${esc(C.main_name)}</h3><p>${esc(C.main_desc)}</p></div>
<h2>${esc(C.how_title)}</h2><ul>${C.how.map(h=>`<li>${esc(h)}</li>`).join('')}</ul>
<div class="cta-box"><a class="cta" href="${HOME}">${esc(C.cta)}</a></div>
<h2>${esc(C.faq_title)}</h2>
${C.faqs.map(([q,a])=>`<details class="faq"><summary>${esc(q)}</summary><p>${esc(a)}</p></details>`).join('')}
<footer>${esc(C.footer)}</footer>
</div></body></html>`;
}

const OUT_DIR = path.join(__dirname, '..', 'public', 'seo');
fs.mkdirSync(OUT_DIR, { recursive: true });
let n=0;
for (const p of PAGES) { fs.writeFileSync(path.join(OUT_DIR, `${p.slug}.html`), render(p), 'utf8'); n++; }
console.log(`✓ ${n} pages generated`);
const frag = PAGES.map(p=>`  <url><loc>${SITE}/seo/${p.slug}.html</loc><changefreq>monthly</changefreq><priority>0.7</priority></url>`).join('\n');
fs.writeFileSync(path.join(__dirname, '_sitemap_fragment.xml'), frag, 'utf8');
console.log('✓ sitemap fragment written');
