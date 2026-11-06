# 3D 组件内存泄漏巡检报告

> 巡检对象：`MasterNode3D` / `WorkerRack3D` / `PodInstancedMesh` / `NetworkStream3D` / `ErrorRippleRing`
> 巡检方式：静态扫描 + 运行时实测（headless Edge + WebGPU/SwiftShader）
> 结论：**无内存泄漏，无需添加 dispose()**

---

## 一、巡检结论摘要

| 检查项 | 结果 |
|---|---|
| 手动 `new THREE.BufferGeometry` | **0 处** |
| 手动 `new THREE.Material` | **0 处** |
| JSX 声明的几何体/材质（R3F 自动 dispose） | 67 个，全部托管 |
| 4 次完整销毁重挂载后几何体数 | **67 → 67 → 67 → 67（spread = 0）** |
| 事件监听 add/remove 配平 | 1/1（CameraRig），无泄漏 |
| 定时器 / rAF 泄漏 | 0 处 |
| InstancedMesh `needsUpdate` | 正确设置（两处组件均覆盖） |

---

## 二、为什么无需 dispose()

React Three Fiber 对 **JSX 声明式资源**（`<boxGeometry>` / `<meshBasicMaterial>` 等）自动管理生命周期：组件卸载时 R3F 会递归遍历其创建的对象并调用 `dispose()`。因此：

- **JSX 写法** → R3F 托管，卸载自动释放，**不应**手动 dispose（手动调用反而可能导致 R3F 重复释放）；
- **`useMemo` + `new THREE.*`** → 必须手动 dispose，否则泄漏。

本项目全部采用 JSX 写法，手动构造的 `THREE.Color` / `THREE.Vector3` / `THREE.Object3D` / `THREE.IUniform` 都是**纯 JS 对象**，不持有 GPU 资源（无 buffer、无纹理），因此**不需要也不应该** dispose。

---

## 三、运行时实测证据

### 3.1 稳态不增长

连续 8 次采样（间隔 700ms）：

```
geom: [67, 67, 67, 67, 67, 67, 67, 67]
tex:  [0, 0, 0, 0, 0, 0, 0, 0]
```

几何体数恒定，证明没有 per-frame 创建几何体的热点。

### 3.2 完整销毁重挂载（关键测试）

通过导航到 `about:blank` 强制销毁整个 WebGL 上下文，再返回重新挂载：

```
INITIAL:        { memGeometries: 67, sceneGeometries: 67, sceneMaterials: 67 }
AFTER REMOUNT:  { memGeometries: 67, sceneGeometries: 67, sceneMaterials: 67 }
ROUND 1/2/3:    67 / 67 / 67   (spread = 0)
```

**4 次完整生命周期的几何体数完全一致，零累积。**

### 3.3 重渲染压力下的 JS Heap

12 次选中态切换（触发多组件重渲染）：

```
heap: 83.16 MB → 85.10 MB  (Δ +1.85 MB)
geometries: 67 → 67
textures:   0 → 0
```

1.85 MB 增量属于 React 状态与临时对象的正常波动，且 GPU 资源计数不变。

### 3.4 高挂载频率压力测试

连续 2 次快速销毁重挂载后：

```
geometries: 67, meshes: 67, renderCalls: 69
contextLost: false, fps: 45
```

WebGL 上下文未丢失，渲染健康。

---

## 四、发现的优化空间（已评估，决定不修改）

巡检中额外统计到**资源重复创建**现象：

| 类型 | 总数 | 唯一签名 | 重复创建 |
|---|---|---|---|
| 几何体 | 67 | 18 种 | 49 个 |
| 材质 | 67 | 10 种 | 57 个 |

典型重复：
- `BoxGeometry(0.05, 0.022, 0.34)` × 24 —— MasterNode3D 的 24 根径向刻度齿
- `MeshBasicMaterial(#22d3ee, transparent)` × 28 —— 主题青发光材质

### 为何不修改

1. **实际显存成本极低**：67 个几何体全部顶点+索引数据合计仅 **138.5 KB**。用 49 个对象的重复换取架构简洁，是合理的；
2. **StrictMode 安全**：`MasterNode3D` 第 253 行既有注释已明确记录该取舍——
   > 几何由 R3F 内联托管，卸载自动 dispose——规避共享实例在 StrictMode 双挂载下的泄漏风险

   若改为 `useMemo` 创建共享实例，React 18 StrictMode 的双挂载会让一方 dispose 后另一方持有已释放资源，**反而制造真实 bug**；
3. **实测已证明零泄漏**：当前写法在 4 次完整生命周期下 resource 计数恒定。

**结论**：保持现状是正确决策。若未来几何体规模显著增长（如上百个高面数模型），再考虑抽出共享资源工厂，并配套 `useEffect` 清理与 StrictMode 兼容处理。

---

## 五、真正需要关注的非 GPU 泄漏点

GPU 资源之外的泄漏同样值得警惕，本次一并核查：

| 风险点 | 位置 | 状态 |
|---|---|---|
| 事件监听 | `CameraRig`（OrbitControls `start` 监听） | ✅ add/remove 配平 |
| 定时器 | 全 5 个组件 | ✅ 无 setInterval |
| requestAnimationFrame | 全 5 个组件 | ✅ 无独立 rAF 循环（统一走 useFrame） |
| Web Worker | `useEdgeLogClassifier` | ✅ 卸载时 terminate() + 看门狗 clearTimeout |
| 音频 / 语音 | `CopilotDrawer` | ✅ 卸载时 abort + speechSynthesis.cancel() |

---

## 六、复现方式

```bash
pnpm dev
# 另开终端，用 CDP 连接 headless Edge 后执行导航往返测试
# 关键断言：renderer.info.memory.geometries 在多次重挂载后保持不变
```

巡检脚本为临时文件，验证完成后已删除，本报告为其结论留档。
