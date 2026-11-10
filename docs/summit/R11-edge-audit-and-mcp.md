# R11 · 端侧审计降级、MCP 真集群路径与脱敏器加固

> 本轮 5 条缺陷（B1–B5），每条先定义**可验证的行为**，再改代码，最后用脚本断言。
> 所有结论都来自本地可复现命令的输出，未验证项单列。

---

## 0. 缺陷总览

| # | 缺陷 | 根因 | 验证方式 | 结果 |
|---|---|---|---|---|
| B1 | 端侧审计降级死锁 | 15s 看门狗只写错误信息、**不置 isReady=true** → 面板按钮永久 disabled；classify 无超时；runAudit 拿到 null 无法继续 | 代码修复 + 运行时探针（按钮可用） | ✅ |
| B1b | Worker 模型并发重复初始化 | `ensureModel` 只判 `modelHandle !== null`，await 期间两次调用都走初始化 | 单例 Promise 去重 | ✅（代码级） |
| B2 | MCP 真集群路径 | namespace 写死 `default`；404/409 被当成功；kubectl 回执与实际动作不一致（DELETE pod 却写 rollout restart） | `scripts/verify-mcp-execute.mjs`（假 K8s Server） | ✅ 20/20 |
| B3 | ActionConfirm 目标静默替换 | 目标不存在时回退 `snapshot.pods[0]` 继续执行 | 代码级（确认对象=执行对象） | ✅（无稳定 E2E，见风险） |
| B4 | 脱敏器漏凭证 / 计数虚增 | URL 密码含未转义 `@` 只匹配到第一个 `@`；占位符二次命中导致 maskedCount 虚增 | `scripts/verify-sanitizer.mjs`（31 条断言） | ✅ 31/31 |
| B5 | 端侧运行时诚实标注 | 只有 WebGPU/WASM 两态，builtin 被标成 `wasm` | `scripts/probe-edge-runtime.mjs` + 白皮书 7.6 | ✅ 3/3 |

---

## 1. B1 · 端侧审计降级死锁

### 根因

`useEdgeLogClassifier.ts` 的 15 秒就绪看门狗内：

```ts
setIsReady((ready) => {
  if (ready) return ready;
  setError('端侧推理 Worker 未能及时就绪，已降级为主线程推理');
  ...
  return false;   // ← 关键：返回 false，isReady 永远是 false
});
```

`isReady` 是面板所有审计按钮的 `disabled` 门禁，因此"已降级"的提示永远没有
机会展示——用户看到的是一个**永久灰掉的面板**。同时 `classify()` 没有超时，
若 Worker 永久挂起，返回的 Promise 永远不 resolve。

### 修复

| 项 | 修复 |
|---|---|
| 看门狗 | `isReady=true` + `runtime='builtin'` + `statusLabel='TIMEOUT'` + `isFallback=true`，并在途请求立刻用内置分类器返回 |
| 单批超时 | `EDGE_BATCH_TIMEOUT_MS=3000`；超时用 `classifyLogsWithBuiltin` 产出结果，`telemetryTransientRef.glStats.workerStatus='endless-classify-timeout'` 标记 |
| Worker 异常 | `error` 事件与 `worker.addEventListener('error')` 都以内置分类器结果 resolve（不再返回 null） |
| Worker 不可用 | `worker === null` 时直接内置分类器返回 |
| 并发上限 1 | pending 只允许一个；新增 `cancelClassify()` 取消出口 |
| 初始化去重 | `logClassifier.worker.ts` 的 `ensureModel` 改用**单例 Promise** |

内置分类器从 Worker 抽取到 `src/utils/builtinLogClassifier.ts`，Worker 与主线程兜底共用
同一份权重表——否则同一条日志在两条路径上会得到不同标签。

### 验证

```
$ node scripts/probe-edge-runtime.mjs
  快照: {"runtime":"webgpu","badgeLabel":"WebGPU","runtimeLineShown":true,
        "auditButtonFound":true,"auditButtonDisabled":false,"bodyHasFallback":true}
  ✓ 运行时徽标为三态之一  ::  data-runtime=webgpu · WebGPU
  ✓ 面板明确显示"当前运行时"文字
  ✓ 审计按钮可用（未因 isReady 死锁永久禁用）
汇总: 通过 3 · 失败 0
```

> 说明：本机环境 WebGPU 可用，因此走的是正常路径；**15s 超时分支**没有在真机
> 上被触发（需要把 Worker chunk 打坏）。该分支的修复由类型/状态断言 + 代码审阅保证，
> 列为"未运行时验证"。

