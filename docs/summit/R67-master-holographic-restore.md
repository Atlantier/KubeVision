# R67 · MasterNode3D 多层全息晶核复原 + 铭牌居中

> 文件：`src/components/canvas/MasterNode3D.tsx`
> 目标：移除 CrystalOptics 单层替代方案，恢复中央控制平面的 9 层全息几何；铭牌回到晶核正下方，消除与机架标签的遮挡。

## 1. 移除 CrystalOptics / 恢复多层几何

- 删除 `CrystalOptics` 的 import 与 `<CrystalOptics />` 挂载。
- 不挂载任何 `ConeGeometry` 顶部假光锥；全文件 grep `ConeGeometry` = 0。
- 新增 `<group ref={floatGroupRef}>`，在 MASTER 根组内挂载全部层：
  1. 选中态六边形锁定框 `selectionRingRef`（ringGeometry 2.05/2.12/6，`#22d3ee`，opacity 0.7，Additive）；
  2. 脉冲波纹环 `pulseRingRef`（ringGeometry 1.0/1.08/64，水平放置，opacity 0，useFrame 驱动 scale/alpha）；
  3. 外层八面体 `outerRef`（1.45）+ `meshPhysicalMaterial`（transmission 0.72、opacity 0.28、emissive 0.45、DoubleSide、depthWrite false）+ `Edges`；
  4. 内层反向晶核 `coreRef`（scale 0.78，1.05）+ `meshStandardMaterial`（emissive 1.2、opacity 0.42）+ `Edges`；
  5. 二十面体测地线内胆 `icosaCoreRef`（icosahedron 0.72 detail 1，wireframe meshBasicMaterial opacity 0.32）；
  6. 等离子热核 `plasmaMatRef`（sphere 0.42，NormalBlending）；
  7. 360 颗星座点云 `constellationRef`（pointsMaterial 0.032）+ 28 条神经连线 `neuralRef`（lineBasicMaterial 0.38）；
  8. 三轴陀螺仪环（3× torus 1.55+idx*0.14，`gyroRefs`/`gyroMatRefs`）；
  9. 双正交 72 刻度万向节（group A/B + `gimbalTickGeometry` + 1.76 环体）；
  10. 6 顶点八面体锚点 `vertexAnchorRef`（单位八面体 + 实例矩阵缩到 0.055）与 36 颗环绕星火 `sparkRef`（InstancedMesh 八面体）；
  11. 底部光柱 `beamMatRef`、赤道环 `equatorRingRef`、极轨环 `polarRingRef(s)`、底座刻度环 `tickRingMatRef`。
- 所有 refs 均进入 `useFrame`：浮游组呼吸、选中框旋转、脉冲扩散、外壳/内核反向自转、等离子 uPulse、粒子/连线自转、陀螺/万向节旋转、锚点呼吸、星火旋转、光柱呼吸、地面环慢转。

## 2. 等离子 shader 防黑块/白块

- `PLASMA_VERTEX_SHADER` 新增 `safeNormalize`，`vViewNormal` 不再裸 `normalize`。
- `PLASMA_FRAGMENT_SHADER` 保留 `safeNormalize`、`pow(max(viewDot, 1.0e-4), …)`，输出 alpha 改为 `clamp(alpha, 0.0, 0.88)`，避免白块过曝。

## 3. 铭牌居中

- `LABEL_POSITION` 从 `[-2.35, -1.55, 0.85]` 恢复为 **`[0, -1.96, 1.48]`**（晶核正下方居中）。
- 移除右上角战术 SVG 引线。
- `<Html>` 严格使用：
  ```tsx
  <Html
    position={[LABEL_POSITION[0], LABEL_POSITION[1], LABEL_POSITION[2]]}
    center
    zIndexRange={[10, 0]}
    style={{ pointerEvents: 'none' }}
  >
  ```
  内部容器增加 `pointer-events-none`，不遮挡右侧抽屉/Modal。

## 4. 验证

```text
npx tsc --noEmit          → 0 error
npx next lint             → No ESLint warnings or errors
npx next build            → exit 0（Compiled successfully，4/4 static pages，First Load 177 kB）
```

真实 dev 页面截图（`docs/summit/shots/r67-master-restore/`）：

```text
crystal: 均值 20.6 过曝 0.05% ctxLost=false console error=0 warn=4
overview: 均值 20.0 过曝 0.05% ctxLost=false console error=0 warn=4
```

- 中央晶体恢复多层线框/晶面/等离子核/陀螺环/万向节/星火，无顶部假光锥；
- 铭牌位于晶核正下方，未与 worker 机架标签重叠；
- `warn=4` 为既有发光预算提示，不是黑块/报错。

## 5. 风险

1. 外层 `meshPhysicalMaterial transmission=0.72` 按需求恢复，会重新触发一次全场景
   transmission RT；在低端设备/软渲染上可能增加开销，需真机确认。
2. 旧的 `icosaCoreGeometry`/`gimbalTickMatrices` 已不再参与渲染，但仍留在文件中
   （不进入 useFrame）；下一轮可做 dead-code 清理。
3. `warn=4` 表示当前发光预算仍超设计值；本轮只保证不崩溃/不黑块，不调整预算数值。
4. 截图基于 SwiftShader；D3D11 未另拍，transmission 在真实 D3D11 路径需复验。

## 6. 回滚

```bash
git revert --no-edit <本轮 commit>
git reset --hard 5e6a95a   # R66 glow budget 修复
```