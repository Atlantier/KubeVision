# GL 稳定性规范 · 未定义行为速查表

> **适用对象**：后续所有新增/修改的自定义 shader（`ShaderMaterial` 与
> `onBeforeCompile` 两条路径）。**R11、R12 必须遵守本表。**
>
> **为什么要有这张表**：这些写法在多数输入下画面"看起来正常"，只在特定
> 角度/特定帧产生一个 NaN 像素；而 NaN 一旦进入 bloom 的多级 mip 链，
> 会被扩散成整块黑或整块白，且**不同 GPU 行为不同**（软渲染可能吞掉，
> 独显可能整屏爆掉）。等到现场才发现，代价极高。
>
> **强制执行**：`pnpm lint:glsl` 已接入 `scripts/verify.mjs` 的静态阶段，
> 任何 HIGH 命中都会让验收失败。豁免必须在行尾写明理由
> （`// glsl-lint-allow: <理由>`），不允许无理由跳过。

---

## 1. 速查表

| # | 危险写法 | 为什么未定义 | 正确写法 | lint 规则 |
|---|---|---|---|---|
| 1 | `smoothstep(a, b, x)` 且 `a > b` | GLSL 规范：`edge0 >= edge1` 时结果 undefined | `1.0 - smoothstep(b, a, x)` | `inverted-smoothstep` |
| 2 | `smoothstep(uA, uB, x)` 两个边界都来自 uniform | 运行时可能 `uA == uB` → 退化 | `smoothstep(min(uA, uB - 1e-4), max(uB, uA + 1e-4), x)` | `dynamic-smoothstep`（INFO） |
| 3 | `pow(x, y)` 且 `x` 可能为负 | GLSL：`pow` 在 `x < 0` 时 undefined | `pow(max(x, 1e-4), y)` | `unguarded-pow` |
| 4 | `pow(x, 2.0)` / `pow(x, 3.0)` | 整数次幂用超越函数，且有 #3 的风险 | `x*x` / `x*x*x` | `integer-pow` |
| 5 | `atan(y, x)` 未判零 | `atan(0.0, 0.0)` undefined | `(abs(x)+abs(y) > 1e-4) ? atan(y,x) : 0.0` | `unguarded-atan` |
| 6 | `a / b` 且 `b` 可能为 0 | IEEE-754 得到 Inf，随后参与混合即变 NaN | `a / max(b, 1e-4)` | 人工 |
| 7 | `sqrt(x)` / `inversesqrt(x)` 且 `x` 可能 ≤ 0 | `x < 0` 时 NaN | `sqrt(max(x, 0.0))` / `inversesqrt(max(x, 1e-8))` | 人工 |
| 8 | `log(x)` 且 `x` 可能 ≤ 0 | 同 #7 | `log(max(x, 1e-4))` | 人工 |
| 9 | `normalize(v)` 且 `v` 可能为零向量 | 零长度除法 → NaN | `v * inversesqrt(max(dot(v,v), 1e-8))` | 人工 |
| 10 | `gl_FragColor` 未 clamp | HDR 可超出 fp16 范围 → Inf → bloom 污染整帧 | `vec4(clamp(rgb, 0.0, 8.0), clamp(a, 0.0, 1.0))` | `unclamped-fragcolor` |
| 11 | 片元里对 `varying` 做除法/归一化而不保护 | 插值结果可能恰好为零向量 | 同 #6 #9 | 人工 |
| 12 | `fract()` 后直接用做除数 | `fract` ∈ [0,1)，**可以是 0** | `max(fract(x), 1e-4)` | 人工 |
| 13 | 在 `useFrame` 内 `new THREE.*` | GC 抖动导致掉帧（非 NaN，但属稳定性红线） | 模块级或 `useMemo` 预分配 | 人工 |
| 14 | `#version 300 es` 才有的内建（`isnan`/`isinf`/`textureLod`…）用于 ES 1.00 材质 | 编译失败 → 整个材质变黑，比 NaN 更糟 | 用 `v != v` 判 NaN、`abs(v) > 1e38` 判 Inf | 人工 |

---

## 2. 本轮（r04）实际修复的真实缺陷

以下不是理论风险，是**确实会产生 NaN 的写法**：

