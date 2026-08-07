# HN 탑10 — news.archerlab.dev

Hacker News 탑10 기사를 매일 한국어로 번역해서 보여주는 서비스.

- **URL**: https://news.archerlab.dev
- **백엔드**: Cloudflare Workers + D1
- **번역**: OpenRouter 무료 Nemotron 3 Ultra → OpenRouter DeepSeek V4 0731 폴백 체인
- **스케줄**: 매일 밤 11시(KST) 자동 업데이트

## 배포 방법

### 1. D1 데이터베이스 생성
```bash
npx wrangler d1 create hn-news-db
```
출력된 `database_id`를 `wrangler.toml`의 `database_id`에 입력.

### 2. DB 스키마 초기화
```bash
npm run db:init
```

### 3. 환경 변수 설정
```bash
npx wrangler secret put TRIGGER_KEY      # 수동 트리거용 임의 비밀키
```

텍스트 요청은 바인딩 호환성을 위해 이름을 유지한 `openrouter-api` Worker의 `DeepSeekTextEntrypoint`로 전송합니다. 모델 순서는 공유 Worker의 `TEXT_MODEL_ROUTES` 한 줄에서 관리하며, 기본값은 무료 Nemotron 3 Ultra 다음 OpenRouter DeepSeek V4 0731입니다. 필요하면 같은 목록에 `official:deepseek-v4-flash` 또는 다른 OpenRouter 모델을 추가할 수 있습니다.

### 4. 배포
```bash
npm run deploy
```

### 5. 커스텀 도메인 설정
Cloudflare Dashboard → Workers & Pages → hn-news → 설정 → 도메인 및 경로
→ `news.archerlab.dev` 추가

## API

| 엔드포인트 | 설명 |
|-----------|------|
| `GET /` | 메인 페이지 |
| `GET /api/news` | 오늘의 뉴스 JSON |
| `GET /api/news?date=2026-03-11` | 특정 날짜 뉴스 JSON |
| `POST /trigger` + `X-Trigger-Key` 헤더 | 수동 크롤 실행 |

## 수동 크롤 실행
```bash
curl -X POST https://news.archerlab.dev/trigger \
  -H "X-Trigger-Key: YOUR_TRIGGER_KEY"
```
