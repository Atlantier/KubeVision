# R20 · 零出域证明、回执防篡改、可配置脱敏

> 本轮新增 3 条（追问 4/5/6），并复跑追问 1/2 的执行脚本确认无回归。
> 所有结论来自本地可复现命令的真实输出；未验证项单列。

---

## 0. 总览

| # | 主题 | 交付 | 结果 |
|---|---|---|---|
| Q4 | 原始凭证零出域证明 | `scripts/verify-privacy.mjs` → `docs/privacy-egress.md` | ✅ 5/5 |
| Q5 | MCP 回执防篡改 | `src/utils/mcpReceiptDigest.ts` + `ActionConfirm` 校验按钮 + `scripts/verify-receipt-digest.mjs` + `scripts/probe-receipt-verify.mjs` | ✅ 单测 10/10 · UI 7/7 |
| Q6 | 脱敏规则可配置 + ReDoS 防护 | `logSanitizer.createSanitizerEngine` + 引擎测试 | ✅ 脱敏器 47/47 |
| Q1 | 长跑稳定性 | `scripts/soak.mjs`（r18 已交付，本轮复跑） | ✅ 7/7 |
| Q2 | StrictMode 一致性 | `scripts/strictmode-audit.mjs`（r18 已交付，本轮复跑） | ✅ 6/6 |
| Q3 | 流式取消语义 | r18 已交付：新消息 abort 旧流保留内容 + 断网"继续生成" | ✅ |

---

## 1. Q4 · 原始凭证零出域证明

### 方法（不依赖代码审阅，直接看网络字节）

1. CDP `Network` 域抓取页面全部出站请求（URL / headers / postData，postData 上限 10MB）；
2. 向端侧审计面板注入一条包含 7 个凭证金丝雀的原始日志：
   `AKIAIOSFODNN7EXAMPLE` / `S3cr3t!` / `postgres://admin:` / `oncall@kubevision.io` /
   `10.244.3.17` / `canary-token-9f3a` / `db.internal`；
3. 执行端侧脱敏 + 语义分类（全程在浏览器内）；
4. 注入 OOM 混沌 → 抓取并审计集群日志生成**高危记录** → 点击「移交 Copilot」
   （这是整个流程中唯一可能外发数据的路径）；
5. 对全部抓包做金丝雀扫描。

### 真实输出

```
$ node scripts/verify-privacy.mjs
  ✓ 金丝雀日志已注入并触发端侧脱敏 + 分类
  ✓ 端侧脱敏 + 分类阶段零对话外发
  ✓ 页面展示的推理输入已含脱敏占位符
  抓取并审计集群日志: {"ok":true}
  移交 Copilot: {"ok":true,"via":"record"}

  抓包总数: 15 · /api: 3 · /api/chat: 1 · POST: 1
  金丝雀命中: 0
  ✓ 抓到真实外发请求（/api/chat 移交链路）  ::  1 条
  ✓ 所有出站请求均不含凭证金丝雀  ::  15 条请求 × 7 个金丝雀

汇总: 通过 5 · 失败 0
```

报告：`docs/privacy-egress.md`（R21 证据页素材，含金丝雀清单、外发请求清单、边界声明）。

> **诚实边界**：本证明只覆盖本次观测到的请求；脚本已进入回归集，防止未来变更引入外泄。
> WebGPU 模型权重下载是远程请求，但属于公开模型文件、不含凭证，不在金丝雀范围内。

---

## 2. Q5 · MCP 回执防篡改

### 实现

- 新增 `src/utils/mcpReceiptDigest.ts`：`buildReceiptDigestPayload` /
  `computeReceiptDigest`（Web Crypto sha256 前 16 位）/ `verifyReceiptDigest`；
- 新增 `src/types/mcp.ts`：回执类型唯一源（此前前端另写一份 interface，字段顺序漂移
  会让"校验永远失败"）；
- `ActionConfirm` 回执区新增「校验回执」按钮（`aria-label="校验回执摘要是否与字段一致"`）：
  - 一致 → 绿色"✓ 校验通过：摘要与字段一致（…）"；
  - 不一致 → rose 红色"✗ 校验失败：回执字段被改动（期望 … / 实际 …）"。

### 验证 1：单元测试（含真实服务端回执对账）

```
$ node scripts/verify-receipt-digest.mjs
  ✓ 1.1 载荷字段顺序与分隔符锁定
  ✓ 2.1 Web Crypto 复算结果与 Node crypto 一致  ::  "f7bc241f9c3caf41"
  ✓ 3.1 未篡改回执校验通过  ✓ 3.2 返回的 expected 与回执一致
  ✓ 4.1 改 kubectlCommand 校验失败   ✓ 4.2 改 targetId 校验失败
  ✓ 4.3 改 executionId 校验失败      ✓ 4.4 改 timestamp 校验失败
  ✓ 4.5 改 actionType 校验失败
  ✓ 5.1 真实服务端回执 → 前端复算通过  ::  回执 mcp-mwaf5pex-2277 · digest=0d5cec8de8aebabd
汇总: 通过 10 · 失败 0
```

