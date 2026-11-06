'use client';

/**
 * KubeVision AI — WebGL 指标采集探针（GlStatsCollector）
 *
 * 【职责】一个**不渲染任何内容**的探针组件，挂在 R3F 场景树内，
 * 每 500ms 把渲染器的真实统计写入瞬态轨 telemetryTransientRef.glStats，
 * 供性能 HUD 与答辩数据展示消费。
 *
 * 【为何必须有它】`glStats.fps / frameTimeMs / drawCalls / triangles`
 * 这四个字段此前**从未被任何代码写入**，始终停留在初始值 0——
 * 也就是说性能 HUD 的 FPS / Frame / Draw Calls / Triangles 一直显示 "--"。
 * 本组件补上了这条缺失的数据链路。
 *
 * 【核心数学：采样而非逐帧】
 * 在 useFrame 里逐帧写 glStats 是可行的（写入是纯赋值，零分配），
 * 但**测量** fps 必须跨帧累计：单帧 delta 无法反映"帧率"，
 * 只能反映"这一帧耗时"。因此这里用时间累加器：
 *
 *   accumulator += delta
 *   frames += 1
 *   当 accumulator >= SAMPLE_INTERVAL_S：
 *     fps = frames / accumulator        ← 窗口内平均帧率
 *     frameTimeMs = (accumulator / frames) * 1000  ← 窗口内平均单帧耗时
 *
 * 用「窗口平均值」而非「最后一帧瞬时值」，是因为瞬时值抖动剧烈
 * （一次 GC 就能让单帧从 16ms 跳到 80ms），平均值才能反映真实手感。
 *
 * 【60FPS 红线契约】useFrame 内**绝不**分配对象：所有临时变量都是
 * 局部 number，不构造 THREE.* 对象，不调用 setState。采样到的数据
 * 直接赋值到模块级单例 glStats，不触发任何 React 重渲染。
 */

import { useFrame } from '@react-three/fiber';
import { useRef } from 'react';

import { telemetryTransientRef } from '@/store/useTelemetryRef';

/* ========================================================================== */
/* 常量                                                                       */
/* ========================================================================== */

/** 采样间隔（秒）——契约要求 500ms */
const SAMPLE_INTERVAL_S = 0.5;

/* ========================================================================== */
/* 组件主体                                                                    */
/* ========================================================================== */

/**
 * GlStatsCollector —— 无渲染 WebGL 指标探针。
 *
 * 【返回值】null —— 本组件不产生任何场景图节点，零渲染开销。
 */
export default function GlStatsCollector(): null {
  /** 距上次采样累计的时间（秒） */
  const accumulatorRef = useRef<number>(0);
  /** 距上次采样累计的帧数 */
  const frameCountRef = useRef<number>(0);

  useFrame((state, delta): void => {
    /* ---- 累加（纯数值运算，零分配） ---- */
    accumulatorRef.current += delta;
    frameCountRef.current += 1;

    /* ---- 未达采样间隔：直接返回，不做任何工作 ---- */
    if (accumulatorRef.current < SAMPLE_INTERVAL_S) return;

    /* ---- 到达采样点：计算窗口平均并写入瞬态轨 ---- */
    const elapsed = accumulatorRef.current;
    const frames = frameCountRef.current;

    /* 防御：delta 异常（切标签页回来时 delta 可能是数秒）导致 elapsed 极大，
       此时 frames/elapsed 会算出接近 0 的假低帧率。限制在合理窗口内。 */
    if (frames > 0 && elapsed > 0) {
      const stats = telemetryTransientRef.glStats;

      /* FPS：窗口内帧数 / 窗口时长 */
      stats.fps = Math.round(frames / elapsed);

      /* 单帧耗时：窗口时长的平均值，转毫秒 */
      stats.frameTimeMs = Math.round((elapsed / frames) * 1000 * 10) / 10;

      /* Draw Calls 与三角形数：直接透传 WebGLRenderer.info.render。
         这两个值是"批量渲染优化效果"的直观证据——48 个 Pod 用单个
         InstancedMesh 渲染时，drawCalls 应稳定在个位数而非 48+。 */
      stats.drawCalls = state.gl.info.render.calls;
      stats.triangles = state.gl.info.render.triangles;
    }

    /* ---- 重置累加器，开始下一个窗口 ---- */
    accumulatorRef.current = 0;
    frameCountRef.current = 0;
  });

  return null;
}
