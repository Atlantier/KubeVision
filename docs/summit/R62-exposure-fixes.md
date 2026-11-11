# R62 · ClusterCanvas 地面过曝 / 光照预算 / Bloom 与 ExposureDriver 双重曝光修复

> 文件：`src/components/canvas/ClusterCanvas.tsx`、`src/components/canvas/ExposureDriver.tsx`
> 症状：左侧 `worker-beta` 下方地面大面积惨白；稳态画面双重曝光（1.18×1.18）导致高光全白。

## 1. ClusterCanvas

### 1.1 镜面反射地面（过曝根因）

`MeshReflectorMaterial` 显式增加 `envMapIntensity={0}`，切断对
`scene.environment`（RoomEnvironment 亮白顶棚 + 8 根 3.2x HDR 灯带）的采样；
地面只保留真实 3D 倒影与 `#030712` 黑曜石底色。

参数按契约校准：

```tsx
<MeshReflectorMaterial
  blur={[360, 120]}
  resolution={512}
  mixBlur={0.9}
  mixStrength={0.42}
  roughness={0.72}
  depthScale={1.1}
  minDepthThreshold={0.4}
  maxDepthThreshold={1.4}
  color="#030712"
  metalness={0.45}
  mirror={0.28}
  envMapIntensity={0}
/>
```

> 说明：原实现用 `REFLECTOR_RESOLUTION[RENDER_QUALITY_TIER]` 自适应 512/256；
> 本轮为满足契约改为固定 512，低端设备不再自动降到 256（性能风险见 §4）。

### 1.2 光照强度

- `ambientLight` 0.18 → **0.28**
- `hemisphereLight` 0.34 → **0.45**
- 主 `directionalLight`：位置 `[14,24,14]` → **`[12,24,14]`**，intensity 2.3 → **1.10**
- 副 `directionalLight`：intensity 0.95 → **0.45**
- 中央 `pointLight`：intensity 28 → **6.5**，distance 28 → **22**，decay 2 不变

### 1.3 Bloom

两个 EffectComposer 分支统一为：

```tsx
<Bloom
  intensity={0.48}
  luminanceThreshold={0.92}
  luminanceSmoothing={0.28}
  mipmapBlur
  radius={0.45}
  levels={5}
/>
```

旧的 0.78 阈值 / 0.68 强度（以及按档位的 0.6~0.72）会把地面反射和浅色线一并纳入辉光；
新阈值只让真正高光溢出。

### 1.4 固定曝光

`TONEMAP_EXPOSURE` 1.05 → **1.0**，避免与 ExposureDriver 的乘性曝光叠加。

## 2. ExposureDriver

### 2.1 双重曝光根因

旧实现：

```ts
gl.toneMappingExposure = currentRef.current; // 1.18
effectRef.current.setExposure(currentRef.current); // 也是 1.18
```

稳态被乘 1.18 × 1.18 = 1.3924，高光必然发白。

### 2.2 修复

- `EXPOSURE_MIN = 0.85`、`EXPOSURE_MAX = 1.00`（稳态 1.0，故障期温和压暗 15%）。
- **useFrame 不再写 `gl.toneMappingExposure`**；新增挂载 `useEffect` 把它固定为 1.0：
  ```ts
  const gl = useThree((state): WebGLRenderer => state.gl);
  useEffect((): void => {
    gl.toneMappingExposure = 1.0;
  }, [gl]);
  ```
- 曝光唯一写入点：`ExposureEffect` 的 `uExposure`（uniform key 同步从 `exposure` 改为 `uExposure`）。
- `EXPOSURE_FRAGMENT` 加入范围判据防御（NaN/负数/±Infinity → 0）和软膝高光滚降：
  ```glsl
  uniform float uExposure;
  void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
    vec3 safeRgb = inputColor.rgb;
    bvec3 invalid = bvec3(
      !(safeRgb.r >= 0.0 && safeRgb.r <= 64.0),
      !(safeRgb.g >= 0.0 && safeRgb.g <= 64.0),
      !(safeRgb.b >= 0.0 && safeRgb.b <= 64.0)
    );
    if (any(invalid)) { safeRgb = vec3(0.0); }
    vec3 exposed = safeRgb * uExposure;
    vec3 compressed = exposed / (vec3(1.0) + max(vec3(0.0), exposed - vec3(0.85)) * 0.45);
    float safeAlpha = (inputColor.a >= 0.0 && inputColor.a <= 1.0) ? inputColor.a : 1.0;
    outputColor = vec4(compressed, safeAlpha);
  }
  ```
- 目标曝光公式保持"亮度越高曝光越低"，范围变为 `1.0 → 0.85`。

## 3. 验证（真实执行）

- `npx tsc -p tsconfig.json --noEmit --incremental false` → **0 error**
- `npx next lint` → **No ESLint warnings or errors**
- `node scripts/lint-glsl.mjs` → **0 处 HIGH**
- `node scripts/verify.mjs --quick` → **7/7 通过**
- 实拍（`docs/summit/shots/r62-exposure/`）：
  - SwiftShader overview：亮度均值 20.3，过曝 **0.04%**，`ctxLost=false`，`console error=0`；
  - SwiftShader crystal：均值 21.0，过曝 0.04%；
  - D3D11 真实 ANGLE→HLSL（`r62-exposure-d3d11/overview-1920x1080.png`）：
    renderer = `ANGLE (NVIDIA GeForce RTX 5070 Laptop GPU, Direct3D11 vs_5_0 ps_5_0, D3D11)`，
    均值 26.6，过曝 **0.02%**，`ctxLost=false`，`console error=0`。
- 视觉确认：左侧 `worker-beta` 下方地面恢复深空黑曜石底色，不再出现亮白高光片；
  场景整体亮度下降但没有死黑（均值约 20–27，过曝 ≤0.04%）。

## 4. 未验证 / 风险

1. 反射 `resolution` 改为固定 512，低端/降级设备失去原有的 256 自适应，填充率开销上升；
   若需恢复，可在保留 `envMapIntensity=0` 与黑曜石配比的前提下把分辨率重新接回档位变量。
2. Bloom 强度/阈值/levels 现在所有档位一致，不再按 T3/T2 分级；低端设备泛光成本略升。
3. ExposureDriver 的挂载 `useEffect` 与 `ClusterCanvas.onCreated` 都把 exposure 设为 1.0，
   顺序上 effect 后执行，当前一致；若未来有第二条写 `toneMappingExposure` 的路径需同步。
4. 非 Composer（软渲染/低档）路径下没有后处理曝光压缩，只靠渲染器 1.0 与 Bloom 关闭，
   因此本轮的软膝只作用于 Composer 路径。
5. D3D11 只覆盖本机 NVIDIA 驱动；`qualityBloomIntensity` / `qualityBloomLevels` 常量已不再使用，
   本轮未删除（不影响编译与运行，留待专门 dead-code 清理）。
6. Crystal 截图首次曾出现一帧 canvas 未合成的全黑，重试即正常（`ctxLost=false`、`error=0`），
   判定为无头捕获时序抖动，不作为通过依据。

## 5. 回滚

```bash
git revert --no-edit <本轮 commit>
git reset --hard 70f65ac   # R61 MasterNode3D 修复
```