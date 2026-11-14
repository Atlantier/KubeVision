'use client';

/**
 * KubeVision AI — 地面地平线渐隐（R25 · D 项）
 *
 * 【要解决什么】地面圆盘半径 32 时，远端边缘或网格在雾开始完全吞没之前
 * 仍可见，于是画面出现一条"地平线"——深空场景最忌讳的廉价感。
 *
 * 【方案选择：径向 alpha 渐隐，而不是改雾参数】
 * 改雾（13,34）会同时影响所有材质（包括晶体、机架、自定义 shader 的 uFogFar
 * =64 假设），必须重跑 verify 与 R10 的雾一致性；本轮采用**不改雾**的方案：
 * 在 r∈[13,22] 叠加一层与背景同色的径向渐隐，把地面边缘溶进背景。
 * 这样既让地平线消失，又保持雾参数 (15,64) 与既有验证基线完全不变。
 *
 * 【数学】alpha = smoothstep(13, 22, r)，r 为世界半径；
 * edge0 < edge1 满足 R01 的 smoothstep 规则。
 *
 * 【渲染层级契约】renderOrder = -2（低于所有前景半透明体 0 / 10~16，高于地面网格 -3）：
 * 地面渐隐盘为 NormalBlending + depthWrite=false，若 renderOrder ≥ 前景晶体（如旧值 1 > 0），
 * 远端地平线 r∈[13,22] 会在前景不写深度的透明晶体之后绘制，导致将 #020611 背景色盖在
 * 晶体腰部形成“背景截断晶体”的遮挡错误。设为 -2 后只渐隐地面层，绝不遮挡前景模型。
 */

import { useMemo } from 'react';
import * as THREE from 'three';

/** 渐隐完成半径（= 地面圆盘半径） */
const FADE_OUTER_RADIUS = 22;
/** 与背景/雾同色 */
const HORIZON_COLOR = '#020611';

/** 径向渐隐的顶点着色器：把世界半径传给片元 */
const VERTEX_SHADER = /* glsl */ `
  varying float vRadius;
  void main() {
    vRadius = length(position.xy);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

/** 径向渐隐的片元着色器 */
const FRAGMENT_SHADER = /* glsl */ `
  uniform vec3 uColor;
  varying float vRadius;
  void main() {
    /*
     * edge0 < edge1（R01 规则）；clamp 后 smoothstep 在 [0,1] 内单调。
     * 渐变从 13 开始、22 完全吞没：地面远端不再有可见亮度，
     * 与背景 #020611 无缝衔接。
     */
    float alpha = smoothstep(13.0, 22.0, vRadius);
    if (alpha <= 0.001) discard;
    gl_FragColor = vec4(clamp(uColor, 0.0, 1.0), clamp(alpha, 0.0, 1.0));
  }
`;

/** GroundHorizonFade —— 平铺于地面的径向渐隐圆面 */
export default function GroundHorizonFade(): React.ReactElement {
  const uniforms = useMemo(
    () => ({ uColor: { value: new THREE.Color(HORIZON_COLOR) } }),
    [],
  );
  return (
    <mesh
      rotation={[-Math.PI / 2, 0, 0]}
      position={[0, 0.0015, 0]}
      raycast={(): void => undefined}
      renderOrder={-2}
    >
      <circleGeometry args={[FADE_OUTER_RADIUS, 128]} />
      <shaderMaterial
        uniforms={uniforms}
        vertexShader={VERTEX_SHADER}
        fragmentShader={FRAGMENT_SHADER}
        transparent
        depthWrite={false}
        toneMapped={false}
      />
    </mesh>
  );
}