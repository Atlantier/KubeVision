/**
 * KubeVision AI — 数据中心 3D 空间布局引擎（纯数学模块，零依赖 / SSR 安全）
 *
 * 【设计意图】（AGENTS.md 第 8 条：核心算法中文原理注释契约）
 * 把「三机架环形拓扑 + 机架内 16 槽位托盘」的逻辑坐标（rackIndex, slotIndex）
 * 确定性地映射为 WebGL 世界坐标，供 R3F 场景摆放 Worker 机架与 Pod InstancedMesh
 * 实例矩阵，以及 Copilot「聚焦到某 Pod」的相机机位计算。
 *
 * 【模块纯度契约】本文件是纯函数/纯常量模块：
 * - 不 import three（连类型都不依赖），返回裸元组 [x, y, z]，
 *   由 R3F 组件在客户端边界消费，天然规避 SSR 求值 three 的风险（AGENTS.md 第 4 条）；
 * - 无 window / Date.now / Math.random，同一输入恒得同一输出，
 *   服务端预渲染与客户端水合逐位一致，杜绝 Hydration Mismatch；
 * - 所有三角函数调用为 O(1) 标量运算，可在 useFrame 外预计算缓存。
 *
 * 【坐标系约定】右手系，Y 轴向上（Three.js 默认）：
 * - 世界中心 (0, 0, 0) 为「指挥台/MASTER 全息投影」锚点；
 * - 三个 Worker 机架以 RACK_RADIUS 为半径均匀环绕中心（间隔 120°）；
 * - 每个机架的正面（局部 +Z 轴方向）朝向世界中心，保证操作者
 *   绕场观察时永远面对机架的插槽面板。
 *
 * 【核心数学：Three.js 绕 Y 轴旋转矩阵】
 * 对局部向量 v = (x, y, z)，绕 Y 轴旋转 θ 弧度后：
 *   R_y(θ) · v = ( x·cosθ + z·sinθ,  y,  -x·sinθ + z·cosθ )
 * 特别地，局部 +Z 单位向量 (0,0,1) 被映射到世界方向 (sinθ, 0, cosθ) ——
 * 这是下文所有「朝向中心」推导的基石。
 */

/* ========================================================================== */
/* 全局布局常量                                                                */
/* ========================================================================== */

/**
 * MASTER 指挥台全息投影的世界坐标锚点。
 *
 * 【语义】位于三机架环形布局的几何中心正上方 2.5 单位处：
 * (0, 2.5, 0)。集群健康分全息球 / 全局 QPS 流量环等 MASTER 级
 * 可视化元素挂载于此，与环形机架形成「中心指挥 + 外围阵地」的
 * 深空作战室构图。
 */
export const MASTER_POSITION: [number, number, number] = [0, 2.5, 0];

/**
 * 三机架环形布局半径（世界单位）。
 *
 * 【取值依据】机架高度约 4.4 单位（4 层托盘），半径 9.5 保证：
 * 1. 相邻机架弧间距 2·R·sin(60°) ≈ 16.45 单位，远超机架宽度，零视觉重叠；
 * 2. 中心 MASTER 投影与任一机架正面保持约 9.5 单位纵深，
 *    默认广角相机（fov 50°）在中心上方即可一屏收纳全部三机架；
 * 3. Pod 特写机位（见 getPodWorldTransform）沿内法线后退 1.6 单位后，
 *    与对侧机架仍有充足景深，虚化层次自然。
 */
export const RACK_RADIUS = 9.5;

/* ========================================================================== */
/* 机架内部几何参数（局部坐标系，未导出的模块级常量，集中定义防漂移）             */
/* ========================================================================== */

/** 每机架槽位总数：4 层 × 每层 4 槽 = 16（slotIndex ∈ [0, 15] 契约的物理来源） */
const SLOTS_PER_RACK = 16;

/** 每层托盘槽位数：2 行（纵深）× 2 列（水平）= 4 */
const SLOTS_PER_TIER = 4;

/** 层数（垂直方向托盘数） */
const TIER_COUNT = SLOTS_PER_RACK / SLOTS_PER_TIER; // = 4

/** 层间距（垂直方向相邻托盘中心距，世界单位） */
const TIER_HEIGHT = 1.05;

/** 首层（tier 0）托盘中心的局部 Y 高度：机架底座抬升，保证最底层 Pod 悬浮于地面之上 */
const TIER_BASE_Y = 0.55;

/** 同层两列（col 0 / col 1）的水平中心距 */
const COL_SPACING = 0.86;

