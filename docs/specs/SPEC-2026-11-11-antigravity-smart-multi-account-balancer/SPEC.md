# SPEC-2026-11-11: Smart Multi-Account Balancer cho Pi-Antigravity Extension (Rev 2 - Post-Review)

> `status`: approved_by_reviewers  
> `project`: pi-antigravity (fork: `nguyendinhquocx/pi-antigravity`)  
> `working_path`: docs/specs/.working/SPEC-2026-11-11-antigravity-smart-multi-account-balancer.md  
> `author`: lead-agent  
> `reviewers`: antigravity/gemini-4-argon, antigravity/gemini-3.8-flash  
> `revision`: 2 (Đã fix toàn bộ findings từ Argon & Flash reviewers)

---

## 1. Context Snapshot

- **Project**: Extension `pi-antigravity` (TypeScript, build qua yarn/node, nạp vào Pi/Li runtime qua NTFS junction `C:\Users\quocn\.pi\agent\extensions\pi-antigravity`).
- **Hiện trạng**:
  - Người dùng sở hữu nhiều tài khoản Google AI Pro (hiện có 3 tài khoản: `quocnguyent9v@gmail.com`, `npptudung@gmail.com`, `hoangthiloan.pho@gmail.com`).
  - Toàn bộ danh sách tài khoản được lưu trong `~/.pi/agent/antigravity-accounts.json`.
  - Cơ chế nguyên bản: `streamAntigravity` chỉ lấy duy nhất một token từ `opts.apiKey` (tài khoản `activeAccountId` ghi trong `auth.json`).
  - Hạn chế: Khi một tài khoản cạn quota (ví dụ Claude đạt 100%), request phải đợi đụng tường HTTP 429 mới kích hoạt `failoverToNextAccount`. Ngoài ra, nếu nhiều session chạy đồng thời (Parent + nhiều Subagents), toàn bộ request đều dồn vào cùng một tài khoản active, gây nghẽn và lãng phí quota ở các tài khoản còn lại.
- **Mục tiêu**: Nâng cấp fork `pi-antigravity` với cơ chế **Smart Multi-Account Balancer (Per-Request in RAM)**:
  - Tự động phân loại model family (`Claude/GPT`, `Gemini`, `Argon`).
  - Trước mỗi request, tự động chọn tài khoản có dung lượng quota còn lại cao nhất cho model family đó.
  - Vận hành hoàn toàn in-memory trên từng HTTPS request: **KHÔNG ghi đè `auth.json` toàn cục**, đảm bảo các session/subagent chạy song song độc lập 100% không bị xung đột hay race condition.
  - Co giãn tự động: 1 tài khoản chạy như cũ; nhiều tài khoản tự chia tải; thêm/bớt tài khoản qua Pi CLI tự cập nhật.

---

## 2. Objective & Non-Negotiable Contracts

1. **Per-Request Isolation**: Mỗi lượt gọi model có thể dùng token của tài khoản khác nhau tùy theo mức quota còn lại của dòng model đó. **CẤM ghi đè `auth.json` toàn cục** (giữ nguyên active account mặc định của người dùng).
2. **Zero Latency Penalty on TTFT**:
   - Không gọi API mạng hỏi quota trước mỗi prompt (tránh delay 1-2s).
   - Đọc quota từ cache in-memory hoặc local cache file `%LOCALAPPDATA%\quoc-ai-usage\antigravity_cache.json` (<1ms).
   - Nếu chưa có cache: chia tải ngay lập tức bằng **In-Memory Round-Robin**, không để kẹt vào active account (tránh Cold-Start Lock).
3. **Persist Token Tươi đúng nơi**:
   - Khi `ensureFresh` refresh access token mới, **cho phép cập nhật vào `antigravity-accounts.json`** để các prompt sau tái sử dụng token trong 55 phút (tránh bị phạt +500ms refresh ở mọi request).
   - Tuyệt đối **không gọi `writeActiveCredential`** (không ghi `auth.json`).
4. **Model Family Routing & Quota Scoring**:
   - Chuẩn hóa công thức đọc cache: `antigravity_cache.json` lưu `pct` là `% đã dùng` $\rightarrow$ `remainingFraction = (100 - pct) / 100`.
   - Với mọi family, điểm số phải lấy `min` của toàn bộ các bucket trong family đó (xét cả 5H lẫn Week):
     - `Claude`: `min(Claude 5H, Claude Week)`.
     - `Gemini`: `min(Gemini 5H, Gemini Week)`.
     - `Argon`: `min(Argon 5H, Argon Week)`.
   - Nếu bucket có `resetTime <= Date.now()` thì tính điểm là `1.0` (100% - vừa được Google reset).
