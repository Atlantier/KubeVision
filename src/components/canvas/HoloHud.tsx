/**
 * KubeVision AI — 全息 HUD 视觉原语（HoloHud · 光学玻璃拟态版）
 *
 * 【本轮重构的设计目标】
 * 上一版是"典型科幻游戏 HUD"：四周闭合边框 + 深色厚底 + 4px 折角。
 * 它的问题不是不好看，而是**信息密度感压过内容**——边框把文字压成牌匾，
 * 深底让面板像贴在场景上的一块不透明贴片。
 *
 * 本轮向"高端前沿科技展厅 / 控制中心"跃升，四项具体改动：
 *
 * 1. **废除闭合边框，改光学玻璃基底**
 *    没有任何一条边是完整实线。结构感来自：
 *    上下沿各一条 1px 线性渐变折射亮边（中段最亮、两端消失），
 *    以及四角独立的 L 型靶标。这模仿真实光学仪器的边框处理——
 *    光线在玻璃边缘折射出细亮线，而不是被一圈金属框住。
 *
 * 2. **四角 6×6px / 1.5px 高精密靶标（Corner Reticles）**
 *    从"装饰折角"升级为"瞄准靶标"：尺寸放大到 6px、线宽 1.5px，
 *    并给每条边独立发光。它在暗示"该区域已被系统标定锁定"。
 *
 * 3. **斜向玻璃折射高光（Specular Sheen）**
 *    一层 135° 的极淡白青渐变扫过面板。玻璃与塑料的区别就在这道高光：
 *    塑料是均匀漫反射，玻璃有一道明确的反射带。
 *
 * 4. **毫米级微标尺（Micro Ruler）**
 *    长短交替的刻度 + 游标三角 + 等宽遥测编号。
 *    它是"精密仪器感"最廉价的来源——同样的文字加上一把尺子，
 *    立刻从"信息卡片"变成"测量仪表"。
 *
 * 【AGENTS.md 契约】
 * - 全部为纯展示组件，不接受指针事件；外层 `<Html>` 由调用方负责
 *   `zIndexRange={[10,0]}` + `pointer-events-none`（本文件内的容器
 *   同样带 `pointer-events-none`，双重保险）。
 * - 零外部资源：全部视觉由 CSS 渐变 / 内联 SVG 实现，无图片请求。
 * - 无 `any`、无省略占位。
 */

import type { CSSProperties, ReactNode } from 'react';

import { cn } from '@/utils/cn';

/* ========================================================================== */
/* 四角高精密靶标（Corner Reticles）                                            */
/* ========================================================================== */

/**
 * 靶标的基准边长与线宽（px）+ 放大倍数。
 *
 * 【为何不直接写 width:6px / border-width:1.5px —— 实测踩到的坑】
 * Chrome 会把**分数边框宽度向下取整**到整数 CSS 像素：
 * 实测 `border-width: 1.5px` 的计算值返回 `1px`，`2.5px` 返回 `2px`，
 * 而 `1px`/`2px` 正常。也就是说直接写 1.5px 在 Chrome 里
 * 永远渲染成 1px，规格要求的"1.5px 线宽"根本达不到。
 *
 * 【解法：小基座 + transform: scale(1.5)】
 * 基座用 4px / 1px（两个整数值，渲染精准），再整体 scale(1.5)：
 *   · 布局尺寸 4×4 → 视觉 6×6
 *   · 边框 1px → 视觉 1.5px
 * transform 是**合成阶段**的变换，不做布局取整，因此能真正得到 1.5px。
 *
 * 【为何不用 box-shadow 模拟】实测 box-shadow 的 spread 确实保留
 * 1.5px（`0 0 0 1.5px` 未被取整），但它只能画**完整矩形**，
 * 画不出 L 型折角。折角必须靠两条相邻边，而边只能用 border 表达。
 */
const RETICLE_BASE_PX = 4;
const RETICLE_SCALE = 1.5;

/**
 * HoloCorners —— 四角独立 L 型发光靶标。
 *
 * 【与闭合边框的本质区别】闭合边框是一条连续的线，视觉上把面板
 * "封起来"；四个独立靶标则暗示"面板的四个基准点被标定"，
 * 中间是开放的。后者是仪器语言，前者是卡片语言。
 *
 * 【transform-origin 必须逐角对齐】缩放默认围绕中心，会让折角
 * 向内侧偏移半像素、贴不住面板边缘。因此每个角的 origin 都设成
 * 自己的那个角，缩放方向朝面板内部展开，外缘始终与容器边缘重合。
 *
 * @param color 靶标发光色（默认主题青）
 */
