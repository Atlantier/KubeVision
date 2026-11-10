# 贡献指南（CONTRIBUTING）

> 本文件补充 `AGENTS.md` 的工程契约。冲突时以 `AGENTS.md` 为准。

## 1. 提交前必跑

```bash
pnpm tsc --noEmit                 # 类型必须 0 error（不允许 any / @ts-ignore）
pnpm lint                         # next lint 必须无 warning/error
node scripts/verify.mjs --quick   # 静态检查（tsc + lint + any 禁令 + GLSL + A11y/emoji）
pnpm test:health                  # 健康分不变量单测（P0 必不升分）
```

涉及浏览器行为（3D/对话/语音/截图）时，另跑：

```bash
node scripts/verify.mjs           # 完整浏览器回归（需要 dev server 在 3000）
node scripts/verify-demo.mjs      # 3 分钟演示动线
```

## 2. 指标必须由脚本生成

**禁止手写任何性能/质量数字**。README 与白皮书中的指标区块由脚本回填：

```bash
node scripts/sync-docs-metrics.mjs   # 读取 docs/*.json，回填 README 与白皮书
node scripts/eval-rag.mjs            # RAG 召回评测（自动回填 METRICS）
pnpm eval:ai-quality                 # AI 质量 20 问（需可用的 OpenAI 兼容网关）
```

- 未实测的值写「未验证 / 未配置」，不得用估算值冒充；
- 两次运行结果不一致（非确定性）时，评测脚本必须失败而不是静默通过。

## 3. 视觉改动必须附 A/B

改 3D 场景、发光、材质、布局时：

1. 用 `node scripts/shot.mjs` 在 **1366×768 与 1920×1080** 各截一张「改动前/改动后」；
2. 用 `node scripts/visual-diff.mjs` 生成差异图与像素占比；
3. PR/提交信息里贴出两张图路径与差异占比；未做 A/B 的视觉改动不合并。

## 4. 提交信息模板

```
<type>(<scope>): <一句话结论>

背景: <为什么改，引用缺陷/需求编号>
改动: <按文件/模块列出关键改动，说明取舍>
验证: <真实命令 + 关键输出；未验证项显式标注>
回滚: <git revert <sha> 或 git reset --hard <sha>>
```

- `type`：`feat` / `fix` / `perf` / `refactor` / `chore` / `docs`；
- 每一轮提交在标题或正文包含轮次号（如 `r52`）；
- 不允许「修复若干问题」这类无法核对的描述；
- 失败/未验证的检查必须写进提交信息，不能只写通过项。

## 5. 代码红线（摘自 AGENTS.md）

- 禁止 `any`、`@ts-ignore`、省略号占位、伪代码；
- `useFrame` 内禁止 `setState` / `new THREE.*`（预分配临时对象）；
- drei `<Html>` 必须 `zIndexRange={[10,0]}` 且容器 `pointer-events-none`；
- InstancedMesh 动态着色：基础色 `#ffffff`、`toneMapped={false}`、更新后置
  `instanceMatrix.needsUpdate` / `instanceColor.needsUpdate`；
- SSR 敏感逻辑（three/Worker/localStorage/SpeechRecognition）必须客户端边界；
- 新增依赖前先在 PR 说明理由与体积影响。

## 6. 文档与死链

- 新增 API 路由必须同步 `README.md` 的 API 清单；
- 移动/删除文档时用 `grep -rn` 检查代码与文档引用，避免悬空链接；
- 根目录只保留 `README.md` / `AGENTS.md` / `CONTRIBUTING.md` / `LICENSE` /
  `THIRD_PARTY_NOTICES.md`；历史报告归档到 `docs/archive/`。
## 7. 治理脚本（CI 应全绿）

```bash
pnpm check:layering       # 分层依赖：utils 不依赖 components；canvas 不依赖 ai；api 不依赖 React
pnpm check:dead-exports   # 死导出：仅拦截"新增"死代码（基线 docs/dead-exports-baseline.json）
pnpm audit:deps           # 依赖未使用检查 + 首屏/3D/AI chunk 体积预算（读 .next/ 生产产物）
```

- 白名单/预算集中在一处：分层例外在 `scripts/check-layering.mjs` 的 `LAYER_ALLOWLIST`，
  体积预算在 `scripts/audit-deps.mjs` 的 `BUDGETS`；调整必须在 PR 说明理由。
- 新增死导出会被 `check:dead-exports` 直接拒绝；确认是存量债才允许 `--update-baseline`。
- 体积审计需先 `pnpm build`；CI 用 `node scripts/audit-deps.mjs --strict` 让超限真正失败。
