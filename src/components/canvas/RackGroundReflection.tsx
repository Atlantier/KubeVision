'use client';

/**
 * KubeVision AI — 机架底部近场"反射带"（R28 追问 3）
 *
 * 【解决什么】镜面地板（MeshReflectorMaterial）会重渲染整个场景，
 * 在低档位（T0/软渲染）必须关闭——关掉后机架像"浮"在暗面上，失去接地感。
 *
 * 【方案】不做真实反射 pass，而是在每座机架底部放一条 0.2 高的程序化渐变平面：
 * 底部接近机架状态色、向上快速衰减到透明，模拟"镜面把机架底部倒映出来"的
 * 近场错觉。3 个平面共享几何、各 1 次 draw call（合计 +3，占 412 的 0.7%），
 * **不增加任何离屏渲染**，因此低档位收益最高、代价最小。
 *
 * 【数学】alpha = (1 − smoothstep(0.0, 1.0, uv.y)) × 0.5 × 横向羽化；
 * edge0 < edge1 满足 R01；加色混合模拟反射光，不写深度、不参与拾取。
 */

import { useMemo } from 'react';
import * as THREE from 'three';
import { getRackTransform } from '@/utils/spatialLayout';
import { PALETTE } from '@/constants/palette';

/** 反射带宽度/高度（世界单位） */
const BAND_WIDTH = 1.15;
const BAND_HEIGHT = 0.2;
/** 距离机架中心向画面内侧的偏移（放在机架正前方地面上） */
const BAND_FORWARD_OFFSET = 0.62;
/** 反射带不透明度上限 */
const BAND_OPACITY = 0.5;

const VERTEX_SHADER = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const FRAGMENT_SHADER = /* glsl */ `
  uniform vec3 uColor;
  uniform float uOpacity;
  varying vec2 vUv;
  void main() {
    /* 底部（uv.y=0）最亮，向上淡出；两侧羽化避免硬边 */
    float vertical = 1.0 - smoothstep(0.0, 1.0, vUv.y);
    float side = smoothstep(0.0, 0.12, vUv.x) * (1.0 - smoothstep(0.88, 1.0, vUv.x));
    float alpha = vertical * side * uOpacity;
    if (alpha <= 0.002) discard;
    gl_FragColor = vec4(clamp(uColor, 0.0, 1.0), clamp(alpha, 0.0, 1.0));
  }
`;

/** RackGroundReflection —— 3 条机架底部近场反射带 */
export default function RackGroundReflection(): React.ReactElement {
  /** 三条反射带的世界位姿（静态拓扑，模块级一次计算） */
  const bands = useMemo(() => {
    const result: Array<{ position: [number, number, number]; rotationY: number }> = [];
    for (let rack = 0; rack < 3; rack += 1) {
      const transform = getRackTransform(rack);
      const x = transform.position[0];
      const z = transform.position[2];
      const len = Math.hypot(x, z);
      /* 朝画面中心方向偏移，保证反射带落在机架与中心之间 */
      const dx = -x / len;
      const dz = -z / len;
      result.push({
        position: [x + dx * BAND_FORWARD_OFFSET, BAND_HEIGHT / 2, z + dz * BAND_FORWARD_OFFSET],
        rotationY: Math.atan2(dx, dz),
      });
    }
    return result;
  }, []);

  const uniforms = useMemo(
    () => ({ uColor: { value: PALETTE.theme.color.clone() }, uOpacity: { value: BAND_OPACITY } }),
    [],
  );

  return (
    <group>
      {bands.map((band, index) => (
        <mesh
          key={`rack-ground-band-${index}`}
          position={band.position}
          rotation={[0, band.rotationY, 0]}
          raycast={(): void => undefined}
          renderOrder={1}
        >
          <planeGeometry args={[BAND_WIDTH, BAND_HEIGHT]} />
          <shaderMaterial
            uniforms={uniforms}
            vertexShader={VERTEX_SHADER}
            fragmentShader={FRAGMENT_SHADER}
            transparent
            depthWrite={false}
            side={THREE.DoubleSide}
            toneMapped={false}
            blending={THREE.AdditiveBlending}
          />
        </mesh>
      ))}
    </group>
  );
}