| 文件 | 行 | 原写法 | 问题 | 新写法 |
|---|---|---|---|---|
| `MasterNode3D.tsx` | 790 | `pow(centered.y, 2.0)` | `centered.y` 在光晕轴线两侧符号相反，负底数 → NaN | `centered.y * centered.y` |
| `WorkerRack3D.tsx` | 520 | `pow((r - 0.34) / 0.075, 2.0)` | 同上，环内外符号相反 | 拆 `ringAd` 后 `ringAd * ringAd` |
| `ClusterTopologyFloor3D.tsx` | 238 | `atan(p.y, p.x)` | 圆心像素 `p == (0,0)` | `abs(x)+abs(y) > 1e-4 ? … : 0.0` |
| `ClusterTopologyFloor3D.tsx` | 923 | `atan(position.z, position.x)` | 同上 | 同上保护 |
| `MasterNode3D.tsx` | 774 | `pow(coreRadius / coreSigma, 2.0)` | `coreSigma` 为 uniform，可为 0 | `max(coreSigma, 1e-4)` + 乘法 |
| `ClusterTopologyFloor3D.tsx` | 283 | `/(uOuter - uInner)` | 两 uniform 可能相等 | `/max(uOuter - uInner, 1e-4)` |

另有 4 处倒置 `smoothstep`（`edge0 > edge1`）与 13 处未 clamp 的片元输出。

---

## 3. 两条调试手段

### 3.1 洋红探针（定位是哪一段 GLSL 出问题）

开发构建下 `KV_DEBUG_NAN` 自动开启（见 `src/utils/glslNanGuard.ts`），
每个 `ShaderMaterial` 的片元输出在写出后会做一次 NaN/Inf 检查，
异常像素直接变洋红 `vec4(1,0,1,1)`。

- 看到洋红 → 该像素的 GLSL 输出了 NaN/Inf，按 #1~#12 逐项排查；
- 生产构建下 `KV_DEBUG_NAN_DEFINES` 为空对象，整段被预处理器剔除，**零成本**。

**已知未覆盖**：`onBeforeCompile` 路径（`PodInstancedMesh`）走 three 原生
PBR 输出通道（`outputColor` / `gl_FragColor` 由 three 决定），本轮未注入洋红探针。
如需覆盖，应在 `injectCrystalShader` 的替换串尾部追加同类守卫，
并使用 three 注入的 `#include <output_fragment>` 之后的位置。

### 3.2 黑屏探针（确认整帧是否失效）

```bash
pnpm probe:blackout --action demo --duration 45 --repeat 3
```

16×16 采样点亮度轮询，连续 3 次低于 2/255 判定黑屏。
**注意采样周期实际约 2~3.5 秒**，短于约 3 秒的瞬时黑屏会漏采，
所以"0/N"是**下界**而非保证。详见 `docs/summit/blackout-baseline.md`。

---

## 4. 新增 shader 的评审清单（R11 / R12 逐项打勾）

- [ ] 所有 `smoothstep` 满足 `edge0 < edge1`（字面量与 uniform 都检查）
- [ ] 所有 `pow` 首参已 `max(…, 1e-4)` 包裹，或为严格非负量
- [ ] 整数字面量次幂已改为乘法
- [ ] 所有双参 `atan` 有零向量保护
- [ ] 所有除数（含 uniform 差值、`fract` 结果）有 `max(…, 1e-4)`
- [ ] `sqrt` / `log` 入参已夹取下界
- [ ] `normalize` 的入参保证非零长度，或改用 `inversesqrt(max(dot,1e-8))`
- [ ] `gl_FragColor` 经 `clamp(rgb, 0.0, 8.0)` / `clamp(a, 0.0, 1.0)`
- [ ] `pnpm lint:glsl` 退出码 0
- [ ] 开发构建截图无反直觉洋红像素
- [ ] 若为 `InstancedMesh`：基础色 `#ffffff`、`toneMapped={false}`、
      改矩阵/颜色后 `instanceMatrix.needsUpdate = true` 且
      `instanceColor` 非空时同步置位
- [ ] 若用 drei `<Html>`：`zIndexRange={[10, 0]}` + `pointer-events-none`

---

## 5. 与真实 GPU 的差异（必须知道）

| 环境 | 表现 |
|---|---|
| SwiftShader（CI / 无头） | 对 NaN 较宽容，常常"吞掉"不显示，因此**软渲染下看不出问题** |
| 真实独显（D3D11 / Metal / Vulkan） | NaN 更易被后处理放大成整块黑/白，且不同驱动行为不一致 |

结论：**软渲染全绿 ≠ 真机没问题**。这也是为什么必须靠静态规则 + 洋红探针
两道防线，而不能只依赖截图回归。