5. **Resilient 429 Failover (In-Memory)**:
   - Viết hàm `failoverToNextAccountInMemory`: khi gặp 429, đánh dấu account bị lỗi vào in-memory blacklist (cooldown 10 phút), chuyển sang account tiếp theo trong RAM và retry. **Không ghi đè `auth.json`**.
6. **Mock Test Immunity**: Chỉ kích hoạt balancer khi `creds` khớp với tài khoản trong `store.accounts`. Nếu caller truyền mock `apiKey` tùy chỉnh (như trong unit test của repo), giữ nguyên mock credential.

---

## 3. Scope & Boundaries

### Trong phạm vi (In-Scope)
- Thêm module phân loại model `src/models/family.ts`: `detectModelFamily(modelId: string): ModelFamily`.
- Thêm module cân bằng tải `src/auth/balancer.ts`:
  - Quản lý in-memory quota cache & blacklist 429.
  - Hàm `selectBestAccountForFamily(family, store, triedAccountIds)`.
  - Hàm `failoverToNextAccountInMemory(family, store, triedAccountIds)`.
- Tích hợp vào `src/stream/stream.ts`: gọi balancer ở đầu hàm và gọi failover in-memory khi gặp 429.
- Thêm unit test kiểm chứng tại `scripts/test-family.ts` và `scripts/test-smart-balancer.ts`, chạy qua `node scripts/run-ts.mjs`.

### Ngoài phạm vi (Out-of-Scope)
- Không can thiệp vào OAuth login flow (`src/auth/oauth.ts`).
- Không sửa đổi CLI command `/antigravity.accounts`.
- Không sửa đổi mã nguồn core của `pi-mono-li`.

---

## 4. Technical Approach & Architecture

### 4.1 Mô hình phân loại Model Family (`src/models/family.ts`)
```typescript
export type ModelFamily = "claude" | "gemini" | "argon" | "unknown";

export function detectModelFamily(modelId: string): ModelFamily {
  const lower = modelId.toLowerCase();
  // Bắt buộc kiểm tra argon trước gemini vì tên chứa cả hai: "gemini-4-argon"
  if (lower.includes("argon")) return "argon";
  if (lower.includes("claude") || lower.includes("gpt")) return "claude";
  if (lower.includes("gemini")) return "gemini";
  return "unknown";
}
```

### 4.2 Module Cân bằng tải Quota (`src/auth/balancer.ts`)

```typescript
// Blacklist in-memory cho các account vừa dính 429: accountId -> timestamp hết hạn cooldown
const rateLimitedAccounts = new Map<string, number>();

// In-memory round-robin tracker: accountId -> timestamp dispatch gần nhất
const lastDispatchedAt = new Map<string, number>();

export function markAccountRateLimited(accountId: string, cooldownMs = 10 * 60 * 1000): void {
  rateLimitedAccounts.set(accountId, Date.now() + cooldownMs);
}

export function isAccountAvailable(accountId: string): boolean {
  const expire = rateLimitedAccounts.get(accountId);
  if (!expire) return true;
  if (Date.now() >= expire) {
    rateLimitedAccounts.delete(accountId);
    return true;
  }
  return false;
}
```

**Thuật toán chấm điểm Quota (`calculateAccountScore`):**
1. Đọc dữ liệu quota cached từ file `%LOCALAPPDATA%\quoc-ai-usage\antigravity_cache.json` hoặc memory.
2. Với file cache của `costats` (`antigravity_cache.json`):
   - Nhóm: `"Gemini"`, `"Claude"`, `"Argon"`.
   - Bucket: `pct` (used %) $\rightarrow$ `remaining = Math.max(0, (100 - bucket.pct) / 100)`.
   - Nếu `bucket.reset_iso && Date.parse(bucket.reset_iso) <= Date.now()` $\rightarrow$ `remaining = 1.0`.
3. Điểm của account cho family = `Math.min(...matchingBuckets.map(b => b.remaining))`.
4. Nếu không có dữ liệu cache: trả về `-1` (dấu hiệu chưa có cache).

**Thuật toán chọn Account (`selectBestAccountForFamily`):**
1. Lấy danh sách `accounts = Object.values(store.accounts).filter(a => isAccountAvailable(a.accountId))`.
2. Loại bỏ các account đã nằm trong `triedAccountIds`.
3. Nếu không còn account nào: trả về `undefined` (hết pool).
4. Nếu chỉ có 1 account: thử `ensureFresh(account)`, lưu token vào `store.accounts[id]` nếu có đổi mới, và trả về.
5. Nếu có nhiều accounts:
   - Chấm điểm cho từng account với family đó.
   - Nếu có cache (điểm $\ge 0$): sắp xếp giảm dần theo điểm số. Các account có điểm chênh lệch $< 0.02$ coi như bằng nhau và sắp xếp phụ theo `lastDispatchedAt` cũ nhất (round-robin).
   - Nếu chưa có cache (toàn bộ điểm $= -1$): sắp xếp theo `lastDispatchedAt` cũ nhất (in-memory round-robin).
