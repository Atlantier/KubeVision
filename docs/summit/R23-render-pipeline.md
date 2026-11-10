# R23 · 实时渲染管线（ToneMapping / Bloom / AA / DPR / 灯光 / 阴影 / 兜底拆分 / 雾 / 色板 / A-B 一致性）

> 本轮只改管线，不动几何与材质风格，不新增依赖与 3D 资产。
> 所有数值都有 A/B 量化依据；软件光栅化环境的 FPS 不作为真机性能证据。

---

## 0. 参数表（旧 → 新 → 理由）

| # | 项 | 旧 | 新 | 理由 |
|---|---|---|---|---|
| L1 | ToneMapping | 无（渲染器 ACES 隐式） | Composer 内 `<ToneMapping mode={NEUTRAL}/>`；`gl.toneMappingExposure=1.05` | ACES 压灰高饱和绿/琥珀/绯红；Neutral 保色相。`postprocessing@6.36.4` 已 grep 确认导出 `ToneMappingMode.NEUTRAL`（值 8），**未升级依赖** |
| L1 | 效果顺序 | Bloom → Vignette | Bloom → ToneMapping → AA → Vignette → Noise | Bloom 处理线性 HDR；AA 在 ToneMapping 后更贴近感知；Vignette/Noise 为屏幕空间收尾 |
| L2 | Bloom threshold | 0.62 | **0.78** | 引入 ToneMapping 后亮度分布变化，阈值抬高避免机柜顶盖泛白 |
| L2 | Bloom smoothing | 0.24 | **0.14** | 收窄阈值过渡，光晕更"点状" |
| L2 | Bloom intensity | 0.55 | **0.72** | 阈值抬高后补偿总能量 |
| L2 | Bloom radius | 0.56 | **0.62** | 光晕略放宽，保持电影感 |
| L2 | Bloom levels | 8（默认 mip 层） | **6** | 少两层 mip，省填充率；半径收紧后视觉等价 |
| L3 | Composer Vignette | offset 0.18 / darkness 0.35 | **0.22 / 0.28** | 与 CSS 暗角去重：后处理负责画面内收拢，CSS 负责接缝 |
| L3 | CSS 暗角 | `transparent 55% → rgba(2,6,23,0.65)` | **`transparent 62% → rgba(2,6,23,0.42)`** | 双重暗角叠加过重，减 alpha + 外推起点 |
| L4 | Canvas antialias | true | **false（Composer 路径）** | 离屏 RT 才是最终画面，canvas MSAA 无效且浪费带宽 |
| L4 | Composer MSAA | 0 | **T3=2 / T2=0 + FXAA / T1=0** | 禁止 8×（HDR 8× RT > 200MB） |
| L5 | DPR | `[1, 2]`，初值 2 | **`[0.85, min(devicePixelRatio,1.75)]`**，软渲染 1.0 | 上限一刀 1.75 减 23% 像素；下限 0.85 保可读性；R01 约束：挂载期常量、只降不升、路演冻结 |
| L6 | ambient | 0.42 | **0.18** | 压暗部基底，让方向光塑造体积 |
| L6 | hemisphere | 0.55 | **0.34** | 同上，减少通体均匀照明 |
| L6 | key light | 1.85 / `#f8fafc` | **2.30 / `#eaf4ff`** | 主光亮起后 key:fill ≈ 3.4:1 |
| L6 | rim light | 0.65 | **0.95** | 补背光轮廓，提高金属棱角辨识 |
| L6 | center point | 36 | **28** | 主光增强后中心点光降档避免过曝 |
| L7 | shadow mapSize | 1024 | **2048** | 主光增强后阴影更锐利，需要更高分辨率 |
| L7 | shadow 正交范围 | ±16 | **±13** | 收紧到场景实际包围盒，提升有效纹素密度 |
| L7 | shadow normalBias | 无 | **0.02** | 消除机柜大面积平面的阴影痤疮 |
| L7 | shadow bias | -0.0005 | -0.0005（保留） | 与 normalBias 配合 |
| L7 | ContactShadows | res 512 / blur 2.2 / opacity 0.5 | **768 / 1.6 / 0.55** | 贴合阴影更清晰、更实 |
| L8 | 兜底开关 | `heavyRenderEnabled` 单开关 | **`postEnabled` + `reflectorEnabled`** | 两条链路代价不同，允许"只关反射保留后处理"等精细降级 |
| L8 | 软渲染判定 | 仅 renderer 字符串 | **WebGL2 + `EXT_color_buffer_half_float` + 字符串** | 部分虚拟化环境伪装 renderer；HDR 后处理 RT 依赖 half-float |
| L8 | 软渲染策略 | 关后处理+反射 | 两者都关、**DPR=1.0、shadows='basic'、ContactShadows 关** | SwiftShader 下 HDR Bloom 会静默黑屏 |
| L9 | 自定义 shader 雾 | 无雾衰减 | **`1 - smoothstep(0.75*uFogFar, uFogFar, vFogDepth)`，uFogFar=64** | 发光面片在雾远端不衰减，与线性雾 (15,64) 不一致；edge0<edge1 满足 R01 |
| L10 | 3D 状态色 | `#10b981`/`#ff3b6b`/`#f59e0b` 手工提亮变体 | **`src/constants/palette.ts`**：emerald-400 `#34d399` / rose-500 `#f43f5e` / amber-400 `#fbbf24` / cyan-400 `#22d3ee` | 3D 与 UI 同一色相；HDR 增益由 emitterMultiplier 承担而非改色相 |
| L11 | 兜底路径色调 | ACES（默认） | **渲染器内置 `NeutralToneMapping` + exposure 1.05** | 与 Composer 路径色相/亮度对齐；实测差异极小，不需要额外单 pass |

