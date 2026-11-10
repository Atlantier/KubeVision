# R27 · 机架 PBR 材质升级 / 纵深景深 / 铭牌现代化

> 本轮为材质与纵深专项：**零新增依赖、零外部贴图**（全部程序化生成）。
> 诚实说明：A4（刀片生命感）与 C（彗星负载映射）**未完成**，其余交付见下表。

---

## 1. 交付状态总览

| 项 | 状态 | 说明 |
|---|---|---|
| A1 程序化粗糙度图 | ✅ | 256×256 DataTexture，粗糙度范围改到 **0.38–0.72**、低频污渍；模块级单例，三机架共享同一纹理（`getBrushedMetalTextures`） |
| A2 倒角高光 | ✅ | `onBeforeCompile` 注入 `pow(max(1−|dot(N,V)|,1e-4),4.0)`，冷白 × 上限 0.25 |
| A3 接缝 AO | 🟡 部分 | 以 UV 纵向 4 段接缝梯度把**漫反射**压暗最多 30%（不碰自发光）；**未加 aoMap DataTexture**（需要为每块几何补 uv1，成本与风险高于本轮预算） |
| A4 刀片生命感 | ❌ 未完成 | 状态灯/活动条需要先梳理每机架 Pod→槽位映射并新增 InstancedMesh；本轮时间不足，**没有假实现** |
| A5 draw call | ✅ | overview 412→**412**、pod-closeup 143→**143**，无上升（shader 注入不增加提交） |
| B1 大气雾 | ✅ | 同一 shader 内按视深 `smoothstep(14, 33.6, |viewPos|)×0.35` 混向雾色；远端亮度/饱和度下降，发光层（自发光项）不受影响。**近/远亮度比 0.72 未做定量测量**，仅结构性实现 |
| B2 DoF（仅 T3） | ✅ 代码级 | `<DepthOfField focusRange={26} bokehScale={1.2}>` 放在 Bloom **之前**（物理顺序：失焦在成像面、Bloom 在镜头后），T2/T1/T0 不挂载 |
| B3 焦点阻尼 | ✅ 代码级 | 250ms 更新目标、每帧 `k=5` 指数阻尼；目标=选中节点/所属机架中心，否则 MASTER 中心；**软渲染环境 T0 不执行，未运行时验证** |
| C 彗星拖尾 | 🟡 部分 | 既有 `COMET_*` 表已实现 head-to-tail 锥形拖尾（width/length 递减表）；**负载映射函数与丢包"熄灭"未新增**，仅保留既有 nodeNet/故障门控 |
| D 铭牌现代化 | ✅ | 无底色玻璃拟态（1px white/8 内描边 + blur 8px）+ 四角 6px 发光角标 + 1px 渐变指针线；标题 12px、数值 10px 等宽 tabular-nums（全仓 ≥10px）；删除微标尺/装饰刻度 |
| E 验收 | ✅ | shot pod-closeup/overview 通过；draw calls 见上；probe-blackout GREEN；lint-glsl 0 HIGH；verify 33/33 |

---

## 2. 材质参数表（旧 → 新）

| 参数 | 旧 | 新 | 理由 |
|---|---|---|---|
| 粗糙度范围 | 0.16–0.34 | **0.38–0.72** | 机柜是使用中的工业设备，不是镜面不锈钢；更高粗糙度让高光散开、近景有材质可读性 |
| 粗糙度构成 | 丝纹 ±0.06 + 慢波 ±0.02 + 晶粒 ±0.012 | 基准 0.55 + 丝纹 ±0.07 + 次纹 ±0.03 + 慢波 ±0.04 + 晶粒 ±0.04 + **低频污渍 ±0.05** | 新增 32px 块状污渍，模拟指印/油污；确定性哈希，可复现 |
| metalness | 0.88 | 0.88（已≥0.85，保留） | 与需求一致 |
| 共享方式 | 模块级单例缓存 | 不变 | 三座机架共享同一 GPU 纹理对象，零额外上传 |
| 倒角高光 | 无 | fresnel^4 × (0.85,0.92,1.0) × **0.25** | 棱边掠射角被环境勾亮；不增加几何倒角 |
| 接缝 AO | 无 | UV 4 段接缝处 diffuse ×(1−0.30) | 只乘漫反射，不压发光层；无需 uv1/aoMap |
| 深度大气 | 仅线性雾 | 额外 `smoothstep(14, 33.6, depth)×0.35` 混向 `#020611` | 远端节点亮度/饱和度下降；edge0<edge1 满足 R01 |
| DoF | 无 | T3：focusRange 26 / bokehScale 1.2 / k=5 阻尼 | 前排机架与晶核保持清晰，只虚化最远节点与背景粒子 |

