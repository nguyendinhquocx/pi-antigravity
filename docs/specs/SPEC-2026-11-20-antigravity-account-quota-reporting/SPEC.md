---
artifact_type: "completed-spec"
spec_id: "SPEC-2026-11-20-antigravity-account-quota-reporting"
status: "archived"
title: "Quota Antigravity theo từng account"
archived_at: "2026-11-20T19:39:17+07:00"
source_file: "SPEC-2026-11-20-antigravity-account-quota-reporting.md"
source_sha256: "ed18e433f71931414731c9e47f4a878b855c55de4e163132c41e674230f16eee"
implementation_ref: "47d946d24bc0e76e72993b4e6ab9b08786bd40c1"
working_tree: "dirty"
related_paths: ["src/usage/usage.ts", "src/types/types.ts", "src/index.ts", "src/client/client.ts", "src/auth/accounts.ts", "src/auth/oauth.ts", "scripts/test-usage-formatter.ts"]
---

# Spec: Quota Antigravity theo từng account

## Context Snapshot
- Project: `pi-antigravity`, Pi extension TypeScript; package manager Yarn 4.
- Current: `/antigravity.usage` gọi một credential qua ModelRegistry. Free-tier bị chặn aggregate RPC; thay đổi trước thêm fallback nhưng in từng model nên vừa dài vừa không cho biết quota từng account.
- Desired: một dòng tài khoản cho mỗi account đã liên kết, kèm tier và quota theo family — cách đọc gần `/subs`; không dump catalog model.
- Relevant source: `src/index.ts` (`antigravity.usage`, `withUsage`); `src/usage/usage.ts`; `src/types/types.ts`; `src/auth/accounts.ts`; `src/auth/balancer.ts`; `src/models/family.ts`; `src/client/client.ts`.
- Existing data: `antigravity-accounts.json` giữ accounts và active id. `retrieveUserQuotaSummary` có thể trả group/bucket cho Pro; free-tier trả `SUBSCRIPTION_REQUIRED`. Live probe: daily endpoint có Gemini rows nhưng thiếu quota fields; cloud endpoint trả Gemini `remainingFraction=1.0` cho 12 models/account, trong khi Claude quota của một số account chỉ có ở daily. Catalog merge phải giữ quota field hợp lệ từ endpoint trước khi endpoint sau thiếu.
- Related status command `s` ở repo cha `D:/pcloud/workspace/code/ai/workflow/status codex claude code/scripts` là giao diện riêng; fix endpoint merge của `s` đang được xử lý độc lập, không thuộc file scope spec này.

## Objective
Cho owner xem quota hiện tại của từng Google account trong `/antigravity.usage`, biết account nào free/paid, còn bao nhiêu theo Gemini/Claude/Argon, và không nhầm dữ liệu thiếu với 0% quota.

## UX Baseline
- Đây là output text trong Pi CLI/TUI, không tạo custom picker.
- Ưu tiên một account heading + một dòng/family; không lặp danh sách model.
- Quota không có dữ liệu phải ghi unavailable/unknown, không giả làm 0%.
- Giữ email, tier, active marker và reset gần nhất để owner biết account nào còn dùng được.

## Scope
### In
- `/antigravity.usage` đọc tất cả account đã link trong store, không chỉ credential mà ModelRegistry đang resolve.
- Account có aggregate quota summary: hiển thị đúng group/bucket/reset từ server.
- Free-tier hoặc account không có aggregate summary: suy ra **một dòng mỗi family/account** từ merged `fetchAvailableModels` data; không in từng model.
- Làm mới access token hết hạn khi cần; không đổi account đang active hay ghi `auth.json`. Nếu non-active account refresh trả token mới, cập nhật account row tương ứng trong `antigravity-accounts.json` theo cơ chế atomic hiện có.
- Aggregate summary và model-catalog request độc lập: catalog lỗi không làm mất summary đã có; summary lỗi không chặn free fallback.
- Mỗi account query có deadline 30 giây và abort network work; timeout/lỗi một account không làm mất kết quả account khác. Output phân biệt unavailable với quota còn 0.

### Out
- Không đổi OAuth/login flow, account store schema, model availability/IDs, request balancer, quota API, hoặc quyền tài khoản. Chỉ merge quota metadata cùng model khi field ở endpoint mới hơn bị thiếu.
- Không đổi `/antigravity.models`, vẫn là lệnh chi tiết theo model.
- Không tuyên bố quota của free-tier chính xác hơn dữ liệu API trả.

## Thuật ngữ
- Account row: một tài khoản Google đã liên kết trong `antigravity-accounts.json`.
- Summary quota: group/bucket aggregate do `retrieveUserQuotaSummary` trả về; authoritative cho account Pro.
- Family fallback: summary account-level dựng từ model quota khi summary RPC bị chặn; không phải quota RPC độc lập.
- Quota missing: API không trả `remainingFraction`; khác `remainingFraction = 0` (hết quota).

