# R25 · MASTER 控制平面光学结构重塑 + 地平线消除

> 只改光学结构与地平线，不动几何风格、不新增依赖/资产。
> 旧的三件套（godray 双锥 + 竖直光柱 + 横向 flare）已整体删除，改为
> **封闭的 7 层能量结构**：能量在晶体内沿棱线与粒子流动，从棱中段漏出，
> 而不是向天空发射。

---

## 1. 删除清单与引用证据（A 项）

全仓 `grep` 证据（`docs/summit/artifacts/r25-deleted-inventory.txt`，恢复结果为 0）：

| 符号 | src 引用数（删除后） |
|---|---|
| `godRayTop` / `godRayBottom` / `GODRAY_*` | **0** |
| `PILLAR_GEOMETRY` / `pillarRef` | **0** |
| `FLARE_WIDTH` / `flareRef` | **0** |

同时删除：`GODRAY_TOP_HEIGHT`/`GODRAY_TOP_RADIUS`/`GODRAY_BOTTOM_*` 常量与
`GODRAY_VERTEX/FRAGMENT_SHADER`；`PILLAR_WIDTH/BOTTOM_Y/TOP_Y/HEIGHT/CENTER_Y`、
`PILLAR_GEOMETRY`、`PILLAR_VERTEX/FRAGMENT_SHADER`；`FLARE_WIDTH/HEIGHT`、
`FLARE_*_SHADER`、`FLARE_CORE/WING_*` 色温常量；以及 MasterNode3D 内对应的
refs（`godRayTop/BottomUniforms`、`flareUniforms`、`pillarRef`、`flareRef`）、
useFrame 动画与色温驱动、JSX 三段 mesh。**无死代码残留**（tsc/lint 通过）。

---

## 2. 新结构：7 层能量预算（B 项）

文件：`src/components/canvas/CrystalOptics.tsx`。

| 层 | 半径 | 混合 / 写法 | alpha 预算 | 实现要点 |
|---|---|---|---|---|
| 1 内核奇点 | 0.40 | Additive，depthWrite=false | **0.22** | 半径 0.4 二十面体；自写 3 倍频 3D simplex 噪声流动；中心近白 `#f0fdff` → 电光青 → 深蓝；`uBreath` 与 QPS 联动（幅值 ≤6%） |
| 2 体积雾球 | 0.95 | BackSide + Additive | **0.30** | `pow(max(dot(N,V),1e-4), 2.6)` 视角衰减，替代 godray 的"光感"，无棱角 |
| 3 晶体主体 | 1.05（Y×1.22） | 半透明，透明度 ≤0.28 | **0.28** | 法线+菲涅尔假折射 shader；**T3 且非软渲染**时切 `MeshPhysicalMaterial`（transmission .35 / ior 1.45 / thickness 1.2 / roughness .18），T2/T1/软渲染退回 Fresnel 假折射（先读 R10 档位：`?quality=high/balanced/low`） |
| 4 棱线 + 顶点锚点 | 1.42 / 1.54 | Additive LineSegments | **0.08** | 两层八面体线框（EdgesGeometry，避免面上斜线）；`aT` 沿边参数 + sin 脉冲流光；12 个顶点高光点 |
| 5 内部星云 | < 1.15 | Additive Points | **0.06** | 360 粒子、3 臂涡旋、黄金角错相；点大小随距相机衰减；**全部约束在晶体内部**（无外挂光） |
| 6 外层大气光晕 | 1.85 | BackSide + Additive | **0.20** | `pow(max(dot(N,V),1e-4), 3.8)`，仅轮廓泛光；3 道陀螺环（倾角错开，1.8s/0.9s/0.6s，3.6s 节拍整数分频） |
| 7 棱线漏光 `uLeak` | — | 叠加在层 4 | 含在 0.08 内 | 晶核脉冲时棱中段提亮并向两端扩散：`mid = exp(-((t-0.5)/0.22)^2)`，`alpha += uLeak*mid*1.8` —— **替代顶部光柱的关键**：能量沿结构流动而非向天空发射 |

**总 alpha 预算：0.22+0.30+0.28+0.08+0.06+0.20 = 1.14 ≤ 1.15**（R13 会再校）。

### 故障/高负载色温插值（C 项）

useFrame 内、预分配 `THREE.Color`、只 `lerp`：
- 健康 = 冰川青（`#38bdf8` / 内核 `#00f2fe`）
- 高负载（健康分 ≥70）→ 琥珀 `#fbbf24`
- 故障（<70）→ 绯红 `#f43f5e`
- 故障恢复后以 **1.2s** 缓动回冰川青（`RECOVERY_RATE = 1/1.2`，其余状态 k=2.2）
- 全程零 `new THREE.*`、零 setState。