---

## 2. B2 · MCP 真集群路径

### 根因（三个独立缺陷）

1. `executeAgainstRealCluster` 的 REST 路径写死 `/api/v1/namespaces/default/pods/...`；
2. `if (status === 404) return 'pod already absent (equivalent to restarted)'` —— 把
   "目标不存在"当成"重启成功"；
3. `buildKubectlCommand('restart_pod')` 返回 `kubectl rollout restart deployment/...`，
   而实际执行的是 `DELETE pod` —— 回执与动作影响面完全不同。

### 修复

- 请求体新增 `namespace` / `replicas`；ActionConfirm 从**当前快照**解析 Pod 的 namespace 后上送；
- live 模式缺 namespace → **400 拒绝**（不猜 `default`）；simulated 才允许缺省并在 note 标注
  `[assumed in simulated mode]`；
- 非 2xx 一律抛 `K8sHttpError`，JSON-RPC 返回 `-32603` + `data.httpStatus`，
  4xx 上游对应 HTTP 502、5xx 对应 500；
- `restart_pod` 回执改为 `kubectl delete pod/<name> -n <ns> --wait=false`；
  `scale` 的 `--replicas` 与 PATCH 的 `spec.replicas` 同值；
- `auditDigest` 公式不变：`sha256(executionId|actionType|targetId|timestamp|kubectlCommand)` 前 16 位。

### 验证（假 K8s Server，覆盖 404 分支）

```
$ node scripts/verify-mcp-execute.mjs
▸ A. 模拟模式回执（3000，无 K8S 配置）
  ✓ A1 HTTP 200  ✓ A2 mode=simulated
  ✓ A3 restart_pod 回执是 delete pod（与实现一致）
     :: "kubectl delete pod/payment-gateway-7f8b9-x2k -n kv-prod --wait=false"
  ✓ A4 回执 note 记录 namespace
  ✓ A5 auditDigest 可独立复算  ::  "1fabeaef52496d02"
  ✓ A6 摘要改动任一字段即变化
▸ B. scale 的 replicas 与回执一致（模拟模式）
  ✓ B1 :: "kubectl scale deployment/payment-gateway-7f8b9-x2k -n kv-prod --replicas=5"
▸ C. 真实模式：上游 404 必须报错（3002 → 假 K8s）
  ✓ C1 HTTP 502（上游 4xx）
  ✓ C2 JSON-RPC error -32603
  ✓ C3 error data 带 httpStatus=404
  ✓ C4 404 未被当作成功
  ✓ C5 删的是请求指定 namespace
▸ D. 真实模式：缺 namespace 直接拒绝（不猜 default）
  ✓ D1 HTTP 400  ✓ D2 -32602  ✓ D3 理由提到 namespace
▸ E. 真实模式：scale 成功回执 replicas 与 PATCH 一致
  ✓ E1 HTTP 200  ✓ E2 mode=real  ✓ E3 --replicas=4  ✓ E4 摘要可复算 "1224a63326ff1391"
汇总: 通过 20 · 失败 0
```

### auditDigest 复算示例

公式（与 `route.ts` 逐字一致）：

```text
auditDigest = sha256( executionId | actionType | targetId | timestamp | kubectlCommand ).slice(0, 16)
```

Node 一行复算：

```bash
node -e "const c=require('crypto');const s=process.argv.slice(1).join('|');console.log(c.createHash('sha256').update(s).digest('hex').slice(0,16))" \
  <executionId> <actionType> <targetId> <timestamp> "<kubectlCommand>"
```

上例实测值：`1fabeaef52496d02`（simulated restart_pod）。

---

## 3. B3 · ActionConfirm 目标静默替换

### 根因

```ts
const effectiveTargetId = targetExists
  ? targetId
  : snapshot.pods[0]?.id ?? snapshot.nodes[0]?.id ?? null;   // ← 静默替换
```

用户确认的是 A，实际执行的是列表第一个 Pod B —— 比"执行失败"严重得多的越权副作用。

### 修复

- 目标不存在 → **停在确认态**并提示"目标已不存在于当前快照，请重新诊断后确认"，
  终端追加 `[MCP-ROUTER] ABORTED ... target ... not in current snapshot`；
- 不再回退任何其它实体；确认对象 === 执行对象（`effectiveTargetId = targetId`）。

### 验证

代码级 + `tsc` 通过。**未做稳定 E2E**：要构造"确认后目标消失"需要同时操纵
store 快照与流式遥测（SSE 每帧会重建 snapshotSummary，会把手工删除的 Pod 刷回来），
当前环境没有可靠手段，如实标注。