/** 同层两行（row 0 前排 / row 1 后排）的纵深中心距（沿局部 Z 轴） */
const ROW_DEPTH = 0.62;

/**
 * Pod 容器盒子的契约参考高度（世界单位）。
 *
 * 【双重职责】
 * 1. 相机取景计算的高度基准（见 CAMERA_FOCUS_DISTANCE 推导）；
 * 2. **渲染落座基准**：PodInstancedMesh 的可视盒高（0.38）小于本契约值，
 *    其落座偏移必须由「契约盒底面 = 隔板顶面」关系推导：
 *    seatOffset = 可视盒高/2 − POD_BOX_HEIGHT/2 = 0.19 − 0.46 = −0.27，
 *    导出本常量使渲染器与布局数学共享单一事实源，严禁在组件里硬编码 0.46。
 */
export const POD_BOX_HEIGHT = 0.92;

/**
 * 特写相机沿 Pod 正面法线的后退距离（世界单位）。
 *
 * 【取景推导】目标 fov = 50°（垂直视场角）时，距离 D 处可视高度
 *   h = 2·D·tan(fov/2) = 2 × 1.6 × tan(25°) ≈ 1.494
 * 略大于 Pod 盒高 0.92：目标 Pod 完整入画且占屏约 62%，
 * 上下余量恰好带出同层邻位 Pod 的边缘，保留空间语境。
 */
const CAMERA_FOCUS_DISTANCE = 1.6;

/**
 * 特写相机相对 Pod 中心的抬升高度（世界单位）。
 *
 * 【视角推导】抬升 0.42、水平距离 1.6 时俯角
 *   φ = atan(0.42 / 1.6) ≈ 14.7°
 * 轻微俯视既展示 Pod 顶面状态灯环，又不破坏正面标签可读性。
 */
const CAMERA_FOCUS_ELEVATION = 0.42;

/* ========================================================================== */
/* 返回载荷接口                                                                */
/* ========================================================================== */

/** 机架世界变换载荷：位置 + 绕 Y 轴朝向旋转 */
export interface RackTransform {
  /** 机架原点（底座中心）的世界坐标 */
  readonly position: [number, number, number];
  /** 绕 Y 轴旋转弧度，使机架正面（局部 +Z）朝向世界中心 (0,0,0) */
  readonly rotationY: number;
}

/** Pod 世界变换载荷：位置 + 朝向 + 特写相机机位 */
export interface PodWorldTransform {
  /** Pod 盒子中心的世界坐标 */
  readonly position: [number, number, number];
  /** 绕 Y 轴旋转弧度（继承机架朝向，Pod 正面同样朝向世界中心） */
  readonly rotationY: number;
  /** 特写相机最佳观察机位的世界坐标（位于 Pod 正面法线外侧，轻微俯视） */
  readonly cameraPosition: [number, number, number];
}

/* ========================================================================== */
/* 机架布局                                                                    */
/* ========================================================================== */

/**
 * getRackTransform —— 计算机架 k 的世界位置与朝向旋转。
 *
 * 【几何推导】
 * 1. 极角均分：三个机架以 120° 间隔环绕中心，
 *      α_k = 2πk / 3,  k ∈ {0, 1, 2}
 *    （k=0 → 0°，k=1 → 120°，k=2 → 240°）。
 *
 * 2. 位置参数化：采用「Z 轴为 0° 基准、角度绕 +Y 顺时针展开」的参数化
 *      P_k = ( R·sin α_k,  0,  R·cos α_k )
 *    选择该形式（而非 cos/sin 互换）的原因见第 3 步——它与 Three.js
 *    绕 Y 旋转对 +Z 轴的映射 (sinθ, 0, cosθ) 完全同构，
 *    使朝向公式收敛为一个极简的相位平移。
 *
 * 3. 朝向中心：机架正面（局部 +Z）经 R_y(θ) 映射到世界方向 (sinθ, 0, cosθ)。
 *    「正面朝向世界中心」等价于正面方向 = 由 P_k 指向原点的单位向量：
 *      target_dir = (0,0,0) − P_k 归一化 = ( −sin α_k,  0,  −cos α_k )
 *    于是需要：
 *      sinθ = −sin α_k  且  cosθ = −cos α_k
 *    两式同时成立的唯一解（模 2π）是相位平移 π：
 *      θ = α_k + π
 *    即机架先按极角站位，再自转 180° 面向圆心。
 *
 * 【输入输出】
 * @param rackIndex 机架索引，合法域 {0,1,2}；越界值按模 3 环形归约（容错，不抛异常）
 * @returns RackTransform —— position: P_k（y=0，机架底座落地），rotationY: θ = α_k + π
 */
