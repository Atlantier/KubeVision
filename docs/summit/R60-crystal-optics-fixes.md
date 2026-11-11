# R60 · CrystalOptics 着色器/材质 6 项缺陷修复

> 文件：`src/components/canvas/CrystalOptics.tsx`
> 症状：Bloom Mipmap 把非有限像素扩散成屏幕中央黑块；晶核/内层过曝
> 结论：统一安全归一化、补 pow 下界、修 BackSide 点积符号、粒子除零、移除 transmission、压低过曝权重。

## 1. 逐项修复

### 1.1 CRYSTAL_FRAGMENT 的零向量归一化

- **现状核对**：任务描述的 `normalize(cross(dFdx(vLocalPos), dFdy(vLocalPos)))` 在当前仓库
  **不存在**（全仓库 `dFdx/dFdy/cross(` grep 为 0）；当前实现对 `vNormalView`/`vViewDir`
  直接 `normalize`，同样存在零向量 → NaN 风险，但来源是法线/视线而非叉乘。
- **修复**：新增共享 `safeNormalize(vec3 v, vec3 fallback)`（`lenSq > 1e-8` 才归一化），
  CORE / FOG / CRYSTAL / ATMOSPHERE 四处全部改用：
  ```glsl
  vec3 N = safeNormalize(vNormalView, vec3(0.0, 0.0, 1.0));
  vec3 V = safeNormalize(vViewDir, vec3(0.0, 0.0, 1.0));
  ```
- **未添加** `dFdx/dFdy` 面法线：当前着色器没有该路径，且 WebGL1 需要
  `extensions.derivatives` 才能用导数；为避免引入未验证的编译分支，本轮只做安全归一化。
  若后续确需逐面法线，应在 `shaderMaterial` 上显式开 `extensions={{ derivatives: true }}` 并保留 fallback。

### 1.2 CORE_FRAGMENT 的 pow(0, 1.6)

- `pow(clamp(dot(normalize(...), normalize(...)), 0.0, 1.0), 1.6)` → 安全归一化 + 下界：
  ```glsl
  float fresnel = pow(clamp(dot(N, V), 1.0e-4, 1.0), 1.6);
  ```
- 当前版本没有任务描述的 `(1.3 + pulse * 0.7)` 白炽系数（pulse 已合并到 `uBreath`），
  因此把亮度按 **0.85** 下调：`color *= 0.85 * uBreath;`。

### 1.3 FOG / ATMOSPHERE 的 BackSide 点积反转

- 两个球体均 `side={THREE.BackSide}`，顶点法线背向相机，原 `max(dot(N,V), 1e-4)` 永远卡在下界。
- 改为：
  ```glsl
  float facing = clamp(abs(dot(N, V)), 1.0e-4, 1.0);
  ```
  轮廓泛光恢复真实衰减；后续 pow 保留（底数已有 1e-4 下界）。

### 1.4 NEBULA 顶点除零 / 片元 pow(0,1.6)

- 顶点：`2.2 / -mvPosition.z` → `2.2 / max(0.25, -mvPosition.z)`，
  避免粒子贴近相机平面时除零/负点尺寸。
- 片元：改为归一化半径 `r = length(centered) * 2.0`；`r >= 1.0` 直接 `discard`；
  衰减改为 `pow(max(1.0e-4, 1.0 - r), 1.6)`。

### 1.5 移除 `<meshPhysicalMaterial transmission={0.35} />`

- `transmission > 0` 会强制额外一次全场景 `transmissionRenderTarget` 离屏渲染，
  与 `MeshReflectorMaterial`（onBeforeRender 改 renderTarget）和
  `EffectComposer`（HalfFloat + MSAA）嵌套时易 FBO 状态错乱、双倍开销。
- 已彻底删除 `meshPhysicalMaterial` 分支与 `usePhysicalCrystal` 判定；外层改为
  `CRYSTAL_FRAGMENT` ShaderMaterial（DoubleSide），并新增内层晶面：
  - `innerRefractionUniforms`：`uRefractionStrength=0.028`、`uAlphaBase=0.24`；
  - `side=THREE.FrontSide`、`depthWrite=false`、`toneMapped=false`；
  - 与外层同源的折射/色散 shader，不再触发 transmission FBO。

### 1.6 开场缩放与过曝权重

- **现状核对**：父组件 `MasterNode3D` 并未施加 `bootScale`（全仓库 grep 0），
  `CrystalOptics` 是唯一使用 `bootUniform` 的点。若直接删掉 boot 因子会丢失 R29 开场动画。
- **处理**：把 boot 与呼吸合并为**一次**赋值，绝不二次相乘：
  ```ts
  const bootFactor = 0.55 + 0.45 * boot;          // 下限 0.55，normalMatrix 不会下溢
  const breathScale = 1 + Math.sin(t * 2.1) * 0.015;
  root.scale.setScalar(bootFactor * breathScale);
  ```
- 外层 `uAlphaBase=0.22`、内层 `uAlphaBase=0.24`；`uEdgeBoost` 0.55→**0.32**；
  `uCaustic` 0.22→**0.12**；棱边/焦散用乘法代替整数次幂，避免 lint 的 `integer-pow`。

## 2. 验证

- `npx tsc -p tsconfig.json --noEmit --incremental false` → **0 error**
- `npx next lint` → **No ESLint warnings or errors**
- `node scripts/lint-glsl.mjs` → **0 处 HIGH**
- `node scripts/verify.mjs --quick` → **7/7 通过**
- 实拍：
  - D3D11（真实 ANGLE→HLSL）：`docs/summit/shots/r60-crystal-d3d11/crystal-1920x1080.png`，
    renderer = `ANGLE (NVIDIA GeForce RTX 5070 Laptop GPU, Direct3D11 vs_5_0 ps_5_0, D3D11)`，
    亮度直方图 **过曝=0.02%**，`ctxLost=false`，`console error=0`；
  - SwiftShader：`docs/summit/shots/r60-crystal/crystal-1920x1080.png`、`overview-1920x1080.png`，
    同样无中央黑块。

## 3. 未验证 / 风险

1. 未新增 `dFdx` 面法线路径（当前仓库不存在该代码），因此不宣称修复了一个不存在的叉乘归一化缺陷；
   只把现有法线/视线归一化全部替换为安全版本。
2. 内层晶面是新增的第二层 mesh（+1 draw call），视觉已在两种渲染后端验证，但没有做逐帧 GPU 计时。
3. `safeNormalize` 的 fallback 固定为 `(0,0,1)`；极端视角下会退化为常量法线，但不会产生 NaN。
4. D3D11 验证只覆盖本机 NVIDIA 驱动，不能覆盖所有厂商/驱动组合。
5. 呼吸缩放与 boot 合并为一次赋值是当前架构下的折中：若未来父组件真的接管 bootScale，
   必须删除这里 `bootFactor` 以免二次相乘（已在注释写明）。

## 4. 回滚

```bash
git revert --no-edit <本轮 commit>
git reset --hard 7326119   # R59 着色器守卫修复
```