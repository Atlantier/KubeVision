# 质量矩阵标定（T3 / T2 / T1 / T0）

> 由 `node scripts/quality-matrix.mjs` 自动生成于 2026-11-10T10:58:12.949Z。
> 渲染器：`ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)`

## ⚠️ 重要：本结果来自软件光栅化（SwiftShader）

本沙箱没有可用独显/集显，Edge 只能软渲染。**这些 fps 数字不能作为 60FPS 决策依据**，只用于记录档位切换对 draw calls / 显存估算的影响。真机复跑命令：`node scripts/quality-matrix.mjs`（renderer 会显示真实 GPU 名称）。

## 矩阵

| 档位 | 说明 | fps（均值） | frameTime（均值） | draw calls | triangles | 显存估算 | 后处理 |
|---|---|---|---|---|---|---|---|
| T3 (`?quality=high`) | 全特效 | 4.6 | 286.3 ms | 420 | 205932 | ≈3.8 MB | off |
| T2 (`?quality=balanced`) | 关 DoF / 中等 Bloom | 4.4 | 248.1 ms | 420 | 205932 | ≈3.8 MB | off |
| T1 (`?quality=low`) | 关阴影/反射 + Bloom 降级 | 3.8 | 261.4 ms | 420 | 205932 | ≈3.8 MB | off |
| T0 (`?quality=off`) | 后处理全关 | 5.2 | 200.1 ms | 420 | 205932 | ≈3.8 MB | off |

## 降档定位顺序（若真机独显不到 60FPS）

按需求契约，定位顺序固定为 **先降反射 → 再降阴影 → 再降 Bloom**，禁止缩小场景：

1. 反射：`MeshReflectorMaterial` 会整场景再渲染一遍，是本项目最贵的单项；T1 起关闭。
2. 阴影：PCFSoft 2048 阴影贴图；T1 起关闭。
3. Bloom：levels 6→5→4、intensity 0.72→0.66→0.60；T0 随整条后处理链关闭。
4. 以上仍不足时，才由治理器继续降粒子密度（不是删场景物体）。

## 未验证项

- 本沙箱无真机 GPU，独显/集显两轮标定**未完成**；须在真实硬件上复跑本脚本。
- 显存估算为"几何 buffer + 程序化纹理近似"，不是驱动真实占用；仅用于档位间相对比较。
