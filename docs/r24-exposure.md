# 曝光自适应与渲染路径 HUD（R24 证据）

> 由 `node scripts/r24-evidence.mjs` 自动生成于 2026-11-10T10:01:50.553Z。

## Q1 曝光自适应

- 稳态：tier=T0，exposure=1.18，亮度估计=0
- 注入 OOM 混沌后（120ms 采样 × 40）：
  - 曝光区间：1.1321 ~ 1.18（要求 [1.00, 1.18]）
  - 稳态 → 故障态：1.18 → 1.1321
  - 相邻采样最大步长：0.0061（阻尼插值，要求 ≤ 0.02）
  - 亮度估计：0 → 0.2683

## Q3 渲染路径 HUD

```
渲染路径 瞬态轨 · 零重渲染 当前档位 T0 T3/T2/T1/T0 曝光 1.132 [1.00, 1.18] 亮度估计 0.27 0~1 软件光栅化（WebGL2 + half-float + renderer 探测命中）：后处理与反射均关闭
```

- 档位：T0
- 截图：docs/summit/shots/r24-exposure/hud.png

## 截图

- ![稳态](shots/r24-exposure/overview.png)
- ![故障态](shots/r24-exposure/oom.png)
- ![性能 HUD](shots/r24-exposure/hud.png)
