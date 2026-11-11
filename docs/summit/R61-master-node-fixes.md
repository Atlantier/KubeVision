# R61 · MasterNode3D 等离子 pow / 中心多层叠加 / 铭牌重叠修复

> 文件：`src/components/canvas/MasterNode3D.tsx`
> 症状：等离子 `pow(0, 2.2)` 与 normalize 零向量风险；中心 19 层同心发光叠加导致严重过曝；选中 master 时控制平面铭牌与 `worker-alpha` 铭牌完全重叠。

## 1. 等离子着色器

- 在 `PLASMA_FRAGMENT_SHADER` 中加入 `safeNormalize(vec3 v, vec3 fallback)`（`lenSq > 1e-8` 才归一化）。
- 原：
  ```glsl
  vec3 n = normalize(vViewNormal);
  vec3 v = normalize(vViewPosition);
  float viewDot = max(0.0, dot(n, v));
  ```
  改为：
  ```glsl
  vec3 n = safeNormalize(vViewNormal, vec3(0.0, 0.0, 1.0));
  vec3 v = safeNormalize(vViewPosition, vec3(0.0, 0.0, 1.0));
  float viewDot = clamp(dot(n, v), 1.0e-4, 1.0);
  ```
  这样 `pow(viewDot, 3.2)` / `pow(viewDot, 1.35)` 的底数恒 ≥ 1e-4，不会再收到 0 或 NaN。

## 2. 清理与 CrystalOptics 重复的旧八面体层

当前仓库的 MasterNode3D 实际不是"19 层"（也没有名为 `coreMaterial` / `shellMaterial` /
`wireframeMaterial` 的独立变量，旧层是内联 JSX 材质）。本轮从渲染树移除的重复层：

1. 外层水晶壳（八面体面片 + 双层 Edges）
2. 6 顶点菱形星芒锚点（旧"焊点层"）
3. 二十面体测地线量子内胆
4. 双向正交刻度星轨环 A/B
5. 内层反向晶核（旧 core 层）
6. 三轴陀螺仪轨道环
7. 环绕微光星火（36 颗）
8. 内部 360 粒子星云
9. 内部神经晶格连线
10. 中心白色高光球（与 CrystalOptics 内核重复）

只保留 **1 层极细战术外轮廓**：
- `outerCageGeometry = new THREE.EdgesGeometry(new THREE.OctahedronGeometry(OCTA_RADIUS, 0))`
  （只取 12 条真实棱，避免 wireframe 的面对角线）；
- `wireframeMaterial = new THREE.LineBasicMaterial({ color: GLOW_ICE, transparent, opacity: 0.38, depthWrite: false, blending: AdditiveBlending, toneMapped: false })`；
- `<lineSegments ref={cageRef} geometry={outerCageGeometry} material={wireframeMaterial} … />`；
- 与 `<CrystalOptics />` 协同，不再有两套晶核/星云/陀螺环同心叠加。

**HoloPillarMaterial 说明**：当前仓库不存在 `HoloPillarMaterial`（全仓库 grep 0），也没有顶部反向光锥；
唯一的光柱是 R29 的 `<cylinderGeometry>` 加色光柱，opacity 已经是 **0.35**（低于任务要求的 0.42），
因此没有可下调的 0.78 乘数；按"不得虚构常量/不反向提亮"原则未改。

## 3. 铭牌重叠

- `LABEL_POSITION`：`[0, -1.96, 1.48]` → `[-2.35, -1.55, 0.85]`，锚定到晶核左下方，
  避开选中 master（相机 `[0, 5.2, 7.6]`）时正前方 `worker-alpha` 铭牌的投影水平线。
- `<Html>` 恢复/设置为：
  ```tsx
  <Html
    position={[LABEL_POSITION[0], LABEL_POSITION[1], LABEL_POSITION[2]]}
    center
    distanceFactor={15}
    zIndexRange={[10, 0]}
    className="pointer-events-none"
    style={{ pointerEvents: 'none' }}
  >
  ```
- 新增右上角 45° 折角战术引线（纯 SVG，`aria-hidden` + `pointer-events-none`，不可点击），
  指向晶核中心；同时移除面板的 `overflow-hidden`，避免引线被裁掉。
- 实拍确认：控制平面铭牌位于画面左中，`worker-alpha` 铭牌在左下，两者不再重叠。

## 4. 验证（真实执行）

- `npx tsc -p tsconfig.json --noEmit --incremental false` → **0 error**
- `npx next lint` → **No ESLint warnings or errors**
- `node scripts/lint-glsl.mjs` → **0 处 HIGH**
- `node scripts/verify.mjs --quick` → **7/7 通过**
- 实拍：
  - SwiftShader：`docs/summit/shots/r61-master/crystal-1920x1080.png`（选中 master）、
    `overview-1920x1080.png`；`ctxLost=false`、`console error=0`，无中心过曝/黑块；
  - D3D11 真实 ANGLE→HLSL：`docs/summit/shots/r61-master-d3d11/crystal-1920x1080.png`，
    renderer = `ANGLE (NVIDIA GeForce RTX 5070 Laptop GPU, Direct3D11 vs_5_0 ps_5_0, D3D11)`，
    过曝 **0.02%**，`ctxLost=false`，`console error=0`。
- 亮度直方图：crystal 场景均值约 21、过曝 0.04~0.05%（修复前中心白斑显著更高）。

## 5. 未验证 / 风险

1. 当前文件仍保留被删层的 refs / useFrame 空守卫与部分几何 useMemo（视觉不再渲染、`ref=null` 时安全跳过），
   未在本轮彻底删除，以避免大范围重构引入回归；这是已知的"清理不彻底"残留，下一轮可单独做
   dead-code cleanup（dead-exports 检查不会报错，因为 refs 仍被 useFrame 引用）。
2. 任务描述的 19 层与 `coreMaterial/shellMaterial/HoloPillarMaterial` 在当前仓库不存在，已按实际内联层清单处理；
   未虚构不存在的材质名。
3. 移除旧层后 Master 中心只剩 1 层线框 + CrystalOptics + 等离子核 + 地面光柱，视觉密度明显降低；
   这是"消除过曝"的预期取舍，若答辩需要更丰富细节应通过 CrystalOptics 内部加层，而不是恢复旧同心壳。
4. 首次 crystal 截图曾出现一帧 canvas 未合成的全黑（重试即正常，`ctxLost=false`、`error=0`），
   判定为无头捕获时序抖动，不是本轮代码回归；已在文档记录，不作为通过依据。
5. D3D11 仅覆盖本机 NVIDIA 驱动。

## 6. 回滚

```bash
git revert --no-edit <本轮 commit>
git reset --hard 08ecd82   # R60 CrystalOptics 修复
```