'use client';

/**
 * KubeVision AI 鈥?绋嬪簭鍖栧亣杈夊厜鍏夋檿锛圙lowHalo3D锛? *
 * 銆愯В鍐充粈涔堥棶棰樸€戝湪娌℃湁鍚庡鐞嗘硾鍏夛紙UnrealBloomPass锛夌殑鍓嶆彁涓嬶紝鍙戝厜浣撳湪
 * 灞忓箷涓婃槸"纭竟浜潡"鈥斺€斾寒浣嗕笉鍍?鍦ㄥ彂鍏?銆傜湡瀹炰笘鐣岄噷鐨勫己鍏夋簮浼氬湪鍛ㄥ洿
 * 绌烘皵/闀滃ご閲屼骇鐢熷厜婧㈠嚭锛岃繖涓煍鍜屽婧㈡墠鏄?鍙戝厜鎰?鐨勬潵婧愩€? * 鍥句簩閭ｇ"鐧界偨鏍稿績鍚戝鏅曟暎"鐨勬晥鏋滐紝闈犵殑灏辨槸杩欎竴灞傘€? *
 * 銆愪负浣曚笉鐢ㄥ悗澶勭悊銆慉GENTS.md 绗?9 鏉￠攣瀹氫緷璧栦笘浠ｇ煩闃点€傚紩鍏? * @react-three/postprocessing 浼氳繛甯?three/addons 涓?R3F 鐨勭増鏈崗鍟嗛闄╋紝
 * 鑰屽崟涓満鏅彧闇€瑕?*涓ゅ**杈夊厜鈥斺€斾负涓€涓偣鐗规晥瑁呮暣鏉″悗澶勭悊绠＄嚎涓嶅垝绠椼€? * 鑷畾涔変竴涓?AdditiveBlending 鐨勫緞鍚戞笎鍙橀潰鐗囧嵆鍙紝鎴愭湰鍑犱箮涓洪浂銆? *
 * 銆愭牳蹇冩暟瀛︼細寰勫悜鎸囨暟琛板噺銆? * 鐗囧厓鍒伴潰鐗囦腑蹇冪殑褰掍竴鍖栬窛绂?d 鈭?[0, 1]锛圲V 绌洪棿锛夛紝
 * 閫忔槑搴︽寜 `pow(max(0, 1 - d), falloff)` 琛板噺锛? * - d = 0 鈫?1.0锛堜腑蹇冩渶浜紝鍙犲湪鍙戝厜浣撲笂褰㈡垚鐧界偨鍐呮牳锛? * - d = 1 鈫?0.0锛堣竟缂樺畬鍏ㄩ€忔槑锛屾棤鍙鍦嗙洏杈圭晫锛? * falloff 鎺у埗"鏅曟暎鑼冨洿"锛氬€艰秺澶ц“鍑忚秺蹇€佸厜鏅曡秺绱э紱瓒婂皬瓒婂彂鏁ｃ€? *
 * 銆愪负浣曠敤 Billboard銆戦潰鐗囧繀椤诲缁堟瀵圭浉鏈猴紝鍚﹀垯浠庝晶闈㈢湅浼氬彉鎴愪竴鏉＄嚎銆? * drei 鐨?<Billboard> 姣忓抚鎶婄墿浣撴湞鍚戠浉鏈猴紝姝ｆ槸鎵€闇€銆? *
 * 銆愭覆鏌撳绾︼紙AGENTS.md 绗?3/7 鏉★級銆? * - AdditiveBlending锛氬厜鍙犲姞鑰岄潪閬尅锛岀鍚堢墿鐞嗗彂鍏夎涓猴紱
 * - depthWrite = false锛氫笉鍐欐繁搴︼紝閬垮厤閬尅鍏跺悗缁樺埗鐨勪笉閫忔槑鐗╀綋锛? * - toneMapped = false锛氱粫杩囪壊璋冩槧灏勶紝淇濊瘉浜儴涓嶈鍘嬫殫锛? * - useFrame 鍐?zero allocation锛氭墍鏈夌潃鑹插櫒 uniform 鍦?useMemo 涓寤恒€? */

