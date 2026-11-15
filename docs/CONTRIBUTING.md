# 贡献指南（CONTRIBUTING）

> 本文件补充 `AGENTS.md` 的工程契约。冲突时以 `AGENTS.md` 为准。

## 1. 提交前必跑

```bash
pnpm typecheck                    # 类型必须 0 error（不允许 any / @ts-ignore）
pnpm lint                         # next lint 必须无 warning/error
pnpm lint:glsl                    # GLSL 着色器语法静态校验
node scripts/verify.mjs --quick   # 静态检查（tsc + lint + any 禁令 + GLSL + 死导出）
pnpm test:health                  # 健康分不变量单测（P0 必不升分）
```

涉及浏览器行为（3D/对话/语音/截图）与核心算法时，另跑：

```bash
node scripts/verify.mjs           # 完整 35 项浏览器回归（自动启停 dev server）
pnpm verify:rag && pnpm verify:sanitizer && pnpm verify:receipt
```

## 2. 指标与受控基准声明

**禁止手写或杜撰任何未采集的性能/质量数字**。`docs/performance.json`、`docs/rag-eval.json`、`docs/ai-quality.json` 为受控环境下采集的历史只读基准快照：

- 未实测的值写「未验证 / 未配置」，不得用估算值冒充；
- 运行 [`docs/SCRIPTS_INDEX.md`](SCRIPTS_INDEX.md) 中列出的全量静态与单元测试脚本验证当前代码改动（`pnpm verify:quick`、`pnpm verify:rag`、`pnpm verify:sanitizer`、`pnpm verify:receipt`、`pnpm test:demo:fast`、`pnpm test:chat-stream` 等）。

## 3. 视觉与样式改动门禁

改 3D 场景、发光、材质、Tailwind Token 或玻璃态布局时：

1. 执行 `pnpm build && node scripts/check-style-contract.mjs --require-build` 确保样式令牌零漂移、Tailwind 生产 CSS 类全量生成；
2. 人工复核 1366×768 与 1920×1080 视口显示与 `node scripts/verify.mjs` 浏览器无黑屏/零 console error 回归。

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
- 根目录只保留必要入口文档（`README.md` / `AGENTS.md` / `启动说明.md` / `LICENSE` / `THIRD_PARTY_NOTICES.md`）；工程说明与快照报告统一放在 `docs/` 目录。
## 7. 治理脚本（CI 应全绿）

```bash
pnpm lint:glsl                                      # 自定义 GLSL 着色器校验
pnpm check:dead-exports                             # 死导出：仅拦截"新增"死代码（基线 docs/dead-exports-baseline.json）
pnpm build && node scripts/check-style-contract.mjs --require-build  # 样式令牌、Tailwind 动态类拼接与生产 CSS 全量覆盖校验
```

- 活跃脚本完整清单见 [`docs/SCRIPTS_INDEX.md`](SCRIPTS_INDEX.md)；
- 新增死导出会被 `check:dead-exports` 直接拒绝；确认是存量债才允许 `--update-baseline`；
- 样式契约与构建体积需配合先 `pnpm build` 校验。