### 弧线起点（B8 项）

- `NetworkStream3D`：`ARC_START_OFFSET` 0.65 → **1.05**（晶体赤道环半径），
  三条光缆从赤道环最近顶点抽出，不再"插在空中"；
- 新增 `ArcStartGlow3D`：每条弧线起点一个球状汇聚光斑，
  **0.15s 高亮窗口 / 1.5s 周期**（10% duty），窗口内亮度平方衰减、尺寸收缩
  （收敛而非爆开），相位按车道错开。

---

## 3. 深空地平线（D 项）

**方案选择：地面径向 alpha 渐隐，不改雾参数。**
理由：雾参数 (15,64) 被 verify 与 R10 `uFogFar=64` 的 shader 契约引用，
改动会牵连全部材质与验证基线；渐变方案在不动雾的前提下同样能消除地平线。

| 项 | 旧 | 新 |
|---|---|---|
| 背景色 / 雾色 | `#020815` | **`#020611`**（背景、雾、地面中心同色） |
| 地面圆盘半径 | 32 | **22** |
| 反射地面 color / roughness / metalness / mixStrength / mirror | `#030816` / .62 / .65 / 15 / .55 | **`#010308` / .35 / .88 / 9 / .45** |
| 地面边缘 | 直接截断 | **`GroundHorizonFade`：r∈[13,22] 径向 alpha 0→1 渐变到 #020611** |
| 外层大网格（r≈86，无限延伸） | 存在 | **删除**（地平线主要来源） |
| 内层细网格 | 44×44，fade 40 | **26×26，fade 13**（r>14 无可见地面装饰） |
| directionalLight 远端照亮 | — | 阴影正交范围此前已收至 ±13；主光不新增 castShadow，远端无额外照明 |

`GroundHorizonFade` 的 `smoothstep(13, 22, r)` 满足 R01 `edge0 < edge1`。

---

## 4. 验收与证据（E 项）

| 验收 | 结果 |
|---|---|
| `shot.mjs --scene crystal` | ✅ `docs/summit/shots/r25-crystal/crystal-1366x768.png`，glStats 4 FPS / 237.1ms / **408 draws / 199,220 tris**，console error=0 |
| `shot.mjs --scene overview` | ✅ `docs/summit/shots/r25-crystal/overview-1366x768.png`，5 FPS / 219.1ms / 408 draws / 199,220 tris，console error=0 |
| `probe-blackout` | ✅ **GREEN**：黑屏事件 0 / 采样 51 / 错误 0（1 轮） |
| `lint-glsl` | ✅ **HIGH 0 命中**（INFO 10 条为既有 dynamic-smoothstep 提示） |
| `verify.mjs` | ✅ **33/33**（340 meshes / 24 InstancedMesh / 363 geometries；2 FPS 为软渲染噪声） |
| `tsc` / `next lint` | ✅ 0 错误 / 干净 |

前后对比：
- 前：`docs/summit/shots/v12-baseline/overview-1920x1080.png`（R00 基线，
  可见 godray 光柱与远处网格地平线）
- 后：`docs/summit/shots/r25-crystal/overview-1366x768.png`（无光柱/无面片 flare，
  地面在 r≈13 后被背景吞没）
- 晶体近景：`crystal-1366x768.png`
- 说明：R00 基线未包含 crystal 近景，crystal 的"前"状态以 R23 的
  `r23-pipeline/overview-post.png` 为参照（同为旧结构），如实标注。

---

## 5. 未验证项与风险

1. **T3 physical transmission 未在真机验证**：本环境被判定为软渲染，走 Fresnel 假折射；
   `MeshPhysicalMaterial` 分支仅经 tsc/lint 与代码审阅。
2. **性能数据来自 SwiftShader**：4–5 FPS 不代表真机；draw calls 408 与改前 398 基本持平
   （新增 7 层结构的同时删除了 3 段旧结构），triangles +10.6k。
3. **crystal 场景无 R00 同级基线**：前后对比使用 v12-baseline overview + R23 overview 作参照。
4. **"能量预算"是结构上限**（1.14），实际叠加视角色/遮挡会低于该值，R13 需再做逐层实测。
5. **地平线消除以"不改雾"为前提**：若未来调整雾参数，需要重新评估
   `GroundHorizonFade` 的渐变区间（13/22）。

---

## 6. 回滚

```bash
git revert --no-edit <本轮 commit>
git reset --hard 235bcc2     # 回到 r24
git reset --hard v12-baseline
```