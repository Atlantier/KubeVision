# R28 · 流量方向性 / 统一节拍 / 低档位地面反射带 / 差距清单

> 四条追问：①回程数据流与"回程缺失"语义；②机架状态灯统一 3.6s 节拍；
> ③低档位机架底部程序化反射带（无额外反射 pass）；④差距清单（`R12-gap.md`）。

---

## 1. 追问 1：流量方向性

新增 `src/components/canvas/ReturnStream3D.tsx`：

| 项 | 实现 |
|---|---|
| 回程粒子 | 复用 `LANE_CURVES`（NetworkStream3D 已导出），沿同一曲线 **t=1→0 反向取样** |
| 颜色 | 淡蓝 `#93c5fd`，与去程主题青形成方向区分 |
| 数量/成本 | 3 车道 × 18 = 54 实例，**单个 InstancedMesh（1 draw call）** |
| "回程缺失" | 每 250ms 检查该机架：节点非 Ready 或存在非 Running Pod → 该车道回程实例 scale=0（请求还在发、响应回不来） |
| 零分配 | useFrame 复用模块级 `Object3D / Color / Vector3`，零 setState |

**截图证据**：`docs/summit/shots/r28-flow/overview-1366x768.png`（软渲染 T0 下回程粒子可见）。

---

## 2. 追问 2：机架状态灯统一节拍

在 `WorkerRack3D.tsx` 引入 **MOTION_BEAT = 3.6s**：

| 光效 | 旧 | 新 |
|---|---|---|
| 导光柱呼吸（EDGE_BREATH_RATE） | 2.8 rad/s | **RACK_BREATH_RATE = 2π/(3.6/2)**（周期 1.8s） |
| 顶部落束光斑（BEAM_BLOOM_PULSE_RATE） | 3.9 rad/s | **同 RACK_BREATH_RATE** |
| 告警脉冲（CRITICAL_PULSE_RATE） | 4.0 rad/s | **RACK_ALERT_RATE = 2π/(3.6/3)**（周期 1.2s） |
| 相位 | 各机架独立 | `rackIndex × 2π/3`（同一拍子上的三声部） |

---

## 3. 追问 3：低档位地面反射带

新增 `src/components/canvas/RackGroundReflection.tsx`：

- 每座机架底部一条 **0.2 高**的渐变平面（底部亮、向上淡出、两侧羽化），
  加色混合，模拟镜面地板的近场倒影；
- 3 个平面共享 shader（各 1 draw call，合计 +3）；
- **仅在 `reflectorEnabled === false`（低档位/软渲染）时挂载**——正好补上
  全场景反射被关闭后的接地感缺失，不增加任何离屏渲染。

---

## 4. 追问 4：差距清单

已写入 **`docs/summit/R12-gap.md`**：

| 维度 | 分数 | 是否 R13 补强 |
|---|---|---|
| 机架质感 | 3 | ⚠️ |
| 景深 | 3 | ⚠️ |
| 数据流拖尾 | 3 | ⚠️ |
| HUD 铭牌 | 4 | — |
| 地面 | 3 | ⚠️ |

低于 4 分的四项已列出具体补强动作（A4 刀片灯阵、真机景深标定、拖尾负载映射、
反射一致性、aoMap 盒状模糊）。

---

## 5. 验收（真实输出）

```
shot.mjs --scene pod-closeup : 5 FPS / 201.9ms / 143 draws / 133,840 tris  console error=0
shot.mjs --scene overview    : 4 FPS / 233.8ms / 416 draws / 205,924 tris  console error=0
probe-blackout : GREEN（黑屏 0 / 采样 48 / 错误 0）
lint-glsl      : HIGH 命中 0 · INFO 11
verify.mjs     : 33/33（348 meshes / 25 InstancedMesh / 371 geometries；419 draws）
tsc 0 · next lint 干净
```

**draw calls 变化**：overview 412 → **416（+0.97%，≤5%）**，其中 +1 为回程 1 个
InstancedMesh、+3 为低档位反射带 3 个平面；pod-closeup 143 → **143（0%）**。

---

## 6. 未验证项与风险

1. **"回程缺失"未在真实故障下截图验证**：软渲染环境可通过注入 OOM 混沌观察，
   本轮未做该时序截图（代码路径经 tsc/lint 与逻辑审阅）。
2. **统一节拍的观感**需真机连续观察（软渲染 4–5 FPS 下无法判断"整齐"）。
3. **地面反射带与真实反射的叠加**：T0 下只有反射带、无真实反射；
   真机 T3 两者同时存在时是否过亮未验证。
4. **R12 打分是主观评估**，依据 R27/R28 的截图与实现清单，不冒充客观指标。

---

## 7. 回滚

```bash
git revert --no-edit <本轮 commit>
git reset --hard b172407     # 回到 r27
git reset --hard v12-baseline
```