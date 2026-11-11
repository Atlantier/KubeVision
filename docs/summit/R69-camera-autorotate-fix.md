# R69 · 路演后半段镜头拉锯（autoRotate vs 飞行插值）修复

> 文件：`src/components/canvas/CameraRig.tsx`、`src/components/ai/GenUI/ActionConfirm.tsx`、`src/utils/demoDirector.ts`
> 症状：剧本路演后半段/镜头切换时相机高频左右晃动，直到手动点击画布才恢复。

## 1. 根因

`OrbitControls autoRotate` 与 `CameraRig` 的飞行阻尼同时生效：

- 飞行 `useFrame` 每帧把相机拉向 `targetPosVec`；
- `OrbitControls.update()` 每帧沿水平轨道把相机推开；
- 二者形成永久平衡，相机距目标停在 0.8~1.4，永远大于 `ARRIVAL_EPSILON=0.15`，
  `isAnimatingRef` 无法归零 → 持续晃动。

尤其当导演用 `setOrbitPatrolActive(true, 'programmatic')` 开巡检时，
`disengagePatrolIfActive()` 因 `patrolLockedByProgram` 提前返回，飞行起飞时
autoRotate 没有被关闭。

## 2. 修复

### 2.1 `CameraRig.tsx` 四阶段状态机

`useFrame` 内明确控制 `controlsRef.current.autoRotate`：

1. **开场推镜（`!openingDoneRef`）**：
   - 插值前 `autoRotate = false`；
   - 开场完成时从 Store 恢复
     `useClusterStore.getState().isOrbitPatrolActive`（不硬编码 true）。
2. **焦点飞行（`isAnimatingRef === true`）**：
   - 每帧插值开始显式 `controls.autoRotate = false`；
   - 新增 `flightElapsedRef` 与 `MAX_FLIGHT_DURATION = 3.2s` 超时收敛。
3. **抵达/超时**：
   - `posError < ARRIVAL_EPSILON` 时吸附终点；
   - 超时则保留当前真实机位（不瞬移）；
   - 两条路径都 `isAnimatingRef=false`，并立即从 Store 恢复 autoRotate，
     让巡检从当前机位接续，不再回拉固定坐标。
4. **自由态（`!isAnimating && openingDone`）**：
   - 每帧将 `autoRotate` 同步为 Store 的真实巡检状态。

### 2.2 手动接管无条件解锁

`OrbitControls 'start'` 的 `handleUserTakeover` 不再调用
`disengagePatrolIfActive()`（会被 programmatic 锁拦截），改为：

```ts
const store = useClusterStore.getState();
if (store.isOrbitPatrolActive) {
  store.setOrbitPatrolActive(false, 'user');
}
```

`setOrbitPatrolActive(false, 'user')` 同时清除 `patrolLockedByProgram`，
用户拖拽/点击画布后 autoRotate 立即关闭，手动操作最高优先级。

### 2.3 `ActionConfirm.tsx` 自动路演不抢镜头

步骤 4 的 `selectEntity(effectiveTargetId, effectiveEntityType)` 增加：

```ts
if (!useClusterStore.getState().demoAutoConfirm) {
  selectEntity(effectiveTargetId, effectiveEntityType);
}
```

自动路演阶段 4（`demoAutoConfirm=true`）由导演统一回全景 + 巡检，卡片异步完成
不再把镜头拉回单个 Pod；手动执行（false）仍保留聚焦已自愈 Pod 的体验。

### 2.4 `demoDirector.ts` 收尾释放程序锁

`finishDemoDirector()` 中：

```ts
finishApi.setOrbitPatrolActive(true, 'user');
```

替代 `'programmatic'`，释放 `patrolLockedByProgram`，用户剧本结束后点击任意
节点/Pod 能正常退出巡检并聚焦。

## 3. 验证

```text
npx tsc --noEmit          → 0 error
npx next lint             → No ESLint warnings or errors
npx next build            → exit 0（Compiled successfully，4/4 static pages，First Load 177 kB）
node scripts/run-demo-tests.mjs → pass 11 / fail 0
node scripts/verify-demo.mjs    → 通过 20 · 失败 2
```

`verify-demo` 关键结果：

- J-1/J-2 全通过；
- J-3 自愈覆盖 3/3、动作卡终态 executed；
- **J-4 全流程零 console.error / 零未捕获异常：通过**（此前多次 `Uncaught`，本轮已消失）；
- J-5 连跑一致、无 QUEUED 免疫日志；
- 失败 2 项为既有：J-3 MCP 回执 actionType 读取为 null（测试回执取样时序）、
  J-6 pausedElapsedSec/resumedElapsedSec 读取 null（字幕格式，阶段单调本身通过）。

截图：`docs/summit/shots/r10-verify/phase2-lock.png`、`finished.png`。

## 4. 未验证 / 风险

1. 未新增“相机抖动帧差”自动化断言（相机未暴露给测试钩子）；本轮通过状态机
   收敛路径 + 真实路演回归验证，不能量化“晃动完全为 0”的像素级指标。
2. `MAX_FLIGHT_DURATION=3.2s` 为经验值；极慢设备上超时收敛可能表现为一次轻微
   视角接续，但不会永久拉锯。
3. 自动路演期间 `ActionConfirm` 不再聚焦单 Pod；手动模式行为不变。
4. J-3 MCP / J-6 elapsed 两项既有测试缺陷未在本轮修复。

## 5. 回滚

```bash
git revert --no-edit <本轮 commit>
git reset --hard 2458d2a   # R68 dead-code cleanup
```