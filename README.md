# HN 탑10 — news.archerlab.dev

Hacker News 탑10 기사를 매일 한국어로 번역해서 보여주는 서비스.

- **URL**: https://news.archerlab.dev
- **백엔드**: Cloudflare Workers + D1
- **번역**: OpenRouter Gemini 3.8 Flash → 실패 시 Gemma 4 31B(Venice)
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

텍스트 요청은 `openrouter-api` Worker의 `DeepSeekTextEntrypoint`로 전송합니다. 공유 Worker의 `NEWS_TEXT_MODEL_PRESET = "openrouter-gemini-flash"`가 뉴스 전용 경로를 선택합니다. `google/gemini-3.8-flash`를 먼저 호출하고, 실패하면 `google/gemma-4-31b-it`을 Venice에서 호출합니다. 세 번째 모델로 넘어가지 않습니다.

원문 본문 전체를 추출해 문단 순서대로 한국어로 번역합니다. 긴 기사는 여러 요청으로 나누며 입력 길이를 잘라 버리지 않습니다. 모든 문단의 응답을 검증한 뒤 전체 번역을 `explanation`에 저장합니다. 원문은 `original_content`, 번역 상태는 `translation_status`, 실제 모델은 `translation_model`에 기록합니다. 카드에는 짧은 미리보기를 유지하고 상세창에는 전체 번역을 표시합니다.

접근이 차단되거나 HTML/텍스트 본문이 없는 원문은 번역 불가로 표시합니다. 제목만 보고 본문을 생성하지 않습니다. 기존 요약 데이터는 자동으로 전체 번역이 되지 않으므로 재번역이 필요합니다.

구버전 `news` Worker는 같은 DB를 덮어쓰므로 예약 실행을 비활성화해야 합니다. `npm run legacy:disable`로 대상 DB를 확인하고 예약 실행만 제거할 수 있습니다. 현재 `news-api`의 예약 실행은 유지합니다.

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
| `POST /trigger?date=YYYY-MM-DD&refresh=1` + `X-Trigger-Key` 헤더 | 해당 날짜의 기존 기사 목록을 유지한 채 전체 재번역 |

수동 트리거는 번역과 저장이 끝난 뒤 응답합니다. 긴 기사는 몇 분 걸릴 수 있으므로 요청 연결을 유지해야 합니다. 기사 교체는 D1 트랜잭션으로 처리하며, 재번역에 실패한 기사가 이미 전체 번역을 갖고 있으면 기존 번역을 보존합니다.

## 수동 크롤 실행
```bash
curl -X POST https://news.archerlab.dev/trigger \
  -H "X-Trigger-Key: YOUR_TRIGGER_KEY"
```