## UX Contract
- Entry: `/antigravity.usage`.
- Output có tổng số linked accounts; mỗi account có email/account id, tier, active marker và quota groups/families riêng.
- Paid: giữ bucket/window/reset hiện có, ví dụ `5H`, `Week`.
- Free fallback: nguồn chính là RPC `retrieveUserQuota` (`{project}` trên cloudcode-pa) — buckets weekly thật mà CLI dùng, free tier gọi được; mỗi family một dòng gọn, ví dụ `Gemini shared 0% · reset ~4d 14h`. Chỉ khi server trả rỗng mới fallback sang model catalog với suffix `· catalog estimate`.
- Provenance chỉ hiện khi dữ liệu thiếu một phần (`· 12/16 models`); không in boilerplate subscription per-account — legend một dòng ở header: `Weekly quota per family; ?% = no data (not exhausted).`
- Reset hợp lệ phải parse được thành timestamp. Một model chặt nhất có reset hợp lệ thì hiện reset đó; nhiều model đồng hạng chỉ hiện reset khi tất cả có cùng timestamp hợp lệ, còn lại ghi `reset varies/unknown`.
- Family có model rows nhưng không có quota values phải hiện `?% · no data`; không biến missing thành 0%.
- Một account lỗi refresh/API hiện `unavailable` cho riêng account đó; các account khác vẫn được render.
- Thứ tự: active account trước, sau đó các account còn lại theo thứ tự ổn định trong store.

## Approach
- Thêm hàm load/report account-level trong `src/usage/usage.ts`; đọc store trực tiếp, không gọi `syncCurrentAuth`. Active account dùng credential ModelRegistry; non-active dùng `ensureFresh` + `apiKeyFor`.
- Nếu non-active refresh trả credential/token mới, persist ngay trước quota calls bằng `updateRememberedAccount` (hàm reread store mới nhất và chỉ update đúng một row). Serialize các lần persist để account refresh song song không ghi đè snapshot cũ; không đổi active id/auth.json.
- Chạy tối đa 2 account cùng lúc; giới hạn mỗi account 30 giây, truyền AbortSignal qua load-code-assist/summary/catalog và refresh; bắt lỗi riêng từng account.
- Summary, `retrieveUserQuota` và model catalog fetch độc lập. Paid summary có dữ liệu thì giữ nguyên dù catalog/server-quota lỗi; free dùng server weekly buckets trước, catalog chỉ là fallback cuối.
- `retrieveUserQuota` (tìm qua binary `agy` CLI 1.5.12, proto `v1internal.RetrieveUserQuotaRequest{project}` → `RetrieveUserQuotaResponse{buckets}`) trả per-model weekly buckets khớp panel Models & Quota và 429 generation-time; catalog `fetchAvailableModels` có thể optimistic (remainingFraction=1 trong khi weekly group = 0). Service `businessaicode.googleapis.com:fetchQuotaStatus` bị gate (cần downscoped token) — không dùng.
- Merge model records giữ metadata endpoint mới hơn nhưng merge `quotaInfo` theo field: giá trị quota mới có thì thắng; field bị thiếu thì giữ giá trị hợp lệ từ endpoint trước.
- Tách formatter theo account: paid dùng bucket thật; free family fallback dùng min remaining, ghi số model quota-bearing. Reset chỉ hiện khi model(s) chặt nhất có cùng resetTime hợp lệ; nếu khác/thiếu thì `reset varies/unknown`. Không sửa balancer.

## Assumptions / Decisions
- “Giống `/subs`” nghĩa là một account row và quota summary gọn theo family/window, không cần selector/menu mới.
- Quota family từ model rows là estimate có provenance; dùng `min` để không quảng cáo quota cao hơn mức chặt nhất.
- Active credential do Pi quản lý; non-active refresh rotation được persist vào đúng `antigravity-accounts.json` row (pattern balancer hiện có). Không đổi activeAccountId hay ghi `auth.json`.
- Nếu nhiều model đồng hạng ở mức quota thấp nhất, chỉ hiện reset khi tất cả tied rows có cùng resetTime parseable; nếu thiếu/khác nhau ghi `reset varies/unknown`. Một model chặt nhất không có reset hợp lệ thì ghi `reset unknown`.

## Risks
- Free fallback là estimate từ model-level quotas, không phải aggregate RPC; model rows có thể thiếu hoặc khác nhau giữa endpoint. Ghi count/provenance và không biến missing thành zero.
- Endpoint/refresh có thể treo; account deadline 30s và abort propagation phải để các account còn lại vẫn hiển thị.
- Google có thể trả refresh token mới. Persist rotation ngay vào đúng non-active row bằng row-level reread/update; report serialize các lần ghi. Active credential tiếp tục theo Pi-managed auth path. Cross-session writes vẫn dùng atomic writer hiện có; không thêm account-store schema/migration.

## Task List