export function HoloCorners({ color = '#22d3ee' }: { readonly color?: string }): ReactNode {
  const base: CSSProperties = {
    color,
    width: RETICLE_BASE_PX,
    height: RETICLE_BASE_PX,
    borderWidth: 1,
    transform: `scale(${RETICLE_SCALE})`,
    /* 独立发光：让细线在暗场里"亮"起来，而不是一条灰线 */
    filter: `drop-shadow(0 0 2px ${color})`,
  };
  return (
    <>
      <span
        aria-hidden
        className="pointer-events-none absolute left-0 top-0 border-l border-t border-current"
        style={{ ...base, transformOrigin: 'top left' }}
      />
      <span
        aria-hidden
        className="pointer-events-none absolute right-0 top-0 border-r border-t border-current"
        style={{ ...base, transformOrigin: 'top right' }}
      />
      <span
        aria-hidden
        className="pointer-events-none absolute bottom-0 left-0 border-b border-l border-current"
        style={{ ...base, transformOrigin: 'bottom left' }}
      />
      <span
        aria-hidden
        className="pointer-events-none absolute bottom-0 right-0 border-b border-r border-current"
        style={{ ...base, transformOrigin: 'bottom right' }}
      />
    </>
  );
}

/* ========================================================================== */
/* 光学折射亮边                                                                */
/* ========================================================================== */

/**
 * HoloRefractionEdges —— 上下沿 1px 线性渐变折射亮边。
 *
 * 【核心思路】真实玻璃的边缘不是"一条等亮的线"，而是：
 * 光从玻璃射向空气时在边缘发生折射，**中段最亮、两端因入射角变化而消失**。
 * 用 `transparent → 亮色 → transparent` 的渐变精确复现这个亮度包络。
 *
 * 【为何只做上下、不做左右】面板是宽扁的，上下沿是视觉主轴；
 * 四条边都做会让亮度包络在四角互相干扰，反而像一圈发光的框。
 * 只保留上下，四角由靶标接管——分工明确。
 *
 * @param accent 折射亮边色
 */
export function HoloRefractionEdges({ accent = '#22d3ee' }: { readonly accent?: string }): ReactNode {
  /* 中段用 65% 透明度（对应 Tailwind 的 /65），两端归零 */
  const edgeStyle: CSSProperties = {
    background: `linear-gradient(90deg, transparent 0%, ${accent}b3 50%, transparent 100%)`,
  };
  return (
    <>
      <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px" style={edgeStyle} />
      <span aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 h-px" style={edgeStyle} />
    </>
  );
}

/**
 * HoloSpecularSheen —— 斜向玻璃折射高光。
 *
 * 【为何用 135° 而非 90°】垂直高光看起来像"屏幕反光"；
 * 135° 斜向高光才是玻璃板被侧上方光源照到的物理表现，
 * 也是展陈级设备最常见的质感来源。
 *
 * 【为何透明度只有 0.06】高光是"你注意到它在，但不会盯着它看"的东西。
 * 超过 0.1 就会盖住文字，把一个克制的高级细节变成廉价的光泽滥用。
 */
export function HoloSpecularSheen(): ReactNode {
  return (
    <span
      aria-hidden
      className="pointer-events-none absolute inset-0 opacity-[0.06]"
      style={{
        background:
          'linear-gradient(135deg, rgba(255,255,255,0.9) 0%, rgba(165,243,252,0.35) 28%, transparent 52%, transparent 100%)',
      }}
    />
  );
}

/**
 * HoloScanlines —— 极细横向扫描线底纹。
 *
 * 【本轮下调不透明度 0.045 → 0.03】光学玻璃拟态要求"通透"，
 * 扫描线太重会让面板重新变回"一块有纹理的黑板"。
 * 0.03 只在近景可见，中远景自然消失，符合"展厅设备"而非"老式 CRT"。
 */
export function HoloScanlines(): ReactNode {
  return (
    <span
      aria-hidden
      className="pointer-events-none absolute inset-0 opacity-[0.03]"
      style={{
        backgroundImage:
          'repeating-linear-gradient(0deg, rgba(226,232,240,0.9) 0px, rgba(226,232,240,0.9) 1px, transparent 1px, transparent 3px)',
      }}
    />
  );
}

/* ========================================================================== */
/* 毫米级精密微标尺（Micro Ruler）                                              */
/* ========================================================================== */