import { useMemo, useRef } from 'react';
import { Billboard } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';

/* ========================================================================== */
/* 绫诲瀷濂戠害                                                                    */
/* ========================================================================== */

/** GlowHalo3D 鐨?Props */
export interface GlowHalo3DProps {
  /** 鍏夋檿棰滆壊锛圚EX 瀛楃涓叉垨 CSS 棰滆壊鍚嶏級 */
  readonly color: string;
  /** 闈㈢墖鍗婂緞锛堜笘鐣屽崟浣嶏級 */
  readonly scale: number;
  /** 涓績涓嶉€忔槑搴?0~1锛岄粯璁?0.85 */
  readonly opacity?: number;
  /** 琛板噺鎸囨暟锛岄粯璁?2.4锛堣秺澶ц秺绱э級 */
  readonly falloff?: number;
  /** 鏄惁鍛煎惛鑴夊姩锛堥粯璁?false锛屼粎鏍稿績鍏夋檿寮€鍚級 */
  readonly pulse?: boolean;
  /** 鑴夊姩鍛ㄦ湡锛堢锛夛紝榛樿 3.2 */
  readonly pulsePeriod?: number;
  /** 闄勫姞浣嶇疆鍋忕Щ */
  readonly position?: readonly [number, number, number];
}

/* ========================================================================== */
/* 鐫€鑹插櫒婧愮爜                                                                  */
/* ========================================================================== */

/** 椤剁偣鐫€鑹插櫒锛氫粎閫忎紶 UV锛圔illboard 宸茶礋璐ｆ湞鍚戯紝鏃犻渶棰濆鍙樻崲锛?*/
const VERTEX_SHADER = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

/**
 * 鐗囧厓鐫€鑹插櫒锛氬緞鍚戞寚鏁拌“鍑忋€? *
 * 銆愪负浣曠敤 pow 鑰岄潪绾挎€с€戠嚎鎬ф笎鍙樺湪涓浠嶅亸浜紝浼氳鍏夋檿鐪嬭捣鏉ュ儚"纾ㄧ爞鐜荤拑
 * 鍦嗙洏"锛涙寚鏁拌“鍑忓湪涓績蹇€熶笅闄嶃€佸熬閮ㄧ紦鎱㈡嫋鍑猴紝鏇存帴杩戠湡瀹炲厜鏁ｅ皠鐨勮鎰熴€? */
const FRAGMENT_SHADER = /* glsl */ `
  uniform vec3 uColor;
  uniform float uOpacity;
  uniform float uFalloff;
  varying vec2 vUv;

  void main() {
    /* 闈㈢墖涓績鍒板綋鍓嶇墖鍏冪殑璺濈锛屽綊涓€鍖栧埌 [0, 1]銆?       PlaneGeometry 鐨?uv 鍦ㄥ洓瑙掍负 (0,0)/(1,1)锛屾晠涔?2 鍑?1 寰楀埌 [-1,1] 鐨?       鏈夌鍙峰潗鏍囷紝鍏堕暱搴﹀湪鍦嗗唴 鈮?1銆佸洓瑙掍负 鈭?銆俢lamp 鍚庝腑蹇?0銆佽竟缂?1銆?*/
    vec2 centered = vUv * 2.0 - 1.0;
    float dist = clamp(length(centered), 0.0, 1.0);

    /* 寰勫悜琛板噺锛氫腑蹇?1 鈫?杈圭紭 0 */
    float alpha = pow(max(0.0, 1.0 - dist), uFalloff) * uOpacity;

    /* 棰勪箻 alpha 杈撳嚭锛圓dditiveBlending 涓?rgb 鐩存帴鐩稿姞锛宎lpha 浠呯敤浜庡彲瑙佹€э級 */
    gl_FragColor = vec4(uColor, alpha);
  }
`;

/* ========================================================================== */
/* 缁勪欢涓讳綋                                                                    */
/* ========================================================================== */

