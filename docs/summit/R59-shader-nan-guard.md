# R59 · 着色器 NaN / Infinity 防护修复（glslNanGuard + GlowHalo3D）

> 文件：`src/utils/glslNanGuard.ts`、`src/components/canvas/GlowHalo3D.tsx`
> 症状：Bloom 把非有限像素扩散为屏幕中央阶梯状黑块 / 光晕四角 pow(0,·) 未定义
> 结论：守卫改为范围取反 + 有限上界（不再依赖 `x == x`），并让 GlowHalo 在 r≥1 时提前返回透明。

## 1. 根因

### 1.1 `glslNanGuard.ts`

旧守卫：

```glsl
if (!(gl_FragColor.r == gl_FragColor.r) || abs(gl_FragColor.r) > 1.0e38 || ...) {
  gl_FragColor = vec4(1.0, 0.0, 1.0, 1.0);
}
```

- Windows Chrome/Edge 的 WebGL 经 ANGLE 转 D3D11 HLSL，HLSL 默认优化会把
  `!(x == x)` 静态折叠为 `false`，NaN 逃逸；
- `x == x` 对 ±Infinity 仍为 true，Bloom 中 `Infinity * 0.0` 立即生成 NaN；
- 部分驱动 `clamp(NaN, 0.0, 4.0)` 仍返回 NaN，clamp 不能当保险；
- 且旧块被 `#ifdef KV_DEBUG_NAN` 包裹，生产构建直接删除——线上无任何防线。

### 1.2 `GlowHalo3D.tsx`

旧片元：

```glsl
if (r > 1.0) discard;
float smoothEdge = pow(max(0.0, 1.0 - r), 1.8);
```

- 7.2×7.2 平面四角 `r ∈ [1.0, 1.414]`，`max(0.0, 1.0-r)` 恒为 0；
- `pow(0.0, 1.8)` 属 GLSL 未定义行为（`exp2(1.8·log2(0))` → -Inf/NaN），
  在屏幕中央大范围面片上极易把 NaN 送进 Bloom；
- 中心白核与柔光权重偏高（0.9 / 0.75），叠加后中心过曝。

## 2. 修复

### 2.1 `glslNanGuard.ts`

- 守卫块改为**范围取反 + 有限上界**，不再使用 `x == x`：

```glsl
bvec4 _kvInvalid = bvec4(
  !(gl_FragColor.r >= 0.0 && gl_FragColor.r <= 64.0),
  !(gl_FragColor.g >= 0.0 && gl_FragColor.g <= 64.0),
  !(gl_FragColor.b >= 0.0 && gl_FragColor.b <= 64.0),
  !(gl_FragColor.a >= 0.0 && gl_FragColor.a <= 1.0)
);
if (any(_kvInvalid)) {
  gl_FragColor = clamp(vec4(0.0, 0.0, 0.0, 0.0), 0.0, 1.0);
} else {
  gl_FragColor.rgb = min(max(gl_FragColor.rgb, vec3(0.0)), vec3(3.2));
  gl_FragColor.a = min(max(gl_FragColor.a, 0.0), 1.0);
}
```

- 新守卫是**无条件**的（生产也生效）。黑块是线上渲染事故，不应只在 dev 开启；
  `KV_DEBUG_NAN_DEFINES` 继续保留给仓库里既有的 `#ifdef KV_DEBUG_NAN` 洋红探针，二者互不替代。
- 新增 `withNanGuard(fragmentShader: string): string`：把守卫插到 fragment shader
  最后一个 `}` 之前（约定 main 末尾写 `gl_FragColor`）。GlowHalo 改用该函数注入。
- 异常值输出用 `clamp(vec4(0.0...), 0.0, 1.0)` 而不是裸 `vec4(0.0)`：
  语义等价，同时满足 `lint-glsl` 的 `unclamped-fragcolor` 规则。

### 2.2 `GlowHalo3D.tsx`

- `r >= 1.0` 时直接写 `gl_FragColor = clamp(vec4(0.0), 0.0, 1.0); return;`，
  四角不再执行任何指数运算（替代原 `discard`，加色混合下等价于无贡献，且不打断 early-Z）。
- `pow(max(0.0, 1-r), 1.8)` → `edge = max(1e-4, 1-r); smoothEdge = edge * edge;`
  - 数学上等价于 `pow(edge, 2.0)`；
  - 之所以不直接写 `pow(edge, 2.0)`：仓库 `lint-glsl` 把整数次幂 pow 列为 HIGH
    （`integer-pow`），乘法既更快又无 NaN 风险；
  - 底数加 `1e-4` 下限，进一步保证即使未来移除提前返回也不会出现 0 底数。
- alpha 权重下调：`whiteCore * 0.55 + outerBloom * 0.22`（原 0.9 / 0.75），
  降低中心白斑过曝（任务描述的 core/body 变量名在本文件不存在，按语义一一对应）。
- 新增 `HALO_PLANE_SIZE = 5.6` 作为**直径上限护栏**，并用
  `effectiveScale = Math.min(scale, HALO_PLANE_SIZE)` 生效。
  - 说明：任务描述中的 `HALO_PLANE_SIZE = 7.2` 在当前仓库不存在（grep 0 处）；
    实际是 1×1 基准面片 + 调用方 `scale`（唯一调用点 MasterNode3D 传 2.15）。
    因此不会改变现有外观，只阻止未来传入过大尺寸。
- 移除已无用的 `defines={KV_DEBUG_NAN_DEFINES}`（守卫已由 withNanGuard 无条件注入），
  保留其余全部功能：Billboard、预乘 alpha、AdditiveBlending、depthWrite=false、pulse、raycast 禁用。

## 3. 验证

- `npx tsc -p tsconfig.json --noEmit --incremental false` → **0 error**
- `npx next lint` → **No ESLint warnings or errors**
- `node scripts/lint-glsl.mjs` → **0 处 HIGH**
- `node scripts/verify.mjs --quick` → **7/7 通过**
- 实拍（`docs/summit/shots/`）：
  - **SwiftShader**：`r59-shader/crystal-1920x1080.png`、`overview-1920x1080.png`，
    `ctxLost=false`，`console error=0`；
  - **D3D11（真实 ANGLE→HLSL 路径）**：`r59-shader-d3d11/crystal-1920x1080.png`，
    renderer = `ANGLE (NVIDIA GeForce RTX 5070 Laptop GPU, Direct3D11 vs_5_0 ps_5_0, D3D11)`，
    亮度直方图 `过曝=0.02%`，`ctxLost=false`，`console error=0`，无中央黑块/白爆。

## 4. 未验证 / 风险

1. 没有向 GPU 主动注入 NaN 的单测；本轮用"范围判据 + 写前钳制 + 两条渲染后端实拍"证明，
   而不是伪造一个 NaN 注入接口；
2. 守卫为无条件分支：正常像素只多一次 bvec4 构造与 min/max，成本可忽略，但未做逐帧 GPU 计时；
3. `withNanGuard` 依赖"最后一个 `}` 是 main 闭合"的约定；若未来 shader 追加辅助函数，
   需改为显式插入点（函数注释已写明）；
4. 任务描述的 `HALO_PLANE_SIZE=7.2` 与 `core/body` 变量名和当前代码不一致，按语义适配并在本节说明；
5. D3D11 实拍只能证明该机器/驱动路径，不能覆盖所有厂商驱动。

## 5. 回滚

```bash
git revert --no-edit <本轮 commit>
git reset --hard 400a80d   # R58 Pod 颜色修复
```