### Task 1: Account-level quota loading and formatter
- Files: `src/usage/usage.ts`, `src/index.ts`, `src/client/client.ts`, `src/types/types.ts`, `src/auth/accounts.ts`, `src/auth/oauth.ts`.
- UX Contract:
  - Surface: Operate, plain Pi command output via `ctx.ui.notify`/CLI output.
  - Current: `/antigravity.usage` chỉ đọc credential provider đang resolve và free fallback in nhiều model rows.
  - Target: tất cả linked accounts, mỗi account có quota theo family; không in model IDs.
  - States: paid summary / free family fallback / quota missing / một account lỗi / store rỗng.
  - Keyboard: command không có menu; Enter chạy, không thêm navigation.
- Skills: `flow`, `test`, `verify`.
- Visual Ref: output style hiện tại của `/subs` quota dashboard và `formatUsageSummary`; không dựng custom TUI.
- Acceptance:
  - `/antigravity.usage` report tất cả account trong store, active ở đầu, mỗi account có plan/status.
  - Aggregate bucket thiếu `remainingFraction` được giữ là unknown qua parser/formatter; numeric 0 vẫn là 0% remaining.
  - Free account hiển thị tối đa một line/family, không liệt kê model ids. `min remainingFraction` là family estimate; reset tie chỉ hiện khi các tied models cùng resetTime hợp lệ.
  - Catalog merge giữ `quotaInfo` hợp lệ từ endpoint trước nếu endpoint sau không trả field; giá trị rõ ràng từ endpoint sau thắng.
  - Paid summary thành công vẫn render khi model catalog lỗi; model fallback chỉ dùng khi summary bị chặn/không có groups.
  - Mỗi account query dừng trong tối đa 30s, hủy network requests; một token/API failure hoặc timeout chỉ đánh dấu account đó unavailable.
  - Non-active refresh rotation được persist ngay vào đúng account-store row và serialize khi nhiều account cùng refresh; activeAccountId/`auth.json` giữ nguyên; không ghi stale whole-store snapshot.
- Verify: formatter tests với mixed Pro/free, 7 accounts, family missing/numeric zero, aggregate bucket missing, summary-success/catalog-failure, endpoint quotaInfo merge, tied resets, account error/timeout, refresh rotation; assert account store/auth effects.

### Task 2: Regression tests and documentation
- Files: `scripts/test-usage-formatter.ts`, test script multi-account aggregation nếu cần, test model-catalog merge, `README.md`.
- Acceptance: tài liệu nói rõ `/antigravity.usage` per-account; `/antigravity.models` vẫn per-model detail.
- Verify: `node scripts/run-ts.mjs scripts/test-usage-formatter.ts`; test multi-account runner; changed-file ESLint/Prettier; TSC không có lỗi mới so với baseline.

## External Review Brief
Reviewer kiểm tra: account store/token lifecycle; token rotation chỉ update non-active store row, không đổi auth/active id; paid summary không bị catalog lỗi che; catalog merge giữ quotaInfo hợp lệ khi endpoint sau thiếu field; free fallback family-level (không dump models); missing khác zero; timeout/error một account không chặn các account khác.

## User Test
| Hành động | Kết quả kỳ vọng | Chuẩn nhìn |
|---|---|---|
| `/antigravity.usage` với 7 linked accounts | Có 7 account headings, active trước | Email/tier/active rõ; không có danh sách model IDs |
| Free account nhận Gemini quota từ cloud endpoint | Một dòng Gemini/account; các model quota 1.0 thành family 100% còn | Nêu số model nguồn; không lặp từng model |
| Daily endpoint có Claude quota, cloud endpoint thiếu field đó | Claude quota daily vẫn còn sau catalog merge | Model metadata cloud được giữ nhưng quotaInfo không bị xóa |
| Aggregate bucket thiếu remainingFraction | Bucket unavailable/?, không phải 0% | Numeric 0 thật vẫn hiện 0% còn |
| Model summary lỗi nhưng paid aggregate thành công | Vẫn hiện paid groups và reset | Catalog phụ không chặn dữ liệu authoritative |
| Hai model đồng hạng min nhưng reset khác/thiếu | Family còn quota đúng; reset ghi varies/unknown | Không phụ thuộc thứ tự row |
| Một account timeout/refresh lỗi | Các account khác vẫn render | Một dòng account unavailable trong ≤30 giây |
| Hai non-active account cùng refresh và có refresh_token mới | Cả hai store rows được cập nhật, không lost update | `activeAccountId` và bytes `auth.json` không đổi |
| Reset timestamp hỏng hoặc đã qua | Quota percent vẫn hiện; reset là unknown hoặc now | Không dùng timestamp parse lỗi; tie không phụ thuộc model order |

## Checkpoints
- Sau review spec: chờ owner duyệt trước implementation.
- Sau implementation: parent scope-check diff, chạy tests và final verify; owner UAT kiểm số account/free/Pro, family quota và missing-state.