---

## 4. B4 · 脱敏器

### 根因

1. URL 凭证密码段 `[^\s@/]+` 遇到未转义 `@` 只匹配到第一个，剩余片段被邮箱规则误伤：
   `postgres://svc:p@ssw0rd@db.internal` → `postgres://[REDACTED_CREDENTIAL]@[REDACTED_EMAIL]:5432/app`；
2. 幂等只是**注释声称**：`password-field` 会二次命中 `db_password=[REDACTED_PASSWORD]`，
   导致 `maskedCount` 虚增 1；
3. JSON 形态 `"password": "hunter2"` 因键名闭合引号在分隔符之前而漏匹配。

### 修复

- 密码段改贪婪 `[^\s/]+`，回溯到 host 前的最后一个 `@`；
- 键名允许可选闭合引号：`["']?\s*[=:]`；
- 替换改为回调：match 已含 `[REDACTED_*]` / `[MASKED_*]` 占位符 → 原样返回、**不计数**；
- 占位符识别正则 `PLACEHOLDER_TEST = /\[(?:REDACTED|MASKED)_[A-Z_]+\]/`。

### 验证（修复前 → 修复后）

修复前（红）：

```
$ node scripts/verify-sanitizer.mjs
  ✗ 2.1 含 @ 的密码整体被替换
      期望="dsn=postgres://[REDACTED_CREDENTIAL]@db.internal:5432/app"
      实际="dsn=postgres://[REDACTED_CREDENTIAL]@[REDACTED_EMAIL]:5432/app"
  ✗ 6.2 密码字段二次脱敏计数为 0   期望=0 实际=1
  ✗ 7.1 JSON 引号密码被替换        期望=true 实际=false
汇总: 通过 28 · 失败 3
```

修复后（绿）：

```
$ node scripts/verify-sanitizer.mjs
  ... 31 条断言全部通过 ...
  耗时 2.44ms（10 万字符，同步）
汇总: 通过 31 · 失败 0
```

用例覆盖：URL 凭证（基础 / 含 `@` / 多 `@` / 幂等）、密码字段（基础 / 幂等 / JSON 引号）、
IP / JWT / 云密钥 / 邮箱的脱敏与幂等、Unicode 密码与中文正文、10 万字符超长输入、
批量累计一致性、`hasSensitiveData` 与 `sanitizeLog` 口径一致。

---

## 5. B5 · 端侧运行时诚实标注

### 修复

- `ClassifierRuntime` 扩展为 `'webgpu' | 'wasm' | 'builtin'`；
- 面板徽标三态：`WebGPU` / `WASM SIMD` / `内置分类器`，带
  `data-runtime` 与 `aria-label="当前端侧运行时：…"`；
- 面板常驻一行"当前运行时：X（端侧模型参与推理 / 模型未加载，规则引擎兜底）"；
- 白皮书新增 **7.6 端侧运行时三态**，明确 builtin 的 0.07ms 延迟**不是**神经网络推理延迟。

### 验证

`probe-edge-runtime`：`data-runtime=webgpu`、`runtimeLineShown=true`、按钮可用 —— 3/3。

---

## 6. 回归

| 项目 | 结果 |
|---|---|
| `tsc --noEmit` | 0 错误 |
| `next lint` | 干净 |
| `verify-sanitizer` | 31/31 |
| `verify-mcp-execute` | 20/20 |
| `probe-edge-runtime` | 3/3 |

---

## 7. 未验证项与风险

1. **B1 的 15 秒看门狗分支**没有真机触发（需破坏 Worker chunk）；修复由状态断言与代码保证。
2. **B1b 单例 Promise 去重**无自动化断言（Worker 内部状态不可观测），仅代码级。
3. **B3 无 E2E**：SSE 每帧重建快照，手工删除目标会被刷回；需要给 store 加"暂停遥测"测试钩子才能稳定复现。
4. **B2 的真实集群来自假 K8s Server**，验证的是"端点如何响应 404/200"，不是真实 K8s 权限/RBAC 行为。
5. **B5 当前只观测到 webgpu 一态**；wasm / builtin 三态的展示逻辑由类型收窄与回退路径保证，
   真机无 GPU 环境才能看到另外两态。

---

## 8. 回滚

```bash
git revert --no-edit <本轮 commit>
git reset --hard 992580a     # 回到 r17（流式协议修复）
git reset --hard v12-baseline
```