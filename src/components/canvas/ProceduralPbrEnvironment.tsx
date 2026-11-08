'use client';

/**
 * KubeVision AI — 程序化 PBR 环境反射（ProceduralPbrEnvironment）
 *
 * 【解决什么问题】场景里的机架立柱（meshStandardMaterial 枪灰金属）、
 * 刀片装甲、晶核切角都是 PBR 材质，但此前 `scene.environment` 为 null：
 * 金属没有环境可反射，只剩几盏平行光的直射高光，
 * 观感是"塑料涂了灰漆"而不是"冷金属"。
 *
 * 【为何不用 .hdr 贴图】
 * 一个 1k 的 HDRI 动辄 2~6MB，且必须外链 CDN 或放 public。
 * 本项目要求零外部资产、零额外网络请求——因此用 three 自带的
 * `RoomEnvironment`（一个纯程序化搭建的"摄影棚"：若干发光面板 + 墙体）
 * 作为环境源，离线生成环境贴图。
 *
 * 【管线】
 *   RoomEnvironment（程序化场景）
 *     → PMREMGenerator.fromScene(scene, 0.04)   // 预滤波为 mip 链
 *     → envMap（PMREM 纹理）
 *     → scene.environment = envMap              // 所有标准材质自动采样
 *
 * 【为何 0.04 的 sigma】PMREM 的第二个参数控制"粗糙度预滤波的模糊量"。
 * 0.04 是很小的值：保留环境面板的清晰轮廓，金属上才能看到
 * "干净的条状高光"而不是一团糊光。取 0.1 以上就会失去硬边反射的工业感。
 *
 * 【显存契约（AGENTS.md 无明确条目，但这属于必须自己兜住的资源泄漏点）】
 * PMREM 纹理与生成器都持有 GPU 资源，组件卸载时必须成对 dispose，
 * 否则热更新/切页会持续累积显存，最终上下文丢失（黑屏）。
 */

import { useEffect } from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';

/** PMREM 预滤波强度：越小越高频（保留面板锐利轮廓） */
const PMREM_SIGMA = 0.04;

/**
 * 环境反射强度。
 *
 * 【为何要显式设定】three 的 scene.environment 默认以 1.0 参与 IBL。
 * 在本场景的暗色基调里，1.0 会让金属发灰发亮（像被洗过）；
 * 0.55 保留冷金属的暗部层次，只在切角与立柱棱线上给出克制的镜面高光。
 */
const ENV_INTENSITY = 0.55;

/**
 * ProceduralPbrEnvironment —— 挂载即生成并注入环境贴图，卸载即释放。
 *
 * 渲染返回 null：它不产生任何绘制对象，只做一次性的资源装配。
 */
export default function ProceduralPbrEnvironment(): null {
  const gl = useThree((s): THREE.WebGLRenderer => s.gl);
  const scene = useThree((s): THREE.Scene => s.scene);

  useEffect((): (() => void) => {
    /*
     * RoomEnvironment 的构造在 r155+ 变了签名：旧版要传 renderer，
     * 新版无参。用无参构造以兼容当前锁定的 three 0.169。
     */
    const environmentScene = new RoomEnvironment();
    const pmrem = new THREE.PMREMGenerator(gl);

    /* 预滤波：把程序化环境烘成带 mip 链的 PMREM 纹理 */
    const envMap = pmrem.fromScene(environmentScene, PMREM_SIGMA).texture;

    scene.environment = envMap;
    /* 强度：见 ENV_INTENSITY 注释 */
    scene.environmentIntensity = ENV_INTENSITY;

    return (): void => {
      /* 顺序：先解绑，再释放纹理与生成器（避免材质持有已释放纹理） */
      scene.environment = null;
      envMap.dispose();
      pmrem.dispose();
      /*
       * RoomEnvironment 内部也是有几何/材质的真实场景，
       * 同样需要显式释放，否则每次热更新都会泄漏一份。
       */
      environmentScene.dispose();
    };
  }, [gl, scene]);

  return null;
}