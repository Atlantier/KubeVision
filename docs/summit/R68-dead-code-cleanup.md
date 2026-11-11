# R68 · 全项目 dead-code 清理 + 严格未使用门禁

> 目标：清理 `--noUnusedLocals/--noUnusedParameters` 暴露的未使用声明，并把这两项纳入项目 `tsc` 门禁，防止回归。

## 1. 清理清单

共清理 **33 处**（首轮 28 处 + 级联 5 处）：

### API / 页面 / UI
- `src/app/api/chat/route.ts`：移除未使用的 `AgentSpan` 类型导入；`repairPendingToolCalls(...)` 保留调用，仅删除无人读取的 `const repaired =` 赋值。
- `src/app/page.tsx`：移除未使用的 `target` / `inInput` 计算（键盘处理逻辑未使用该变量，无行为变化）。
- `src/components/ai/CopilotDrawer.tsx`：移除未使用的 `ChatErrorCategory` 类型。
- `src/components/ai/GenUI/ActionConfirm.tsx`：移除未使用的 `lastAssistantMessageId` 订阅。
- `src/components/hud/ChaosControlModal.tsx`：移除未使用的 `useEffect` 导入。
- `src/components/layout/ShellLayout.tsx`：移除未使用的 `activeRightTab` selector。
- `src/components/layout/TopBar.tsx`：移除未使用的 `FINISHED_AUTO_COLLAPSE_MS` 导入。

### Hooks / Store
- `src/hooks/useInViewPause.ts`：移除未使用的 `useRef`。
- `src/hooks/useTelemetryStream.ts`：移除未使用的 `clearFrameBuffer` 导入。
- `src/store/useClusterStore.ts`：移除整条未使用的 React 导入与 `PendingRemediation` 类型。

### Canvas
- `src/components/canvas/ArcStartGlow3D.tsx`：移除未使用的 `useMemo`。
- `src/components/canvas/ClusterCanvas.tsx`：移除 R62 后不再使用的 `REFLECTOR_RESOLUTION`、`qualityBloomLevels`、`qualityBloomIntensity`。
- `src/components/canvas/GroundHorizonFade.tsx`：移除未使用的 `FADE_INNER_RADIUS`。
- `src/components/canvas/MasterNode3D.tsx`：
  - 移除 `CORE_CRYSTAL_RADIUS`、`NUCLEUS_RADIUS`、`CAGE_SPIN_RATE`、`CAGE_SCALE`；
  - 移除两段不再挂载的 `CONSTELLATION_VERTEX/FRAGMENT_SHADER`；
  - 移除 `icosaCoreGeometry`（已改为几何内联）与旧 `gimbalTickMatrices`（已改为 `gimbalTickGeometry`）；
  - 级联移除 `ICOSA_CORE_RADIUS`、`ICOSA_CORE_DETAIL`、`GIMBAL_RING_RADIUS`、`GIMBAL_TICK_LENGTH_A/B`。

### 导演引擎
- `src/utils/demoDirector.ts`：移除未使用的 `ChaosScenario` 类型导入；`enterHeal(label)` 的 `label` 参数未被使用，改为无参 `enterHeal()` 并更新 3 处调用。

## 2. 门禁加固

`tsconfig.json`：

```json
"strict": true,
"noUnusedLocals": true,
"noUnusedParameters": true,
...
"exclude": ["node_modules", "release"]
```

- 把“未使用局部变量/参数”从“额外扫描”升级为项目门禁，今后 `npx tsc --noEmit` 会直接拦截。
- `release/` 是 `.gitignore` 中的离线打包副本（含旧版本源码），不属于项目源码；将其排除出类型检查，避免生成物重复报错，未删除该目录。

## 3. 验证

```text
npx tsc --noEmit          → exit 0，0 行输出（现包含 noUnused 门禁）
npx next lint             → No ESLint warnings or errors
npx next build            → exit 0（Compiled successfully，4/4 static pages，First Load 177 kB）
node scripts/verify.mjs --quick → 7/7 通过
node scripts/run-demo-tests.mjs → pass 11 / fail 0
```

- 清理只删除未被读取的声明/赋值，保留所有副作用调用（如 `repairPendingToolCalls`）。
- 未改动视觉/交互参数；MasterNode3D 的几何与材质参数保持不变。

## 4. 风险

1. `noUnusedParameters` 对回调参数较严格，未来新增只使用部分参数的函数可能需要 `_` 前缀或精简签名。
2. `release/` 被排除后，若有人手动修改离线包源码，不会得到本项目的类型门禁保护；离线包应在打包流程内单独验证。
3. 本轮未处理 `check-dead-exports` 基线中的 18 条历史死导出（工具显示“无新增”）；如需清零可另开一轮（涉及公开 API 判断，需单独评审）。

## 5. 回滚

```bash
git revert --no-edit <本轮 commit>
git reset --hard e0f5525   # R67 Master 复原
```