/** 标尺默认刻度数（24 格在铭牌宽度下疏密合适） */
const RULER_TICK_COUNT = 24;

/**
 * HoloMicroRuler —— 毫米级精密光学微标尺。
 *
 * 【为什么这把"尺子"能显著提升高级感】
 * 人类对"精密"的感知几乎完全来自**参照物**。同样的数值，孤零零地
 * 摆在那里只是"数据"；后面跟着一把长短交替的刻度尺，观感立刻变成
 * "被仪器测量出来的数据"。展陈级设备的 HUD 大量使用这个手法。
 *
 * 【三个构成要素与各自作用】
 * 1. **长短交替刻度**：每 5 格一根长刻度（5px），其余短刻度（2.5px）。
 *    这是真实钢尺的"毫米 / 厘米"区分方式，读者无需解释就能理解。
 * 2. **微型游标三角**：一个朝下的小三角标在固定位置，暗示"读数在此刻锁定"。
 *    没有它，刻度只是装饰；有了它，刻度变成"有读数的仪表"。
 * 3. **等宽遥测编号**：`SYS // TELEMETRY` 这类全大写等宽小字，
 *    提供"系统代号"的语义层，且 `tracking-[0.18em]` 的字距让它读起来
 *    像刻在金属上的铭文而非屏幕上的正文。
 *
 * @param label     遥测编号文案（默认 `SYS // TELEMETRY`）
 * @param accent    刻度与游标色
 * @param tickCount 刻度数量
 * @param cursorAt  游标位置比例 [0,1]，默认 0.5（居中）
 */
export function HoloMicroRuler({
  label = 'SYS // TELEMETRY',
  accent = '#22d3ee',
  tickCount = RULER_TICK_COUNT,
  cursorAt = 0.5,
  className,
}: {
  readonly label?: string;
  readonly accent?: string;
  readonly tickCount?: number;
  readonly cursorAt?: number;
  readonly className?: string;
}): ReactNode {
  const safeCount = Math.max(4, Math.min(64, Math.floor(tickCount)));
  const safeCursor = Math.min(1, Math.max(0, cursorAt));
  return (
    <div className={cn('pointer-events-none flex items-center gap-1.5', className)} aria-hidden>
      {/* ---- 等宽遥测编号 ---- */}
      <span
        className="shrink-0 font-mono text-[7px] uppercase leading-none tracking-[0.18em]"
        style={{ color: `${accent}99` }}
      >
        {label}
      </span>

      {/* ---- 刻度带（短长交替） ---- */}
      <span className="relative flex min-w-0 flex-1 items-end gap-[2px]">
        {Array.from({ length: safeCount }, (_, i): ReactNode => {
          const isMajor = i % 5 === 0;
          return (
            <span
              key={`ruler-tick-${i}`}
              className="block w-px"
              style={{
                height: isMajor ? 5 : 2.5,
                backgroundColor: isMajor ? accent : `${accent}66`,
              }}
            />
          );
        })}

        {/* ---- 微型游标三角：标记"当前读数位置" ---- */}
        <span
          className="absolute -top-[3px]"
          style={{ left: `calc(${safeCursor * 100}% - 3px)` }}
        >
          <span
            aria-hidden
            className="block h-0 w-0 border-x-[3px] border-t-[4px] border-x-transparent"
            style={{ borderTopColor: accent, filter: `drop-shadow(0 0 2px ${accent})` }}
          />
        </span>
      </span>
    </div>
  );
}

/* ========================================================================== */
/* 空间引线（Leader Line）                                                      */
/* ========================================================================== */

/** 引线折角段长度与水平段长度（px） */
const LEADER_ELBOW_PX = 9;
const LEADER_RUN_PX = 22;