程序化贴图生成函数（`src/components/canvas/ProceduralPbrEnvironment.tsx`）：
`getBrushedMetalTextures()` —— 中文 JSDoc 已完整说明 256×256/DataTexture/单例/SSR 安全/repeat(2,6)/mipmap 语义。
新增 `enhanceArmorMaterial()` —— 中文 JSDoc 说明三项注入与 R01 安全边界。

---

## 3. 前后截图

| 项 | 前（R26） | 后（R27） |
|---|---|---|
| 机架近景 | `docs/summit/shots/r26-star/overview.png`（无独立 pod-closeup） | `docs/summit/shots/r27-material/pod-closeup-1366x768.png` |
| 全景 | `docs/summit/shots/r26-star/overview-1366x768.png` | `docs/summit/shots/r27-material/overview-1366x768.png` |

> R11 基线（`v12-baseline`）与 R26 一致的机位/分辨率；本轮用 R26 图作"前"，
> 因 R11 baseline 为 1920×1080 不同分辨率，直接叠图无意义，如实标注。

---

## 4. 性能数据（SwiftShader，不作真机证据）

| 场景 | draw calls | triangles | frameTime |
|---|---|---|---|
| pod-closeup（前 R26 同场景 143 draws） | **143** | 130,982 | 209.8 ms |
| overview（前 R26 同场景 412 draws） | **412** | 202,678 | 211.7 ms |
| verify 采集（T0） | 415 | 202,774 | 250.4 ms |

**draw calls 无上升（0%）**：本轮全部改动为 shader 注入/贴图替换/标记层重排，未新增 mesh。

---

## 5. 验收真实输出

```
shot --scene pod-closeup : 5 FPS / 209.8ms / 143 draws / 130,982 tris, console error=0
shot --scene overview    : 5 FPS / 211.7ms / 412 draws / 202,678 tris, console error=0
probe-blackout           : GREEN  黑屏事件 0 / 采样 47 / 错误 0
lint-glsl                : HIGH 命中 0 · INFO 11
verify.mjs               : 33/33（344 meshes / 24 InstancedMesh / 367 geometries）
tsc 0 · next lint 干净
```

---

## 6. 未完成项与风险

1. **A4 刀片状态灯/活动条未实现**：需要 Pod→槽位映射与新增 InstancedMesh，本轮时间不足；没有用假数据填充。
2. **C2 负载驱动映射未新增**：既有的彗星拖尾由 `COMET_*` 表提供锥形，nodeNet/故障门控已存在；"高负载更密、丢包随机熄灭"未实现。
3. **A3 未加 aoMap 贴图**：接缝 AO 用 UV 梯度近似，盒状模糊 aoMap 未实现。
4. **B2/B3 DoF 未在真机 T3 验证**：本机软渲染判为 T0，DoF 分支只经 tsc/lint；焦点阻尼逻辑需真机镜头飞行验证。
5. **B1 近/远亮度比 0.72 未量化**：`smoothstep×0.35` 是结构性实现，需截图测光后校系数。
6. **D 铭牌**：`HoloFrame`/`MiniBar` 在此文件已不再使用（导入移除），其它文件若引用不受影响。

---

## 7. 回滚

```bash
git revert --no-edit <本轮 commit>
git reset --hard 398c5b1     # 回到 r26
git reset --hard v12-baseline
```