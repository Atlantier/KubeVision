'use client';

/**
 * KubeVision AI — 3D 后期处理异步管线（ClusterPostProcessing）
 *
 * 【设计意图】
 * 把体量较大的 `@react-three/postprocessing` + `postprocessing`（即线上曾因首屏并发
 * 触发 `ERR_CONNECTION_CLOSED` 的 934 分片）与 `ExposureDriver` 从 `ClusterCanvas`
 * 同步依赖树中抽离为独立的异步子模块：
 * 1. 核心 3D 拓扑场景优先零阻塞挂起渲染（先由 `NeutralToneMapping` 呈现准确色调）；
 * 2. 本模块错峰加载并经 `retryDynamicImport` 自动重拉分片；
 * 3. 挂载完成后经 `onActiveChange(true)` 通知外层把渲染器切为 `NoToneMapping`
 *    接管线性 HDR Bloom / 曝光 / Neutral 色调映射 / FXAA / 暗角；
 * 4. 即使极端弱网下加载失败，外层 `DynamicSlotBoundary(silent)` 静默兜底为 `null`，
 *    绝不影响整个 3D 拓扑或页面可用性。
 */

import { useEffect, useRef, type ReactElement } from 'react';
import { useFrame } from '@react-three/fiber';
import { HalfFloatType, Vector3 } from 'three';
import { Bloom, DepthOfField, EffectComposer, FXAA, Noise, ToneMapping, Vignette } from '@react-three/postprocessing';
import type { DepthOfFieldEffect } from 'postprocessing';
import { ToneMappingMode } from 'postprocessing';

import { ExposureDriver, ExposureEffect, type ExposureEffectHandle } from '@/components/canvas/ExposureDriver';
import { useClusterStore } from '@/store/useClusterStore';
import { MASTER_POSITION, getRackTransform } from '@/utils/spatialLayout';

export interface PostProcessingTierConfig {
  readonly dof: boolean;
  readonly fxaa: boolean;
  readonly multisampling: number;
  readonly bloomLevels: number;
  readonly bloomIntensity: number;
  readonly vignette: boolean;
}

interface ClusterPostProcessingProps {
  readonly composerKey: string;
  readonly tierEffects: PostProcessingTierConfig;
  readonly onActiveChange: (active: boolean) => void;
}

/**
 * DofFocusDriver —— T3 景深焦点阻尼跟随（R27 B3）。
 *
 * 焦点目标 = 相机到关注实体中心的距离；每 250ms 采样、每帧指数阻尼（k=5），
 * 所有三维向量在 ref 中预分配以避免 `useFrame` 内触发 GC。
 */
function DofFocusDriver({
  effectRef,
}: {
  readonly effectRef: React.MutableRefObject<DepthOfFieldEffect | null>;
}): null {
  const targetRef = useRef<number>(12);
  const currentRef = useRef<number>(12);
  const lastReadRef = useRef<number>(0);
  const centerRef = useRef(new Vector3(MASTER_POSITION[0], MASTER_POSITION[1], MASTER_POSITION[2]));

  useFrame(({ camera }, delta): void => {
    const now = performance.now();
    if (now - lastReadRef.current >= 250) {
      lastReadRef.current = now;
      const state = useClusterStore.getState();
      const selectedId = state.selectedEntityId;
      centerRef.current.set(MASTER_POSITION[0], MASTER_POSITION[1], MASTER_POSITION[2]);
      if (selectedId !== null) {
        const node = state.snapshotSummary.nodes.find((item): boolean => item.id === selectedId);
        const pod = state.snapshotSummary.pods.find((item): boolean => item.id === selectedId);
        const rackIndex =
          node?.rackIndex ??
          (pod === undefined
            ? undefined
            : state.snapshotSummary.nodes.find((item): boolean => item.id === pod.nodeId)?.rackIndex);
        if (rackIndex !== undefined) {
          const rack = getRackTransform(rackIndex);
          centerRef.current.set(rack.position[0], rack.position[1] + 1.2, rack.position[2]);
        }
      }
      targetRef.current = camera.position.distanceTo(centerRef.current);
    }
    const alpha = 1 - Math.exp(-5 * Math.min(delta, 0.1));
    currentRef.current += (targetRef.current - currentRef.current) * alpha;
    const effect = effectRef.current;
    if (effect !== null) {
      effect.circleOfConfusionMaterial.focusDistance = currentRef.current;
    }
  });
  return null;
}

export default function ClusterPostProcessing({
  composerKey,
  tierEffects,
  onActiveChange,
}: ClusterPostProcessingProps): ReactElement {
  const exposureEffectRef = useRef<ExposureEffectHandle | null>(null);
  const dofEffectRef = useRef<DepthOfFieldEffect | null>(null);

  useEffect((): (() => void) => {
    onActiveChange(true);
    return (): void => {
      onActiveChange(false);
    };
  }, [onActiveChange]);

  const postEffectChildren: ReactElement[] = [];
  if (tierEffects.dof) {
    postEffectChildren.push(
      <DepthOfField
        key="dof"
        ref={dofEffectRef}
        focusDistance={12}
        focalLength={0.02}
        focusRange={26}
        bokehScale={1.2}
      />,
    );
  }
  postEffectChildren.push(
    <Bloom
      key="bloom"
      intensity={tierEffects.bloomIntensity}
      luminanceThreshold={0.96}
      luminanceSmoothing={0.22}
      mipmapBlur
      radius={0.28}
      levels={tierEffects.bloomLevels}
    />,
    <ExposureEffect key="exposure" ref={exposureEffectRef} />,
    <ToneMapping key="tonemap" mode={ToneMappingMode.NEUTRAL} />,
  );
  if (tierEffects.fxaa) {
    postEffectChildren.push(<FXAA key="fxaa" />);
  }
  if (tierEffects.vignette) {
    postEffectChildren.push(<Vignette key="vignette" eskil={false} offset={0.3} darkness={0.12} />);
  }
  postEffectChildren.push(<Noise key="noise" opacity={0.012} />);

  return (
    <>
      <ExposureDriver effectRef={exposureEffectRef} />
      {tierEffects.dof ? <DofFocusDriver effectRef={dofEffectRef} /> : null}
      <EffectComposer
        key={composerKey}
        multisampling={tierEffects.multisampling}
        frameBufferType={HalfFloatType}
      >
        {postEffectChildren}
      </EffectComposer>
    </>
  );
}