/**
 * HoloLeaderLine —— 双环准星锚点 + 45° 折角极细激光引线 + 末端微脉冲锁定点。
 *
 * 【它解决什么问题】悬浮 HUD 与 3D 物体之间如果没有任何连线，
 * 读者需要靠位置推测"这块面板在说哪个对象"。空间引线把这个关系
 * **显式画出**——这是展陈级数字孪生与被投影的仪表盘之间最大的差别。
 *
 * 【三个构成要素】
 * 1. **双环准星锚点**：外环 + 内实心点。双环是关键——单环只是"一个圆圈"，
 *    双环立刻读作"光学准星 / 瞄准标定"。
 * 2. **45° 折角极细激光引线**：先斜 45° 再水平延伸。
 *    纯直线是最省事的画法，但 45° 折角是工程制图与航空 HUD 的惯例语言，
 *    且折角让引线避开面板主体，不会从文字中间穿过。
 * 3. **末端微脉冲锁定点**：一个带呼吸动画的小圆点，暗示"链路已锁定"。
 *
 * 【实现】内联 SVG：1px 描边、`stroke-linecap="square"`。
 * 用 SVG 而非 CSS 伪元素，是因为 45° 折角用 CSS 需要 rotate + transform-origin
 * 精确调参，而 SVG polyline 一行点坐标就能表达，且缩放不失真。
 *
 * @param accent   引线与锚点色
 * @param flip     是否水平翻转（面板在物体左侧时用）
 * @param className 额外类名
 */
export function HoloLeaderLine({
  accent = '#22d3ee',
  flip = false,
  className,
}: {
  readonly accent?: string;
  readonly flip?: boolean;
  readonly className?: string;
}): ReactNode {
  const width = LEADER_ELBOW_PX + LEADER_RUN_PX;
  const height = LEADER_ELBOW_PX + 8;
  return (
    <span
      aria-hidden
      className={cn('pointer-events-none relative block', flip && 'scale-x-[-1]', className)}
      style={{ width, height }}
    >
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        aria-hidden
      >
        {/*
         * 45° 折角引线：从右上角锚点出发，先斜向左下 45°，
         * 再水平向左延伸。polyline 三点即可表达，1px 描边保持"极细激光"。
         */}
        <polyline
          points={`${width},0 ${LEADER_RUN_PX},${LEADER_ELBOW_PX} 0,${LEADER_ELBOW_PX}`}
          stroke={accent}
          strokeWidth={1}
          strokeLinecap="square"
          opacity={0.75}
        />
        {/* 双环准星：外环 */}
        <circle cx={width - 1} cy={1} r={4} stroke={accent} strokeWidth={1} opacity={0.9} />
        {/* 双环准星：内实心点 */}
        <circle cx={width - 1} cy={1} r={1.4} fill={accent} />
        {/* 末端微脉冲锁定点 */}
        <circle cx={1} cy={LEADER_ELBOW_PX} r={1.6} fill={accent} opacity={0.9}>
          <animate attributeName="opacity" values="0.25;1;0.25" dur="1.8s" repeatCount="indefinite" />
        </circle>
      </svg>
    </span>
  );
}

/* ========================================================================== */
/* 微型发光进度条（分段 + 游标）                                                 */
/* ========================================================================== */

/** 进度槽宽度与高度（px）：56×3.5 比上一版略加宽，为分段刻度留出空间 */
const BAR_WIDTH_PX = 56;
const BAR_HEIGHT_PX = 3.5;

/** 进度条分段数：每 1/12 一道分隔刻线 */
const BAR_SEGMENTS = 12;

/**
 * 按数值取状态色（与全局告警阈值同源）。
 *
 * @param value 使用率百分比 [0,100]
 * @returns 现值对应的高亮色
 */
function resolveTone(value: number): string {
  if (value >= 85) return '#f43f5e';
  if (value >= 70) return '#fbbf24';
  return '#10b981';
}

/**
 * MiniBar —— 「标签 + 等宽数值 + 分段微米级发光进度条」三件套。
 *
 * 【本轮三处升级】
 * 1. **分段刻线**：填充条上方叠 12 道细分隔线，把它从"一根色条"
 *    变成"12 格刻度仪表"。分段让读者能读出"大约 7/12"，
 *    而连续色条只能读出"过半了"——这是精确感的来源。
 * 2. **发光游标**：在填充末端加一道 1px 竖线 + 外发光。
 *    游标是"指针"，它把静态的条变成"此刻读数"。
 * 3. **数值严格等宽**：`font-mono tabular-nums` 双保险——
 *    `tabular-nums` 保证数字宽度恒定（12% → 100% 不跳动），
 *    `font-mono` 保证小数点与百分号也对齐。
 */
