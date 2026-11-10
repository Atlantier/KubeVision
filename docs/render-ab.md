# 渲染管线 A/B 对比（L11 证据）

> 由 `node scripts/r23-pipeline-evidence.mjs` 自动生成于 2026-11-10T09:39:37.843Z。
> 同一会话、同一帧缓冲原地切换两条路径；分辨率 1366×768（SwiftShader 软件光栅化）。

## 量化结果

| 指标 | Composer 路径 | 兜底路径 | 差异 |
|---|---|---|---|
| 平均亮度（0–1） | 0.0858 | 0.0857 | ΔL = 0.1% |
| 对比度（亮度标准差） | 0.1268 | 0.1262 | Δ = 0.5% |
| 平均色相 | -147.6° | -147.58° | Δ = -0.0° |

## 性能数据

| 路径 | FPS | frameTime | Draw Calls | Triangles |
|---|---|---|---|---|
| Composer | 5 | 200 ms | 398 | 188576 |
| 兜底 | 5 | 192.3 ms | 398 | 188576 |

> Shift+P 性能 HUD 实测：4 FPS / 1 draw calls / tier=T3。
> 注：SwiftShader 为软件光栅化，FPS 数值不代表真机性能，仅用于两条路径的相对对照。

## 截图

- ![Composer](shots/r23-pipeline/overview-post.png)
- ![兜底](shots/r23-pipeline/overview-fallback.png)
- ![性能 HUD](shots/r23-pipeline/perf-hud.png)

## 结论

两条路径的色相偏移 -0.0°（< 3° 视为可接受），亮度差异 0.1%。

兜底路径已使用 **渲染器内置 NeutralToneMapping**（`gl.toneMapping = NeutralToneMapping; exposure = 1.05`），
因此不需要再加一条单 pass ToneMapping；若未来色相偏移超过 3°，再引入后处理单 pass 方案。

## 边界

- 像素统计包含 UI 浮层？不包含：readPixels 只读 WebGL 绘制缓冲，DOM 浮层不在其中；
- 摆幅差异来自 Bloom/Vignette 的屏幕空间处理，属预期；判定标准是**色相偏移**而非亮度绝对相等。
