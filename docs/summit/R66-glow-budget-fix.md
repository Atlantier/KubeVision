# R66 · glowBudget `getWorldPosition` 运行时崩溃修复 + ClusterCanvas 巡检守卫

> 文件：`src/constants/glowBudget.ts`、`src/components/canvas/ClusterCanvas.tsx`、`src/components/canvas/BootController.tsx`
> 症状：开发期 4s 发光预算巡检抛 `TypeError: target.setFromMatrixPosition is not a function`，中断 Canvas effect。

## 1. 根因

`scanGlowBudget` 把普通对象当作 `getWorldPosition` 的 target：

```ts
const world = { x: 0, y: 0, z: 0 };
mesh.getWorldPosition?.(world);
```

Three.js 的 `Object3D.getWorldPosition(target)` 内部会调用
`target.setFromMatrixPosition(this.matrixWorld)`；普通对象没有该方法，
于是巡检在挂载 4s 后抛 TypeError。

## 2. 修复

### 2.1 `src/constants/glowBudget.ts`

- `import { Vector3, type Object3D } from 'three';`
- 新增 `SceneNodeLike` 最小结构：
  - `getWorldPosition?: (target: Vector3) => Vector3;`
  - `matrixWorld?: { readonly elements?: readonly number[] };`
- `scanGlowBudget` 在 `traverse` 外**预分配一次**：
  ```ts
  const world = new Vector3();
  ```
- 每个发光节点：
  1. `world.set(0, 0, 0);`
  2. 有真实 `getWorldPosition` → `mesh.getWorldPosition(world);`
  3. 否则若 `matrixWorld.elements.length >= 15` → 从 `elements[12..14]` 读取平移；
  4. 对 `world.x/y/z` 做 `Number.isFinite` 校验，异常坐标只计入总 alpha、不参与分区，
     防止 NaN 污染 `zoneSums`。
- `validateGlowBudget` 内部用 `try/catch` 包住 `scanGlowBudget`：
  巡检异常只 `console.warn`，不向调用方抛错。

### 2.2 `ClusterCanvas.tsx` 安全守卫

当前仓库唯一的调用点在 `BootController` 的 effect 中（不在 ClusterCanvas）。
本轮把探针职责移到 **`ClusterCanvas` 内的 `GlowBudgetProbe`**，并加调用侧守卫：

```tsx
function GlowBudgetProbe(): null {
  const scene = useThree((state): THREE.Scene => state.scene);
  useEffect((): (() => void) | undefined => {
    if (process.env.NODE_ENV === 'production') return undefined;
    const timer = window.setTimeout((): void => {
      try {
        validateGlowBudget(scene);
      } catch (error: unknown) {
        console.warn('[glowBudget] 巡检异常，已隔离（不影响渲染）:', error);
      }
    }, 4000);
    return (): void => window.clearTimeout(timer);
  }, [scene]);
  return null;
}
```

- `BootController` 恢复为「只推进 uBoot」的单一职责，移除 `validateGlowBudget` import 与 timer。
- `ClusterCanvas` 在 `<BootController />` 后渲染 `<GlowBudgetProbe />`；
  这样巡检与 WebGL 渲染树隔离，失败不会中断 Canvas。

## 3. 验证

```text
npx tsc --noEmit          → 0 error
npx next lint             → No ESLint warnings or errors
node scripts/lint-glsl.mjs→ 0 处 HIGH
npx next build            → exit 0（Compiled successfully / 4/4 static pages / First Load 177 kB）
```

运行时（真实 dev 页面，加载 >4s 触发巡检）：

```text
scripts/shot.mjs --scene overview
ctxLost: false
console: error=0 warn=4
亮度均值 19.5，过曝 0.04%
```

`error=0` 表示不再出现 `TypeError`；`warn=4` 是既有分区预算超出提示（非崩溃）。
截图：`docs/summit/shots/r66-glow/overview-1920x1080.png`。

## 4. 残余风险

1. `warn=4` 说明当前部分分区仍超设计预算（例如 Bloom/加色叠加），本轮只修崩溃与守卫，
   未重新调预算数值；需要时可按 `[glowBudget]` 日志逐区收敛。
2. `matrixWorld` 回退仅用于测试桩对象；真实 Object3D 始终走 `getWorldPosition(Vector3)`。
3. 巡检仍在开发期 4s 后执行一次；生产 `NODE_ENV=production` 直接空操作。

## 5. 回滚

```bash
git revert --no-edit <本轮 commit>
git reset --hard b1f75b0   # R64 末尾
```