export function MiniBar({
  label,
  value,
  tone,
}: {
  readonly label: string;
  readonly value: number;
  /** 覆盖默认阈值取色（例如 MEM 恒为青蓝） */
  readonly tone?: string;
}): ReactNode {
  const clamped = Math.min(100, Math.max(0, value));
  const color = tone ?? resolveTone(clamped);
  const fillStyle: CSSProperties = {
    width: `${clamped}%`,
    backgroundColor: color,
    boxShadow: `0 0 5px ${color}`,
  };
  return (
    <span className="flex items-center gap-1">
      <span className="font-mono text-[8px] uppercase tracking-[0.16em] text-slate-500">
        {label}
      </span>
      <span
        className="w-[24px] text-right font-mono text-[9.5px] font-semibold tabular-nums leading-none"
        style={{ color }}
      >
        {Math.round(clamped)}%
      </span>
      <span
        aria-hidden
        className="pointer-events-none relative overflow-hidden rounded-[1px] bg-white/[0.06]"
        style={{ width: BAR_WIDTH_PX, height: BAR_HEIGHT_PX }}
      >
        {/* 填充条 */}
        <span
          className="absolute inset-y-0 left-0 transition-[width] duration-300"
          style={fillStyle}
        />
        {/* 12 道分段刻线：用重复渐变画，比 12 个 DOM 节点便宜一个数量级 */}
        <span
          className="absolute inset-0"
          style={{
            backgroundImage: `repeating-linear-gradient(90deg, transparent 0px, transparent ${
              BAR_WIDTH_PX / BAR_SEGMENTS - 1
            }px, rgba(2,8,21,0.85) ${BAR_WIDTH_PX / BAR_SEGMENTS - 1}px, rgba(2,8,21,0.85) ${
              BAR_WIDTH_PX / BAR_SEGMENTS
            }px)`,
          }}
        />
        {/* 发光游标：填充末端的 1px 竖线 */}
        <span
          className="absolute -top-px bottom-[-1px] w-px transition-[left] duration-300"
          style={{
            left: `calc(${clamped}% - 0.5px)`,
            backgroundColor: color,
            boxShadow: `0 0 4px ${color}, 0 0 8px ${color}80`,
          }}
        />
      </span>
    </span>
  );
}

/* ========================================================================== */
/* 铭牌外壳（光学玻璃）                                                        */
/* ========================================================================== */

/**
 * HoloFrame —— 光学玻璃拟态铭牌外壳。
 *
 * 【本轮重构：废除闭合边框】
 * 上一版用 `bg-slate-950/85` 深底 + 4px 折角，观感是"贴在场景上的黑牌"。
 * 本版改为：
 *   · 基底 `bg-slate-950/50 backdrop-blur-xl` —— 半通透光学玻璃，
 *     背后的 3D 场景仍隐约可见，面板"嵌在场景里"而非盖在场景上；
 *   · **没有任何一条闭合边**，结构完全由上下 1px 折射亮边 + 四角靶标表达；
 *   · 叠一层斜向折射高光，这是"玻璃"与"塑料"的分界；
 *   · 可选顶部微标尺，把面板从"信息卡片"变成"测量仪表"。
 *
 * 【为何 backdrop-blur-xl 而不是 md】xl（24px）的模糊半径让背后的
 * 高对比几何（机架棱线）彻底糊成色块，文字可读性才有保障；
 * md（12px）下机架的锐利棱线会透出来干扰读数。
 *
 * @param accent     主题色（决定靶标、折射亮边、标尺颜色）
 * @param glow       是否叠加外发光（机架铭牌用 true）
 * @param rulerLabel 传入则在顶部渲染微标尺（省略则不渲染，避免空行）
 * @param className  额外类名
 */
export function HoloFrame({
  children,
  accent = '#22d3ee',
  glow = false,
  rulerLabel,
  className,
}: {
  readonly children: ReactNode;
  readonly accent?: string;
  readonly glow?: boolean;
  /** 传入非空字符串则在顶部渲染 `HoloMicroRuler` */
  readonly rulerLabel?: string;
  readonly className?: string;
}): ReactNode {
  return (
    <div
      className={cn(
        'pointer-events-none relative overflow-hidden px-2 py-1',
        /* 光学玻璃基底：半通透 + 强模糊，无边框/无圆角闭合 */
        'bg-slate-950/50 backdrop-blur-xl',
        className,
      )}
      style={glow ? { boxShadow: `0 0 12px ${accent}2e, inset 0 0 18px ${accent}14` } : undefined}
    >
      <HoloScanlines />
      <HoloSpecularSheen />
      <HoloRefractionEdges accent={accent} />
      <HoloCorners color={accent} />

      <div className="relative">
        {rulerLabel !== undefined && rulerLabel.length > 0 ? (
          <HoloMicroRuler label={rulerLabel} accent={accent} className="mb-0.5" />
        ) : null}
        {children}
      </div>
    </div>
  );
}