export function getRackTransform(rackIndex: number): RackTransform {
  // 环形归约：保证任意整数输入都落在 {0,1,2}（负数经 ((n%3)+3)%3 修正）
  const k = ((rackIndex % 3) + 3) % 3;

  // 极角 α_k = 2πk/3
  const alpha = (2 * Math.PI * k) / 3;

  // 位置 P_k = (R·sinα, 0, R·cosα)
  const position: [number, number, number] = [
    RACK_RADIUS * Math.sin(alpha),
    0,
    RACK_RADIUS * Math.cos(alpha),
  ];

  // 朝向旋转 θ = α_k + π（正面局部 +Z → 世界 (sinθ,0,cosθ) = 指向圆心的单位向量）
  const rotationY = alpha + Math.PI;

  return { position, rotationY };
}

/* ========================================================================== */
/* Pod 槽位布局                                                                */
/* ========================================================================== */

/**
 * getPodWorldTransform —— 计算机架内第 slotIndex 个 Pod 容器的完整世界变换
 * 与特写相机机位。
 *
 * 【槽位分解：一维索引 → 三维局部坐标】
 * 每机架 16 槽按「4 层托盘 × 每层 2 行(纵深) × 2 列(水平)」组织，
 * 对 slotIndex s ∈ [0,15] 做混合进制分解（先除层、再除行）：
 *   tier  t = ⌊s / 4⌋        ∈ {0,1,2,3}   —— 层号（Y 轴）
 *   j     = s mod 4          ∈ {0,1,2,3}   —— 层内槽号
 *   row   r = ⌊j / 2⌋        ∈ {0,1}       —— 行号：0 前排(靠机架正面)、1 后排
 *   col   c = j mod 2        ∈ {0,1}       —— 列号：0 左列、1 右列
 * 该分解与 cluster.ts 种子数据的槽位约定严格一致
 * （种子 Pod 占 j ∈ {0,1} 即每层前排两列，j ∈ {2,3} 留作扩容位）。
 *
 * 【局部坐标（机架坐标系，原点 = 机架底座中心，+Z 指向机架正面）】
 *   x_local = (c − 0.5) · COL_SPACING   —— 列偏移对称分布于 ±COL_SPACING/2
 *   y_local = TIER_BASE_Y + t · TIER_HEIGHT —— 首层抬升 0.55，逐层 +1.05
 *   z_local = (0.5 − r) · ROW_DEPTH     —— 前排(r=0) z=+0.31 靠近正面，后排(r=1) z=−0.31
 *
 * 【刚体变换：局部 → 世界】
 * 机架在世界中经历「绕 Y 轴自转 θ，再平移至 P_k」，故 Pod 世界坐标为
 * 经典 TRS 复合（先旋转后平移）：
 *   P_world = R_y(θ) · v_local + P_k
 * 展开 R_y(θ)（见文件头旋转矩阵定义）：
 *   x_world = P_k.x + x_local·cosθ + z_local·sinθ
 *   y_world = P_k.y + y_local                 （绕 Y 旋转不改变 Y 分量）
 *   z_world = P_k.z − x_local·sinθ + z_local·cosθ
 * Pod 自身朝向 rotationY 直接继承机架 θ：Pod 正面（局部 +Z）随机架
 * 一并转向圆心，保证任何机位下标签/状态灯环朝向观察者一侧。
 *
 * 【特写相机机位推导】
 * 1. Pod 正面法线（世界系）：局部 +Z 经 R_y(θ) 映射，即
 *      n = (sinθ, 0, cosθ)
 *    由 getRackTransform 的朝向推导可知 n 恒指向世界中心（水平内法线）。
 * 2. 机位 = Pod 中心沿法线后退 D，再抬升 E：
 *      C = P_world + n · CAMERA_FOCUS_DISTANCE + (0, CAMERA_FOCUS_ELEVATION, 0)
 *    D=1.6 的取景覆盖与 E=0.42 的 14.7° 俯角推导见两常量的 JSDoc。
 * 3. 该机位天然位于环形布局内侧（朝向中心一侧），与相邻机架连线
 *    夹角 ≥ 60°，无遮挡风险；lookAt 目标即 P_world。
 *
 * 【输入输出】
 * @param rackIndex 机架索引，合法域 {0,1,2}（越界按模 3 归约）
 * @param slotIndex 槽位索引，合法域 [0,15] 整数（越界按模 16 归约，容错不抛异常）
 * @returns PodWorldTransform —— position / rotationY / cameraPosition 三元载荷
 */