6. **Candidate Loop với Error Isolation (Chặn lỗi P0):**
   ```typescript
   for (const candidate of sortedCandidates) {
     try {
       const fresh = await ensureFresh(candidate);
       // Cập nhật token tươi vào store nếu có thay đổi (chỉ ghi antigravity-accounts.json, KHÔNG ghi auth.json)
       if (fresh.access !== candidate.access || fresh.expires !== candidate.expires) {
         store.accounts[fresh.accountId] = fresh;
         saveAccountStore(store);
       }
       lastDispatchedAt.set(fresh.accountId, Date.now());
       return fresh;
     } catch (err) {
       // Tài khoản hỏng token -> loại trừ và thử tài khoản tiếp theo
       markAccountRateLimited(candidate.accountId, 30 * 60 * 1000);
       continue;
     }
   }
   return undefined;
   ```

### 4.3 Tích hợp vào `streamAntigravity` (`src/stream/stream.ts`)

```typescript
// Tại dòng 1563 của streamAntigravity:
let creds = parseApiKey(opts.apiKey);
const triedAccountIds = new Set<string>();
const triedAccessTokens = new Set<string>([creds.token]);

const store = loadAccountStore();
const isKnownStoreToken = Object.values(store.accounts).some(a => a.access === creds.token);

// Chỉ can thiệp khi token thuộc store của user (không phá mock test truyền apiKey lạ)
if (isKnownStoreToken && Object.keys(store.accounts).length > 1) {
  const family = detectModelFamily(model.id);
  const best = await selectBestAccountForFamily(family, store, triedAccountIds);
  if (best?.access) {
    creds = apiKeyFor(best);
    triedAccountIds.add(best.accountId);
    triedAccessTokens.add(best.access);
  }
}

// Khi gặp HTTP 429 Quota Reached (dòng ~1735):
if (response?.status === 429 && /Quota reached\./i.test(friendly)) {
  // Đánh dấu account hiện tại bị 429
  const currentAcc = Object.values(store.accounts).find(a => a.access === creds.token);
  if (currentAcc) markAccountRateLimited(currentAcc.accountId);

  // Failover in-memory, KHÔNG gọi writeActiveCredential:
  const next = await failoverToNextAccountInMemory(detectModelFamily(model.id), store, triedAccountIds, triedAccessTokens);
  if (next) {
    triedAccessTokens.add(next.token);
    creds = next;
    requestHeaders = antigravityHeaders(creds.token);
    // tiếp tục retry lượt gọi...
    continue;
  }
  throw new Error(friendly);
}
```

---

## 5. Ordered Tasks & Verification

### Task 1: Module phân loại Model Family (`src/models/family.ts`)
- **Files**: `src/models/family.ts`, `scripts/test-family.ts`.
- **Mô tả**: Viết `detectModelFamily`. Hỗ trợ nhận diện chính xác `claude`, `gemini`, `argon`, `unknown`.
- **Verify**: `node scripts/run-ts.mjs scripts/test-family.ts` PASS.

### Task 2: Module Balancer & In-Memory Failover (`src/auth/balancer.ts`)
- **Files**: `src/auth/balancer.ts`, `scripts/test-smart-balancer.ts`.
- **Mô tả**: Cài đặt chấm điểm quota từ cache file, in-memory round-robin, candidate try/catch loop, blacklist 429, và `failoverToNextAccountInMemory`.
- **Verify**: `node scripts/run-ts.mjs scripts/test-smart-balancer.ts` PASS (bao gồm mock đa tài khoản: lệch quota, tài khoản hỏng token, và round-robin khi chưa có cache).

### Task 3: Tích hợp vào `streamAntigravity` & Live End-to-End Test
- **Files**: `src/stream/stream.ts`.
- **Mô tả**: Tích hợp balancer vào `streamAntigravity`. Bảo toàn các unit test cũ của repo.
- **Verify**:
  - `node scripts/run-ts.mjs scripts/test-stream-recovery.ts` PASS (không làm gãy mock test cũ).
  - Test live: Spawn 2 subagent chạy đồng thời với 2 model khác nhau (`claude-sonnet-5-5` và `gemini-3.8-flash`), kiểm tra log xác nhận 2 subagent dùng token của 2 tài khoản khác nhau trong cùng một thời điểm.
