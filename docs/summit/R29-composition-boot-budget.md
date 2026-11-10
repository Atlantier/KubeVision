# R29 · 构图 / 开场编排 / 发光预算 / 动效节拍 / 质量治理

> 本轮为"叙事与治理"专项。**诚实说明**：A/B/C/D/E 已落地，F 为骨架级部分落地，
> G 未做。逐项状态见下表。

---

## 1. 交付状态

| 项 | 状态 | 证据 / 说明 |
|---|---|---|
| A 构图：`OVERVIEW_LOOK_AT` [0,2.5,0]→[0,1.20,0] | ✅ | `cameraFocus.ts`；相机 [7.8,14,22] 与 fov 未动；verify `相机聚焦联动` 断言**照常通过**（该断言只判 pos[1]≈14/pos[2]≈22，注视点变化不影响，无需改基准） |
| B 开场编排 uBoot | ✅ 核心 | 模块级 `bootUniform`（`src/utils/bootUniform.ts`）+ 唯一推进者 `BootController`（0–1.2s + smoothstep）；晶核 scale 已乘 uBoot；`prefers-reduced-motion: reduce` 时 uBoot=1、不播开场、循环幅度系数常量就位（REDUCED_MOTION_AMPLITUDE=0.25） |
| C 开场运镜 | ✅ 核心 | `CameraRig`：挂载时 [10.6,17.2,26.5] → OVERVIEW（0–2.4s，k=3.2 阻尼，到位精确落位）；用户拖拽即终止；HUD 分段入场未做（CSS 延迟） |
| D 发光预算 | ✅ 常量 + 开发扫描 + 调试浮层 | `src/constants/glowBudget.ts` 四区预算表 + `scanGlowBudget/validateGlowBudget`（dev 4s 后扫描，超预算 console.warn）；`?glowDebug=1` 浮层显示每区 current/budget/构成 |
| E 动效节拍 MOTION_BEAT=3.6s | 🟡 部分 | `src/constants/motion.ts` 定义全套 ω；**晶核呼吸/漏光/星芒/陀螺环已切换**；地面环/雷达扫掠/故障涟漪尚未全部替换 |
| F 质量治理器 M1 | 🟡 骨架 | `useQualityStore`（非持久化，?quality=high/balanced/low 覆盖，?demo=1 禁自动）+ `useQualityGovernor`（2Hz 采样，<50 连续 2 次降档、>58 连续 3 次升档、30s 冷却）；**已接入 DoF 门控**；Bloom 级别/强度、粒子密度、阴影、反射、后处理全关的档位映射与 Shift+P 三档按钮**未完成** |
| G draw call 合并 | ❌ 未做 | 三座机架静态装饰跨机架共享 InstancedMesh 未实施 |
| H 验收 | 🟡 部分 | overview 截图、glowDebug 浮层、verify/blackout/lint-glsl 全绿；**开局三帧与档位切换录屏未采集** |

**核心不变量：降档不触发 RenderTarget/DPR 尺寸变化**（R01）：治理器只改渲染开关与参数，
本骨架尚未把 Bloom 等参数接入，接入时不得改 DPR/RT 分辨率。

---

## 2. 发光预算表（层 × 当前 × 目标）

| 分区 | 当前设计值 | 目标 | 构成 |
|---|---|---|---|
| 晶核（屏幕半径 120px 内） | 1.02 | **≤1.15** | 内核 0.22 + 雾球 0.30 + 晶体 0.28 + 星芒 0.22 |
| 地面主轨 | 0.55 | **≤0.55** | 主轨辉光 0.42 + 低档位反射带 0.13 |
| 外围（星云/大气） | 0.32 | **≤0.40** | 星云 0.12 + 大气 0.20 |
| 机架顶冠 | 0.35 | **≤0.45** | 顶冠光斑 0.20 + 棱边倒角高光 0.15 |

开发期扫描：`validateGlowBudget(scene)` 统计场景中 Additive+transparent 材质 alpha
总和并按世界坐标粗分 core/ground/outer；超预算 `console.warn`，否则 `console.info`。

---

## 3. 开场时间轴

| 时间 | 发生什么 |
|---|---|
| 0–1.2s | uBoot 线性推进 → smoothstep；晶核 scale 0.55→1.0 |
| 0–2.4s | 相机 [10.6,17.2,26.5] → [7.8,14,22]，damped k=3.2，与 uBoot 同步 |
| 1.2–2.8s | HUD 分段入场（**未实现**，原计划 CSS 延迟） |
| 3s 后 | 完全稳定在 OVERVIEW |

---

## 4. 验收真实输出

```
shot --scene overview : 4 FPS / 234.2ms / 420 draws / 205,932 tris, console error=0
probe-blackout        : GREEN（黑屏 0 / 采样 43 / 错误 0）
lint-glsl             : HIGH 命中 0 · INFO 11
verify.mjs            : 33/33（348 meshes / 25 InstancedMesh / 373 geometries；
                        2 FPS / 596.4ms / 423 draws；相机聚焦联动通过）
tsc 0 · next lint 干净
```

截图：`docs/summit/shots/r29-boot/overview-1366x768.png`（新构图）。
`?glowDebug=1` 浮层与档位切换演示**未截图**。

---

## 5. 未验证项与风险

1. **晶核屏幕位置 44% 未量化**：构图改动是几何推导 + 截图目测，未做像素测量。
2. **开场三帧/运镜未截图验证**：CameraRig 改动只经 tsc/lint；verify 采样时已落位，
   无法覆盖"飞行过程无跳变"。
3. **E 仅替换晶核相关节拍**：地面环/雷达扫掠/涟漪仍是旧频率，需 R30 收口。
4. **F 仅 DoF 门控接入**：Bloom/粒子/阴影/反射/后处理全关未接线，Shift+P 三档按钮未做；
   `?quality` 已能改 store，但大部分渲染路径尚未读取该档位。
5. **G 未做**：draw calls 420（overview）较 R28 的 416 增加 4（BootController 无绘制，
   增量来自低档位反射带/回传等既有项波动），未做跨机架合批。
6. **reduced-motion 未实测**：逻辑已写，未用 DevTools 模拟 media query 验证。

---

## 6. 回滚

```bash
git revert --no-edit <本轮 commit>
git reset --hard d2d2b02     # 回到 r28
git reset --hard v12-baseline
```