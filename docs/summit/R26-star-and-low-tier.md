# R26 · 屏幕空间星芒 / 内部陀螺仪骨架 / 低档位降级与残留清理

> 四条追问的交付：①1 draw call 的四瓣衍射星芒；②内部三环陀螺仪骨架；
> ③QPS→视觉映射文档（`R11-crystal-mapping.md`）；④T1/T0 降级与顶部光柱残留清理。
> 附：**R25 删除证据更正**——R25 使用的 glob 未展开，实际仍有 4 处残留，本轮已清除。

---

## 1. 追问 1：屏幕空间星芒（替代旧 flare）

文件：`src/components/canvas/CrystalOptics.tsx`（`STAR_*` shader）。

| 项 | 实现 |
|---|---|
| draw call | **1 个**：单个 `planeGeometry` mesh |
| 形态 | 4 瓣衍射（水平/垂直两瓣主 + 对角副瓣系数 0），指数衰减 |
| 尺寸 | `STAR_SIZE = CORE_RADIUS × 2 × 1.6 = 1.28` 世界单位 = **晶核屏幕直径 × 1.6 上限** |
| 朝向 | billboard：每帧复制相机四元数（`star.quaternion.copy(state.camera.quaternion)`），零滞后 |
| 混合 | Additive、depthWrite=false、depthTest=false、renderOrder=4 |
| 亮度 | 随晶核脉冲：`uPulse = 0.72 + 0.28·max(0, sin(2.2t+π/3))` |
| 防整屏横竖条 | shader 内 `mask = 1 − smoothstep(0.42, 0.5, radius)` 硬裁切；星芒只存在于 1.28 世界单位的平面内，**物理上不可能贯穿屏幕** |
| GLSL 安全 | 只使用 `exp`/`smoothstep(0.42, 0.5, ·)`（edge0<edge1），无 `pow` 未保护、无整数幂 |

> 旧 flare（6.6 宽横条、plane 6.6×0.18）已在 R25 删除；本轮星芒是"留在晶核处"
> 的镜头语言，而不是横贯画面的光带。

---

## 2. 追问 2：内部陀螺仪骨架

| 项 | 实现 |
|---|---|
| 结构 | 3 个互相垂直的超细圆环：`torusGeometry(radius ∈ {0.82, 0.90, 0.98}, tube=0.0038, 6, 96)` |
| 材质 | `MeshBasicMaterial`，**普通混合**（非 Additive），opacity 0.32/0.26/0.20，depthWrite=false |
| 旋转 | useFrame：`rotation.x = t·(0.17+0.05i)+phase`、`rotation.z = t·(−0.13−0.04i)+phase`，相位互错 |
| 与外层线框相位 | 外层棱线 `rotation.y = t·0.09`（正向）、内层 `−t·0.12`；陀螺仪骨架使用 x/z 轴旋转 + 独立相位 → **三套相位完全错开** |
| 纵深 | 位于晶体半径 1.05 内部（0.82–0.98），与外层线框 1.42/1.54 形成前/中/后三层视差 |
| 加色预算 | 0（普通混合），不增加任何 Additive 亮度 |

---

## 3. 追问 3：QPS→视觉映射文档

已写入 **`docs/summit/R11-crystal-mapping.md`**，包含：
- 输入信号表（健康分 / QPS / 混沌 / 自愈）与频率；
- QPS → 呼吸 `uBreath`（≤6%）、流光速度 `uFlowSpeed=1+0.6n`、星云涡旋、星芒脉冲；
- 健康度/故障态 → 色温三档 + 恢复 1.2s 缓动；
- 低档位降级映射表；
- 答辩口述版"一图流"。

> 本轮为让映射与代码一致，**波形/速度确实由 QPS 驱动**：`uFlowSpeed` 是新加的
> uniform（此前流光速度是常量），星云旋转也乘了 `(1+0.5·qpsNorm)`。

---

## 4. 追问 4：T1/T0 降级与顶部光柱残留

| 降级项 | T2/T3 | T1/T0 |
|---|---|---|
| 内部星云 | 360 颗 | **120 颗**（`buildNebulaGeometry(isLowTier ? 120 : 360)`） |
| 噪声音频 | fbm3 三倍频 | **单倍频**（`#define KV_LOW_NOISE`，倍频 2/3 关闭） |
| 晶体主体 | T3 可 MeshPhysicalMaterial | **Fresnel 假折射 shader** |
| 顶部光柱 | 无 | **无**（R25 删除 godray/pillar/flare） |

**残留清理（重要更正）**：R25 的删除证据使用了未展开的 glob（`src/**/*.ts`），
实际残留 4 处：`GODRAY_CYAN`、`FLARE_WING_CRITICAL`、`pillarRef`、`pillarUniforms`
（其中后两者仍在 useFrame 内被写）。本轮已全部删除，并用**递归文件列表**
重新生成证据：`docs/summit/artifacts/r25-deleted-inventory.txt`，全部 0 处。

保留项说明：
- `BEAM_*` + `cylinderGeometry` 是**地面投射光束**（晶体 → 地面的能量脐带，
  位于晶体下方），不是"顶部光柱"，按语义保留；
- `WorkerRack3D` 的 `PILLAR_*` 是机架立柱几何，与 Master 光学无关。

---

## 5. 验收（真实输出）

| 项 | 结果 |
|---|---|
| `shot.mjs --scene crystal` | 4 FPS / 222.7ms / **412 draws / 202,678 tris**，console error=0 |
| `shot.mjs --scene overview` | 5 FPS / 214.8ms / 412 draws / 202,678 tris，console error=0 |
| `probe-blackout` | **GREEN**：黑屏 0 / 采样 48 / 错误 0 |
| `lint-glsl` | **HIGH 0**（INFO 10 既有提示） |
| `verify.mjs` | **33/33**（344 meshes / 24 InstancedMesh / 367 geometries；4 FPS / 254.4ms / 415 draws / 202,774 tris） |
| `tsc` / `next lint` | 0 / 干净 |

截图：`docs/summit/shots/r26-star/{crystal,overview}-1366x768.png`。

---

## 6. 未验证项与风险

1. **星芒"宽度 ≤ 晶核屏幕直径 1.6×"是几何上界**：世界尺寸 1.28 = 核直径 0.8×1.6，
   透视缩放对二者一致，因此屏幕比例恒成立；但极端广角/近裁剪下视觉观感需真机确认。
2. **低档位实际效果未单独截图**：本机被判定为 T0，降级路径（120 粒子/单倍频）
   已在代码中生效，但未与 T3 做同帧对照。
3. **内部陀螺仪骨架的纵深层次**属主观观感，未做量化（可对比 draw calls 与截图）。
4. **星芒在 HDR Bloom 下的亮度**：软渲染无 Bloom，真机上可能与 Bloom 叠加过曝，
   需在 R13 与曝光自适应一起校准。
5. **R25 的删除证据错误已更正**，但 R25 提交里的该错误本身保留在 git 历史中
   （本轮文档如实记录，未篡改历史）。

---

## 7. 回滚

```bash
git revert --no-edit <本轮 commit>
git reset --hard 310e474     # 回到 r25
git reset --hard v12-baseline
```