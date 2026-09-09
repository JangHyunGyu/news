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

원문 전체를 빠짐없이 옮기면서 IT를 모르는 독자도 이해할 수 있도록 전문용어·기초 배경·원인과 결과를 쉬운 말로 설명합니다. 긴 기사는 여러 요청으로 나누며 입력 길이를 잘라 버리지 않습니다. 모든 문단의 응답을 검증한 뒤 `이게 뭔가요? → 왜 화제인가요? → 핵심 내용 → 나에게 어떤 영향이 있나요?` 순서로 `explanation`에 저장합니다. `핵심 내용`에는 원문의 모든 내용을 풀어 쓴 본문이 들어갑니다. 앞뒤의 설명을 작성할 때도 원문 전체를 직접 전달하여 수치·조건·배경을 확인하게 하며, 짧은 요약으로 본문을 대체하지 않습니다.

원문은 `original_content`, 번역 상태는 `translation_status`, 실제 모델은 `translation_model`, 설명 방식은 `translation_format = explained_full_v1`에 기록합니다. 카드에는 짧은 미리보기를 유지하고 상세창에서 네 부분으로 나눈 쉬운 전체 번역을 보여줍니다. 재번역할 때 저장된 원문 전체가 있으면 이를 사용하고, 없으면 원문 사이트에서 다시 가져옵니다. 기사 속 사실과 이해를 돕는 배경·예시·예상 영향을 구별하며 기사에 없는 사건이나 반응을 만들지 않습니다.

도입부와 영향 설명은 원문 전체와 대조하는 검토를 한 차례 더 거칩니다. 특히 비율의 대상 집단, 실험별 소요 시간, 안전성에 관한 조건과 주장의 강도가 달라지지 않도록 확인합니다.

설명 전체가 7,000자를 넘으면 같은 네 부분을 유지하며 약 3,500~5,000자로 요약하고 원문과 다시 대조합니다. 핵심 사실·수치·조건·결론·필수 용어 설명은 남기고 반복 설명, 부차적인 예시, 긴 코드와 표를 줄입니다. 최대 5,500자를 넘는 결과나 불완전한 결과는 저장하지 않습니다. 짧은 기사는 그대로 유지합니다. 요약된 글은 `translation_status = summary`, `translation_format = explained_summary_v1`로 구별하며 원문 전체는 계속 보관합니다.

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
| `POST /trigger?date=YYYY-MM-DD&refresh=1&shorten=1` + `X-Trigger-Key` 헤더 | 저장된 원문과 설명을 사용해 긴 기사만 요약 |

수동 트리거는 번역과 저장이 끝난 뒤 응답합니다. 긴 기사는 몇 분 걸릴 수 있으므로 요청 연결을 유지해야 합니다. 기사 교체는 D1 트랜잭션으로 처리하며, 재번역에 실패한 기사가 이미 전체 번역을 갖고 있으면 기존 번역을 보존합니다.

## 수동 크롤 실행
```bash
curl -X POST https://news.archerlab.dev/trigger \
  -H "X-Trigger-Key: YOUR_TRIGGER_KEY"
```