**硬红线遵守**：雾参数 `(15,64)` 未改动；相机位/fov 未改动（`verify.mjs:638` 断言照旧通过）；`useFrame` 内未新增 `new THREE.*`（本轮只改颜色常量与 shader uniform）。

---

## 1. 关键实现位置

| 项 | 文件 |
|---|---|
| 能力探测 / DPR / 开关拆分 / 后处理链 | `src/components/canvas/ClusterCanvas.tsx` |
| 质量档位 T3/T2/T1（`?quality=high/balanced/low`） | 同文件 `RENDER_QUALITY_TIER` / `RENDER_TIER` |
| 渲染 A/B 调试句柄 | 同文件 `window.__KUBEVISION_RENDER__`（仅开发构建） |
| 色板单一事实源 | `src/constants/palette.ts` |
| 3D 状态色引用 | `PodInstancedMesh.tsx` / `WorkerRack3D.tsx` / `MasterNode3D.tsx` |
| 自定义 shader 雾衰减 | `GlowHalo3D.tsx` / `ErrorRippleRing.tsx` / `CyberMatrixRain3D.tsx` / `WorkerRack3D.tsx`（beam bloom） |

---

## 2. A/B 截图（三组场景）

由 R00 的 `scripts/shot.mjs` 在 1366×768 / SwiftShader 下确定性截取：

| 场景 | 文件 | glStats（软渲染，非真机帧率） |
|---|---|---|
| overview | `docs/summit/shots/r23-pipeline/overview-1366x768.png` | 5 FPS / 199.5ms / 398 draws / 188,576 tris |
| pod-closeup | `docs/summit/shots/r23-pipeline/pod-closeup-1366x768.png` | 6 FPS / 174.2ms / 143 draws / 130,856 tris |
| oom（故障态） | `docs/summit/shots/r23-pipeline/oom-1366x768.png` | 7 FPS / 150.4ms / 144 draws / 131,238 tris |

另有 L11 同帧 A/B：
- `overview-post.png`（Composer 路径）
- `overview-fallback.png`（兜底路径）
- `perf-hud.png`（Shift+P 性能 HUD）

---

## 3. L11 渲染路径一致性（量化）

同一会话原地切换 `postEnabled` 后解码截图统计（详见 `docs/render-ab.md`）：

| 指标 | Composer 路径 | 兜底路径 | 差异 |
|---|---|---|---|
| 平均亮度 | 0.0858 | 0.0857 | **ΔL = 0.1%** |
| 对比度（亮度标准差） | 0.1268 | 0.1262 | **Δ = 0.5%** |
| 平均色相 | -147.6° | -147.58° | **Δ = 0.02°** |

结论：兜底路径已使用渲染器内置 `NeutralToneMapping` + exposure 1.05，两条路径**色相偏移 ≈ 0°、亮度差 0.1%**，无需再加单 pass ToneMapping。
（Δ 很小的另一原因：Bloom 阈值已抬到 0.78，只有极少数高光参与泛光，符合"点状光晕"的设计目标。）

---

## 4. 性能数据

| 路径 | FPS（软渲染） | frameTime | Draw Calls | Triangles |
|---|---|---|---|---|
| Composer | 5 | 200.0 ms | 398 | 188,576 |
| 兜底 | 5 | 192.3 ms | 398 | — |
| Shift+P HUD | 4 | — | 1（采样瞬间） | — |

- 软渲染帧率**不能**代表真机 60FPS；draw calls 与 triangles 是可跨后端比较的指标；
- 398 draws 含阴影 pass 与后处理全屏 pass；对比 R16 的 403 draws 基本持平（本轮未新增几何）；
- `verify.mjs` 性能采集：4 FPS / 235.6ms / 401 draws / 188,672 tris（同一软渲染环境）。

---

## 5. 回归

| 项目 | 结果 |
|---|---|
| `tsc --noEmit` | 0 错误 |
| `next lint` | 干净 |
| `verify.mjs` | **33/33**（3D 场景 334 meshes / 24 InstancedMesh / 353 geometries；无 WebGL 错误） |
| `shot.mjs` 三场景 | 全部成功，console error = 0 |

---

## 6. 未验证项与风险

1. **真机 60FPS 未验证**：SwiftShader 环境无法代表真实 GPU；DPR 1.75 与 MSAA×2 的收益需在真机测。
2. **T2/T1 档位未运行时截屏**：默认 `?quality=high`（T3）；`?quality=balanced|low` 的 FXAA / 无 AA 路径只经 tsc/lint 验证。
3. **软渲染降级路径的可视验证**：本环境被判定为软渲染时理论应关闭后处理；但 A/B 脚本通过调试句柄切换，未在真实 SwiftShader 自动判定分支上截图（`detectRenderCapabilities` 判定为 software 时行为需另测）。
4. **L2 参数未做多点扫参**：0.78/0.14/0.72/0.62/6 是单次 A/B 校准值，未做阈值扫描曲线。
5. **色板统一只覆盖 4 类状态色**：其余装饰色（网格青、装甲灰等）仍散落各文件，按"只扩展不删除"原则未强迁。

---

## 7. 回滚

```bash
git revert --no-edit <本轮 commit>
git reset --hard d410a93     # 回到 r22
git reset --hard v12-baseline
```