### 验证 2：UI 行为（绿色通过 / 红色失败）

```
$ node scripts/probe-receipt-verify.mjs
  ✓ 动作卡已挂载
  ✓ 已点击「立即执行自愈方案」
  ✓ 回执区出现「校验回执」按钮
  ✓ 校验通过（绿色）  ::  ✓ 校验通过：摘要与字段一致（a93935ad76e91db1）
  ✓ 已注入摘要不一致（monkeypatch crypto.subtle.digest）
  ✓ 校验失败显示红色告警  ::  ✗ 校验失败：回执字段被改动（期望 0909… / 实际 a939…）
  ✓ 失败态使用 rose 红色样式
汇总: 通过 7 · 失败 0
```

> 失败分支用**替换 `crypto.subtle.digest` 实现**的方式制造"复算不一致"，
> 不修改任何产品代码；这与真实篡改命中的是同一条 UI 分支。

---

## 3. Q6 · 脱敏规则可配置化 + ReDoS 防护

### 接口

```ts
const engine = createSanitizerEngine({
  customRules: [
    { name: 'ticket-id', pattern: 'TICKET-\\d{6}', placeholder: '[REDACTED_TICKET]' },
  ],
  maxInputChars: 65_536,  // 默认
  ruleTimeoutMs: 100,     // 默认
});
engine.sanitize(raw);      // => { sanitized, maskedCount, maskedByRule }
engine.violations;         // => 构建期/运行期违规记录
```

### 三层防护

| 层 | 机制 | 说明 |
|---|---|---|
| 1 | **编译前静态拒绝** | 嵌套量词 `(a+)+`、歧义交替 `(a|aa)+` 等已知 ReDoS 结构直接拒绝并记录 `redos-suspect` |
| 2 | **输入长度上限** | 默认 64K 字符，超出截断并记录 `input-truncated` |
| 3 | **单规则 100ms 预算** | 超预算规则从下一次起**永久禁用**，记录 `rule-budget-exceeded` |

另有限制：规则条数 ≤ 10（`too-many-rules`）、正则长度 ≤ 500（`pattern-too-long`）、
正则语法错误（`invalid-pattern`）。自定义规则在内置规则**之后**执行，避免自定义规则
破坏内置占位符语义。

### 诚实边界

JavaScript 同步正则**不可抢占**：第 3 层无法中止"已经在跑"的那一次匹配，它保证的是
"不重复付出代价"。彻底方案是把自定义规则放进 Worker 并在 100ms 后 terminate，
本模块保留了该扩展点（`SanitizerEngine` 是纯对象，可整体搬到 Worker）。

### 验证

```
$ node scripts/verify-sanitizer.mjs
▸ 5. 可配置规则（自定义正则 + ReDoS 防护）
  ✓ 5.1 自定义规则命中并替换     ✓ 5.1b 自定义规则计入分类计数
  ✓ 5.1c 内置 IP 规则同时生效
  ✓ 5.2 自定义规则二次脱敏文本不变  ✓ 5.2b 二次脱敏计数为 0
  ✓ 5.3 嵌套量词被拒绝  ::  ["redos-suspect"]   ✓ 5.3b 未进入生效列表
  ✓ 5.4 歧义交替被拒绝
  ✓ 5.5 非法正则被拒绝           ✓ 5.5b 引擎仍可正常脱敏
  ✓ 5.6 超出条数上限被记录       ✓ 5.6b 仅前 10 条生效
  ✓ 5.7 超长正则被拒绝
  ✓ 5.8 超长输入被截断（尾部标记未进入结果）  ✓ 5.8b 截断被记录
  ✓ 5.9 内置 IP 规则先执行（自定义规则不再命中）
汇总: 通过 47 · 失败 0
```

---

## 4. Q1/Q2 复跑（本轮代码变更后确认无回归）

见本轮提交附带的 `artifacts/r20-soak.log` 与 `artifacts/r20-strictmode.log`。

---

## 5. 未验证项与风险

1. **Q4**：零出域证明覆盖"本次观测请求"，不构成对未来代码的证明；WebGPU 权重下载不在金丝雀范围。
2. **Q5**：失败分支是"复算结果不一致"，不是"服务端回执真被篡改"；但二者在 UI 上走同一条分支。
3. **Q6**：第 3 层无法抢占已在执行的正则（JS 限制），彻底方案需 Worker 化；当前靠静态拒绝 + 输入上限兜底。
4. **Q1**：soak 的对话走引擎 A（本机有 API Key），协议消费路径与引擎 B 相同。
5. **Q2**：StrictMode 审计在 dev 构建下执行；生产构建无双重挂载，结论只对 dev 有意义（这正是 StrictMode 的适用范围）。

---

## 6. 回滚

```bash
git revert --no-edit <本轮 commit>
git reset --hard 5d4afd2     # 回到 r19
git reset --hard v12-baseline
```