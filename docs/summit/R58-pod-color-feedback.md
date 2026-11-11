# R58 · Pod 实例色帧间正反馈指数爆炸修复

> 文件：`src/components/canvas/PodInstancedMesh.tsx`
> 症状：屏幕中央阶梯状纯黑块 + 剧烈过曝（Bloom `mipmapBlur` 放大）
> 结论：已切断 `instanceColor` 的帧间乘性正反馈，加入持久化「未调制基色」与写前有限值/亮度钳制。

## 1. 根因（数学）

旧实现每帧：

```text
tempColor = getColorAt(i)                 // 读到上一帧已乘增益的 GPU 色值
tempColor.lerp(target, α)
tempColor *= distanceGain                 // 近景最高 1.22
tempColor *= faultBreath                  // 故障期最高 1.35（合计 1.65）
setColorAt(i, tempColor)                  // 又写回 instanceColor
```

于是第 n 帧颜色 ≈ `base · (1.10~1.47)^n`：

- 相机选中 `master` 时对 `worker-alpha` 距离约 5.5m，`distanceGain = 1.22`；
- 路演 OOM 故障期 `distanceGain × faultBreath ≈ 1.65`；
- 约 0.5s（30 帧）后超过 HalfFloatType 上限 `65504` → `Infinity` / `NaN`；
- `<Bloom mipmapBlur />` 把异常像素扩散成覆盖屏幕中央的阶梯状黑块（非有限值在 bloom 链里被夹成 0 或 NaN 传播）。

## 2. 修复（R58）

1. **持久化未调制基色**：新增
   - `smoothedBaseColorsRef = useRef(new Float32Array(MAX_POD_INSTANCES * 3))`
   - `baseColorsInitializedRef = useRef(false)`
2. **挂载初始化同步写入基色**：`useEffect` 首次 `setColorAt` 时把 `tempColor.r/g/b` 写入基色缓冲，并置 `baseColorsInitializedRef = true`。
3. **useFrame 帧序改为**：
   - 从 `smoothedBaseColorsRef` 读**上一帧未调制基色**（未初始化时用本帧目标色兜底）；
   - `tempColor.lerp(tempTargetColor, colorAlpha)`；
   - **立即把平滑后的纯净基色写回缓冲**（绝不写 `distanceGain` / `faultBreath`）；
   - 再乘距离增益与故障呼吸；
   - 写入 GPU 前做严格钳制：
     ```ts
     tempColor.r = Number.isFinite(tempColor.r) ? Math.min(2.2, Math.max(0, tempColor.r)) : 0.2;
     tempColor.g = Number.isFinite(tempColor.g) ? Math.min(2.2, Math.max(0, tempColor.g)) : 0.5;
     tempColor.b = Number.isFinite(tempColor.b) ? Math.min(2.2, Math.max(0, tempColor.b)) : 0.5;
     ```
4. **下调距离增益**：`POD_DEPTH_BASE 1.18 → 1.03`、`POD_DEPTH_MAX 1.22 → 1.08`、斜率 `0.045 → 0.02`，叠加故障呼吸后上限约 `1.08 × 1.35 ≈ 1.46`，再经 2.2 钳制，不再可能指数放大。
5. **保留原有功能**：LED 状态点、故障线框笼、能量内芯、Hover 脉冲、射线拾取、中文 JSDoc 全部保留；`useFrame` 内无 `useState` / `new THREE.*`。

## 3. 环境贴图强度说明（与任务描述的差异）

任务要求把 `POD_SHELL_ENV_INTENSITY` 从 2.2 降到 1.15、`POD_CLEARCOAT_ENV_INTENSITY` 从 2.8 降到 1.25。但当前仓库实际实现是：

- `PodInstancedMesh` 只有**一个** `meshStandardMaterial`，**没有** shell/clearcoat 双层材质；
- 全仓库 grep `POD_SHELL_ENV_INTENSITY` / `POD_CLEARCOAT_ENV_INTENSITY` = **0 处**；
- 现有唯一环境强度是 `envMapIntensity={0.3}`，已远低于 1.15 / 1.25。

若按任务数值“下调”到 1.15/1.25，反而会把 Pod 顶盖反光提高近 4 倍，与“防过曝”目标相反。因此本轮把它集中为常量 `POD_SHELL_ENV_INTENSITY = 0.3`（不提高），并在注释中写明原因；如后续改为 clearcoat 双层材质，再按 1.15/1.25 目标值落地。

## 4. 验证

- `npx tsc -p tsconfig.json --noEmit --incremental false` → **0 error**
- `npx next lint` → **No ESLint warnings or errors**
- 真实场景截图（`docs/summit/shots/r58-fix/`，1920×1080，shot.mjs 采集，`ctxLost=false`）：
  - `pod-closeup-1920x1080.png`：贴脸近景，无黑块、无 NaN 溢出；
  - `oom-1920x1080.png`：OOM 故障期（旧实现 1.65× 回路最易爆），红色故障语义正常、无中央黑块；
  - `crystal-1920x1080.png`：选中 master（相机距 worker-alpha 约 5.5m 的最坏距离增益场景），画面正常。
- shot 日志：`console error=0 warn=1`，`ctxLost=false`。

## 5. 未验证/风险

1. 截图是静态取帧，不能证明每一帧颜色缓冲都无 NaN；本轮靠“基色不回灌 + 写前钳制”在数学上切断回路，并做了最坏场景取帧；
2. 没有新增自动化断言直接读 `instanceColor` 缓冲（避免为测试改产品接口）；
3. 环境贴图强度的“2.2/2.8”目标值在本仓库不存在，已在 §3 说明，未虚构常量。

## 6. 回滚

```bash
git revert --no-edit <本轮 commit>
git reset --hard c9809dc   # v12-summit
```