export function getPodWorldTransform(rackIndex: number, slotIndex: number): PodWorldTransform {
  /* ---- 1. 索引归约（环形容错） ---- */
  const k = ((rackIndex % 3) + 3) % 3;
  const s = ((Math.floor(slotIndex) % SLOTS_PER_RACK) + SLOTS_PER_RACK) % SLOTS_PER_RACK;

  /* ---- 2. 槽位一维索引 → (层, 行, 列) 混合进制分解 ---- */
  const tier = Math.floor(s / SLOTS_PER_TIER); // t ∈ {0..3}
  const j = s % SLOTS_PER_TIER; // 层内槽号 ∈ {0..3}
  const row = Math.floor(j / 2); // r ∈ {0 前排, 1 后排}
  const col = j % 2; // c ∈ {0 左列, 1 右列}

  /* ---- 3. 机架局部坐标（原点 = 机架底座中心） ---- */
  const localX = (col - 0.5) * COL_SPACING; // ±COL_SPACING/2 对称
  const localY = TIER_BASE_Y + tier * TIER_HEIGHT; // 逐层抬升
  const localZ = (0.5 - row) * ROW_DEPTH; // 前排靠正面(+z)，后排靠背板(−z)

  /* ---- 4. 机架世界位姿（复用 getRackTransform，单一事实源） ---- */
  const rack = getRackTransform(k);
  const theta = rack.rotationY;
  const cosT = Math.cos(theta);
  const sinT = Math.sin(theta);

  /* ---- 5. TRS 复合：v_world = R_y(θ)·v_local + P_k ---- */
  const posX = rack.position[0] + localX * cosT + localZ * sinT;
  const posY = rack.position[1] + localY; // R_y 不改变 Y 分量
  const posZ = rack.position[2] - localX * sinT + localZ * cosT;
  const position: [number, number, number] = [posX, posY, posZ];

  /* ---- 6. 特写相机机位：C = P + n·D + (0, E, 0)，n = (sinθ, 0, cosθ) 为水平内法线 ---- */
  const cameraPosition: [number, number, number] = [
    posX + sinT * CAMERA_FOCUS_DISTANCE,
    posY + CAMERA_FOCUS_ELEVATION,
    posZ + cosT * CAMERA_FOCUS_DISTANCE,
  ];

  /* ---- 7. Pod 朝向继承机架自转角（正面随机架转向圆心） ---- */
  return { position, rotationY: theta, cameraPosition };
}

/* ========================================================================== */
/* 布局自检常量与机架几何契约（渲染组件与布局数学共享的唯一事实源）                  */
/* ========================================================================== */

/**
 * 层数导出（TIER_COUNT 的只读投影）：供 Copilot 面板/图例展示
 * 「4 层 × 4 槽」托盘结构说明，避免 UI 层魔法数字。
 */
export const RACK_TIER_COUNT: number = TIER_COUNT;

/** 首层托盘中心高度导出（WorkerRack3D 隔板与 Pod 槽位 Y 坐标同源） */
export const RACK_TIER_BASE_Y: number = TIER_BASE_Y;

/** 层间距导出（同上：隔板逐层抬升量必须与 getPodWorldTransform 一致） */
export const RACK_TIER_HEIGHT: number = TIER_HEIGHT;

/**
 * RACK_BODY_SIZE —— 机架装甲外框尺寸 [宽, 高, 深]（世界单位）。
 *
 * 【同源契约】高度必须容纳 4 层托盘：
 *   顶层托盘中心 = TIER_BASE_Y + 3 × TIER_HEIGHT = 0.55 + 3.15 = 3.70，
 *   加托盘半厚与顶盖余量 → 4.4 恰好封顶；宽 2.6 / 深 1.8 为 19 英寸
 *   标准机柜的视觉比例投影。WorkerRack3D 与 cameraFocus 取景共用本常量。
 */
export const RACK_BODY_SIZE: readonly [number, number, number] = [2.6, 4.4, 1.8];

/** 机架装甲外框中心高度（底座落地，柜体沿 +Y 展开） */
export const RACK_BODY_CENTER_Y: number = RACK_BODY_SIZE[1] / 2;

/** 两侧垂直霓虹导光柱的局部 X 坐标（±宽/2 − 内缩量，嵌在装甲框边角内侧） */
export const RACK_LIGHT_GUIDE_X: number = RACK_BODY_SIZE[0] / 2 - 0.13;
