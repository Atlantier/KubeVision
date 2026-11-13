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

/**
 * 反射 pass 计量累加器（模块级单例，零分配）。
 * ClusterCanvas 的 gl.render 包裹器在反射 pass 后写入本帧增量；
 * 本探针每帧读取后清零。用对象而非 export let——跨模块可写。
 */
export const reflectionMeter = { calls: 0 };

/* ========================================================================== */
/* 组件主体                                                                    */
/* ========================================================================== */

/**
 * GlStatsCollector —— 无渲染 WebGL 指标探针。
 *
 * 【返回值】null —— 本组件不产生任何场景图节点，零渲染开销。
 * 【priority 0 + 挂载顺序】本组件在场景树中先于反射材质挂载，故同 priority 0 下
 * 先于反射 useFrame 运行；EffectComposer 为 priority 1 更晚。于是每帧先在干净基线上
 * reset 并读到上一完整帧累计值（R5 测量契约）。
 */
export default function GlStatsCollector(): null {
  /** 距上次采样累计的时间（秒） */
  const accumulatorRef = useRef<number>(0);
  /** 距上次采样累计的帧数 */
  const frameCountRef = useRef<number>(0);

  useFrame((state, delta): void => {
    const gl = state.gl;
    const stats = telemetryTransientRef.glStats;

    /* ---- 每帧：先读上一完整帧累计，再 reset（R5：autoReset 已在 onCreated 关闭）----
       total=整帧合计（主场景+反射+后处理）；reflection=反射 pass 增量（gl.render 包裹写入）；
       main=total-reflection。读到的恒为上一完整帧，对采样/HUD 无影响。 */
    const frameTotal = gl.info.render.calls;
    const frameReflection = reflectionMeter.calls;
    stats.drawCalls = frameTotal;
    stats.drawCallsReflection = frameReflection;
    stats.drawCallsMain = frameTotal > frameReflection ? frameTotal - frameReflection : 0;
    stats.triangles = gl.info.render.triangles;
    gl.info.reset();
    reflectionMeter.calls = 0;

    /* ---- fps/帧耗时：跨帧窗口平均（瞬时值抖动剧烈，平均才反映手感）---- */
    accumulatorRef.current += delta;
    frameCountRef.current += 1;
    if (accumulatorRef.current < SAMPLE_INTERVAL_S) return;

    const elapsed = accumulatorRef.current;
    const frames = frameCountRef.current;
    /* 防御：切标签页回来 delta 可能是数秒，避免算出接近 0 的假低帧率 */
    if (frames > 0 && elapsed > 0) {
      stats.fps = Math.round(frames / elapsed);
      stats.frameTimeMs = Math.round((elapsed / frames) * 1000 * 10) / 10;
    }
    accumulatorRef.current = 0;
    frameCountRef.current = 0;
  }, 0);

  return null;
}