/**
 * GlowHalo3D 鈥斺€?鍙鐢ㄧ殑绋嬪簭鍖栬緣鍏夐潰鐗囥€? *
 * @param props 瑙?GlowHalo3DProps
 */
export default function GlowHalo3D({
  color,
  scale,
  opacity = 0.85,
  falloff = 2.4,
  pulse = false,
  pulsePeriod = 3.2,
  position,
}: GlowHalo3DProps): React.ReactElement {
  const materialRef = useRef<THREE.ShaderMaterial>(null);

  /**
   * uniform 瀵硅薄蹇呴』鐢?useMemo 绋冲畾寮曠敤銆?   * 鑻ユ瘡娆℃覆鏌撻兘鏂板缓 `{ uColor: {...} }`锛孯3F 浼氶噸寤烘潗璐ㄥ苟涓㈠け uniform 缁戝畾锛?   * 绋冲畾鍚?useFrame 鍐呯洿鎺ユ敼 .value 鍗冲彲锛堥浂 React 鍙備笌锛夈€?   */
  const uniforms = useMemo(
    (): Record<string, THREE.IUniform> => ({
      uColor: { value: new THREE.Color(color) },
      uOpacity: { value: opacity },
      uFalloff: { value: falloff },
    }),
    /* 棰滆壊/閫忔槑搴?琛板噺鍙樺寲鏃堕渶瑕侀噸绠楅鑹插璞?*/
    [color, opacity, falloff],
  );

  /* 鍛煎惛鑴夊姩锛氫粎淇敼 uniform锛屼笉瑙︾鍑犱綍浣擄紙闆跺垎閰嶏級 */
  useFrame((state): void => {
    if (!pulse) return;
    const mat = materialRef.current;
    if (mat === null) return;
    /* sin 鍦?[-1,1] 鈫?鏄犲皠鍒?[0.55, 1.0] 鐨勯€忔槑搴﹀尯闂达紝閬垮厤瀹屽叏鐔勭伃 */
    const t = state.clock.elapsedTime;
    const wave = Math.sin((t / pulsePeriod) * Math.PI * 2);
    mat.uniforms.uOpacity.value = opacity * (0.775 + wave * 0.225);
  });

  /**
   * 鍏夋檿涓嶅弬涓庡皠绾挎嬀鍙栵細瀹冩槸绾瑙夊厓绱狅紝鑻ュ悆鎸囬拡浜嬩欢浼氭尅浣忚儗鍚?   * Master / Pod 鐨勭偣鍑伙紙杩欐槸鍙戝厜闈㈢墖鏈€瀹规槗韪╃殑浜や簰鍧戯級銆?   */
  const noRaycast = (): void => undefined;

  return (
    <Billboard position={position !== undefined ? [position[0], position[1], position[2]] : [0, 0, 0]}>
      {/*
       * 缂╂斁鐩存帴浣滅敤鍦?mesh 涓婏細Billboard 姣忓抚鍙皟鏁存暣妫靛瓙鏍戠殑鏈濆悜鍥涘厓鏁帮紝
       * 涓嶈鐩?scale锛屽洜姝や袱鑰呬簰涓嶅共鎵般€傜敤 1脳1 鍩哄噯闈㈢墖 + scale 鐨勫ソ澶勬槸
       * 鐫€鑹插櫒閲岀殑 UV 璇箟鎭掑畾锛堝缁?[0,1]虏锛夛紝鎹换浣曞昂瀵搁兘涓嶉渶鏀?shader銆?       */}
      <mesh raycast={noRaycast} scale={scale}>
        <planeGeometry args={[1, 1]} />
        <shaderMaterial
          ref={materialRef}
          uniforms={uniforms}
          vertexShader={VERTEX_SHADER}
          fragmentShader={FRAGMENT_SHADER}
          transparent
          depthWrite={false}
          depthTest
          blending={THREE.AdditiveBlending}
          toneMapped={false}
          side={THREE.DoubleSide}
        />
      </mesh>
    </Billboard>
  );
}
