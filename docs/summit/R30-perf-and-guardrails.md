# R30 · 真机性能标定（受限）/ 开场定帧 / 亮度直方图守门

> 三条追问：①T3–T0 质量矩阵；②开场 5s 视频素材；③亮度直方图回归门槛。
> **诚实前提**：本沙箱没有独显/集显，Edge 只能 SwiftShader 软件光栅化，且没有 ffmpeg 编码器。
> 因此 ① 只能给出软渲染占位矩阵 + 可在真机复跑的脚本；② 用三帧定帧替代视频。

---

## 1. 追问 1：质量矩阵（软件占位，真机需复跑）

脚本：`scripts/quality-matrix.mjs`（依次 `?quality=off|low|balanced|high` 加载同场景，
记录 fps/frameTime/draw calls/triangles/显存估算/后处理开关，输出 `docs/quality-matrix.md`）。

| 档位 | fps（软渲染） | frameTime | draw calls | triangles | 显存估算 | 后处理 |
|---|---|---|---|---|---|---|
| T3 `?quality=high` | 4.6 | 286.3 ms | 420 | 205,932 | ≈3.8 MB | off* |
| T2 `?quality=balanced` | 4.4 | 248.1 ms | 420 | 205,932 | ≈3.8 MB | off* |
| T1 `?quality=low` | 3.8 | 261.4 ms | 420 | 205,932 | ≈3.8 MB | off* |
| T0 `?quality=off` | 5.2 | 200.1 ms | 420 | 205,932 | ≈3.8 MB | off |

\* **关键限制**：R23 的软件渲染兜底契约（`envCaps.software`）会在软渲染下强制关闭
Composer 后处理链——因此四档在本环境都显示 `post=off`，**T3/T2/T1 的 Bloom/DoF/阴影/反射
差异无法在本沙箱测量**。档位到渲染开关的映射已在本轮接线（见 `ClusterCanvas` 的
`qualityPost/qualityReflector/qualitySoftShadows/qualityBloomLevels/qualityBloomIntensity`），
真机复跑后矩阵才有标定意义：

```bash
# 真机（独显 / 集显各跑一遍）
node scripts/quality-matrix.mjs
```

**降档定位顺序（真机独显不足 60FPS 时）**：先降反射 → 再降阴影 → 再降 Bloom
（levels 6→5→4、intensity .72→.66→.60），仍不足才继续降粒子密度；**禁止缩小场景**。
映射依据：反射 = 整场景再渲染一遍，阴影 = 2048 PCFSoft 贴图，Bloom = 多级降采样。

显存估算口径：场景几何 attribute byteLength + 程序化纹理近似（`width×height×4`），
不是驱动真实占用，仅用于档位间相对比较。

---

## 2. 追问 2：开场素材（定帧替代 5s 视频）

脚本：`scripts/opening-frames.mjs`；输出：

- `docs/summit/shots/r30-opening/opening-0.15s.png`（开场起点，uBoot≈0.1、相机在 [10.6,17.2,26.5] 附近）
- `opening-1.5s.png`（uBoot 中段 + 运镜中段）
- `opening-3.0s.png`（完全落位 OVERVIEW）

**未能产出 5s 视频**：沙箱无 ffmpeg / 无编码器。真机可用同一脚本抓帧序列后合成
（例如 `ffmpeg -framerate 10 -i opening-%d.png ...`）。

与基线第 1 帧对比：`docs/summit/shots/v12-baseline/overview-1920x1080.png`（R00 基线）
→ 当前构图（R29 起 `OVERVIEW_LOOK_AT=[0,1.20,0]`）前排机架底边完整入画、晶核约 44% 高度；
本轮 `r30-opening` 三帧为同一机位的不同时间点，可与基线定帧并排查看。

---

## 3. 追问 3：亮度直方图守门

`scripts/shot.mjs` 新增：

- 自写 PNG 解码（`node:zlib` inflate + filter 反解，零新增依赖）；
- 亮度 `L = 0.2126R + 0.7152G + 0.0722B`（Rec.709），16 bin 直方图 + 均值；
- **过曝门槛：L > 250 的像素占比 > 3% 时 `console.warn` 告警，并以 exit code 2 结束**
  （回归门槛，不静默通过）；
- 直方图与过曝比例写入 `meta.json` 的 `luminance` 字段，并打印 16 字符条形图。

本轮 overview 实测：

```
亮度直方图: [##+... .        ] 均值=22.5 过曝=0.06%
```

→ 0.06% ≪ 3%，**通过**（暗场参考图风格下低过曝是预期）。

---

## 4. 验收（真实输出）

```
shot.mjs --scene overview : 5 FPS / 215.2ms / 420 draws / 205,932 tris
                            亮度直方图 均值 22.5 / 过曝 0.06%  console error=0
quality-matrix            : T3 4.6FPS / T2 4.4 / T1 3.8 / T0 5.2（软渲染占位）
opening-frames            : 三帧 0.15s / 1.5s / 3.0s 已产出
probe-blackout            : GREEN（黑屏 0 / 采样 46 / 错误 0）
lint-glsl                 : HIGH 命中 0 · INFO 11
verify.mjs                : 33/33（4 FPS / 262.9ms / 423 draws；相机聚焦联动通过）
tsc 0 · next lint 干净
```

---

## 5. 未验证项与风险

1. **真机独显/集显标定未完成**：本环境无 GPU，矩阵为软渲染占位；60FPS 决策必须在真机复跑。
2. **T3/T2/T1 的档位差异在本环境不可见**：软件兜底强制关闭 Composer，四档均 post=off。
3. **5s 视频未产出**：无编码器，仅有 3 帧定帧；真机需补录。
4. **显存估算是近似值**：几何 buffer + 纹理尺寸，不含驱动开销/RT。
5. **Shift+P 三档按钮仍未实现**：本轮只完成 URL 档位接线与治理器，按钮属 R31 补强。

---

## 6. 回滚

```bash
git revert --no-edit <本轮 commit>
git reset --hard e7ae459     # 回到 r29
git reset --hard v12-baseline
```