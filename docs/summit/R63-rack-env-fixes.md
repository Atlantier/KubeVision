# R63 · HDR 环境反射过曝与机架铭牌 Tailwind 类名修复

> 文件：`src/components/canvas/ProceduralPbrEnvironment.tsx`、`src/components/canvas/WorkerRack3D.tsx`
> 症状：金属机架/立柱在环境灯带下发白；3D 铭牌丢失内边距与毛玻璃，亮背景下文字难读。

## 1. ProceduralPbrEnvironment

### 1.1 灯带 HDR 强度

`createStripLightMaterial` 原为近白 `#dff6ff × 3.2`，8 根灯带烘焙进 PMREM 后
让所有采样该环境贴图的金属表面泛白。现改为：

```ts
const STRIP_LIGHT_COLOR = '#94a3b8';        // 深空冷青灰
const color = new THREE.Color(STRIP_LIGHT_COLOR);
color.multiplyScalar(1.35);                  // 原 3.2
```

### 1.2 装甲边缘 Fresnel

`enhanceArmorMaterial` 的注入片元：

```glsl
totalEmissiveRadiance += vec3(0.45, 0.78, 0.96) * kvFres * 0.09;
```

（原 `vec3(0.85, 0.92, 1.0) * kvFres * 0.25`，叠加环境贴图后偏亮。）

## 2. WorkerRack3D

### 2.1 PBR 环境反射强度

| 常量/材质 | 原值 | 新值 |
|---|---|---|
| `TI_ENV_INTENSITY` | 2.2 | **1.05** |
| `CHAMFER_ENV_INTENSITY` | 3.0（仓库实际值） | **1.45** |
| `RIVET_ENV_INTENSITY` | 1.8（仓库实际值） | **1.25** |
| 内框/层板（`INNER_FRAME_ENV_INTENSITY`） | 无命名常量（原用 TI 2.2） | **0.85** |
| 光学导轨（`OPTIC_RAIL_ENV_INTENSITY`） | 3.2 | **1.35** |

> 说明：当前仓库没有名为 `innerFrameMaterial` / `opticRailMaterial` 的独立材质对象，
> 对应结构是内联 JSX。本轮新增语义化常量，把 0.85 应用到 4 层内部隔板材质，
> 把 1.35 应用到 3 处光学导轨材质（竖直 1 + 水平 2），没有虚构不存在的变量名。

### 2.2 铭牌类名

原：

```tsx
className="relative px-2.5 py-1.5-[8px]"
```

`py-1.5-[8px]` 不是合法 Tailwind 类名，导致纵向内边距与毛玻璃都失效。现改为：

```tsx
className="relative rounded-[2px] bg-slate-950/80 px-2.5 py-1.5 backdrop-blur-[8px]"
```

铭牌现在有深空毛玻璃衬底、2px 圆角与正常纵向内边距，近景/远景文字均可读。

## 3. 验证（真实执行）

- `npx tsc -p tsconfig.json --noEmit --incremental false` → **0 error**
- `npx next lint` → **No ESLint warnings or errors**
- `node scripts/lint-glsl.mjs` → **0 处 HIGH**
- `node scripts/verify.mjs --quick` → **7/7 通过**
- 实拍：
  - SwiftShader overview：均值 **20.0**，过曝 **0.04%**，`ctxLost=false`、`error=0`；
  - SwiftShader pod-closeup：均值 **47.3**，过曝 **0.21%**（近景高光仍存在但不再是整片惨白），
    铭牌深色毛玻璃底清晰可读；
  - D3D11 真实 ANGLE→HLSL overview：`ANGLE (NVIDIA GeForce RTX 5070 Laptop GPU, Direct3D11 vs_5_0 ps_5_0, D3D11)`，
    均值 **26.0**，过曝 **0.02%**，`ctxLost=false`、`error=0`。
- 证据目录：`docs/summit/shots/r63-rack/`、`docs/summit/shots/r63-rack-d3d11/`。

## 4. 未验证 / 风险

1. 当前仓库没有 `innerFrameMaterial` / `opticRailMaterial` 命名材质，已按实际内联结构用语义化常量落地；
   若未来重构成独立材质对象，应把常量绑定到对象上而不是继续散落。
2. `scene.environmentIntensity` 仍为 0.78，本轮只下调灯带烘焙强度与材质 envMapIntensity；
   若某些机位仍偏亮，可继续降低该全局值或灯带 1.35。
3. pod-closeup 近景仍有 0.21% 过曝像素（高光边缘），属于金属反射的正常局部高光，
   未做到 0；如需进一步压低，可再降倒角 1.45。
4. D3D11 仅覆盖本机 NVIDIA 驱动；未做低端集显实拍。

## 5. 回滚

```bash
git revert --no-edit <本轮 commit>
git reset --hard f87cc20   # R62 曝光/地面修复
```