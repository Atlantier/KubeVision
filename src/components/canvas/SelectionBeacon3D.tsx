'use client';

/**
 * KubeVision AI 鈥?3D 閫変腑瀹炰綋绌洪棿閿佸畾鍏夌幆锛圫electionBeacon3D锛? *
 * 銆愯В鍐充粈涔堥棶棰樸€戝鏌ユ姤鍛?搂2.4 鎸囧嚭鐨勬牳蹇冪煭鏉匡細
 * 鐐瑰嚮 Worker 鏈烘灦鏃?WorkerRack3D 鏈夐潚鑹插懠鍚告弿杈逛笌搴曞骇鐜紝浣嗙偣鍑?*鍗曚釜 Pod**
 * 鎺ㄨ繎鐗瑰啓鍚庯紝PodInstancedMesh 鏍规湰涓嶈 selectedEntityId鈥斺€斿悓灞?4 涓浉閭绘Ы浣? * 鐨?Pod 鏂瑰潡鎸ゅ湪鐢婚潰涓績锛岀敤鎴峰畬鍏ㄥ垎涓嶆竻宸︿笂瑙掓帰閽堥潰鏉挎寚鐨勬槸鍝竴棰椼€? *
 * 銆愭柟妗堛€戞寕杞戒竴涓嫭绔嬬殑杞婚噺閿佸畾鏍囪锛? 涓嚎妗嗗寘鍥寸洅 + 1 涓棆杞埢搴︾幆锛夛紝
 * 璁㈤槄 selectedEntityId 瀹氫綅鍒板搴旀Ы浣嶅潗鏍囥€傝繖涓嶆槸銆岀粰 Pod 鍔犵壒鏁堛€嶏紝
 * 鑰屾槸**鍦ㄧ┖闂撮噷鐢讳竴涓噯鏄?*鈥斺€斾笌宸℃闈㈡澘褰㈡垚銆屾暟鎹?鈫?绌洪棿銆嶇殑闂幆鎸囪銆? *
 * 銆愭€ц兘濂戠害锛圓GENTS.md 绗?3 鏉★級銆? * - useFrame 鍐呴浂 useState銆侀浂 React 鏇存柊锛? * - 鎵€鏈?THREE 瀵硅薄鍦?useMemo 涓鍒嗛厤锛寀seFrame 鍙仛鍘熷湴 .set() / 璧嬪€硷紱
 * - 鍛煎惛涓庤嚜杞敱 useFrame 鐩存帴鍐?ref.current.rotation / scale锛? *   涓嶈Е鍙戜换浣曠粍浠堕噸娓叉煋銆? */

import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';

import { useClusterStore } from '@/store/useClusterStore';
import { POD_BOX_SIZE, POD_SEAT_OFFSET_Y, getPodWorldTransform } from '@/utils/spatialLayout';
import type { PodEntity } from '@/types/cluster';
import type { SelectedEntityType } from '@/types/store';

/* ========================================================================== */
/* 甯搁噺                                                                       */
/* ========================================================================== */

/** 閿佸畾鐜崐寰勶紙鐣ュぇ浜?Pod 鐩掑瓙锛屽舰鎴愬寘鍥存劅锛?*/
const RING_RADIUS = 0.34;

/** 閿佸畾鐜嚎妗嗙粏鍒嗭紙8 杈瑰舰鍦ㄩ€忚涓嬫棦鏈夌鎶€鎰熷張鐪佷笁瑙掑舰锛?*/
const RING_SEGMENTS = 8;

/** 鍛煎惛鍛ㄦ湡锛堢锛夆€斺€斾笌鏈烘灦閫変腑鎬佺殑鍛煎惛鑺傚淇濇寔涓€鑷?*/
const BREATH_PERIOD_S = 1.6;

/** 鍛煎惛缂╂斁骞呭害锛埪?%锛屽厠鍒朵笉鍠у澶轰富锛?*/
const BREATH_AMPLITUDE = 0.08;

/** 鑷浆閫熷害锛堝姬搴?绉掞級鈥斺€旂紦鎱㈡壂杩囷紝鏆楃ず"姝ｅ湪閿佸畾" */
const SPIN_SPEED = 0.9;

/** 椤堕儴绔栫嚎楂樺害锛堜粠 Pod 椤堕儴鍚戜笂寤朵几鐨勬寚绀烘潌锛?*/
const BEAM_HEIGHT = 0.34;

/** 閿佸畾涓昏壊锛堜富棰橀潚锛屼笌鍏ㄥ眬閫変腑鎬佽涔変竴鑷达級 */
const BEACON_COLOR = '#22d3ee';

/* ========================================================================== */
/* 缁勪欢涓讳綋                                                                    */
/* ========================================================================== */

/**
 * SelectionBeacon3D 鈥斺€?閫変腑 Pod 鐨勭┖闂撮攣瀹氬厜鐜€? *
 * 銆愪负浣曞彧澶勭悊 Pod銆戞満鏋朵笌 Master 宸叉湁鑷繁鐨勯€変腑瑙嗚锛圵orkerRack3D 鐨? * 鎻忚竟 + 搴曞骇鐜€丮asterNode3D 鐨?emphasized 鐘舵€侊級锛岄噸澶嶅彔鍔犲弽鑰屾潅涔便€? * 鏈粍浠朵笓闂ㄨˉ Pod 杩欎竴灞傜殑缂哄け銆? *
 * 銆愭覆鏌撴潯浠躲€戜粎褰?selectedEntityType === 'pod' 涓旇兘鍦ㄥ揩鐓т腑鎵惧埌璇?Pod 鏃舵覆鏌撱€? */
export default function SelectionBeacon3D(): React.ReactElement | null {
  const selectedEntityId = useClusterStore((s): string | null => s.selectedEntityId);
  const selectedEntityType = useClusterStore((s): SelectedEntityType | null => s.selectedEntityType);
  const pods = useClusterStore((s): readonly PodEntity[] => s.snapshotSummary.pods);

  /**
   * 銆愬畾浣嶇洰鏍?Pod 骞惰В绠楀叾妲戒綅涓栫晫鍧愭爣銆?   *
   * 銆愬叧閿細蹇呴』鍙犲姞 POD_SEAT_OFFSET_Y銆戞鍓嶇洿鎺ョ敤 transform.position 浣滀负
   * 淇℃爣涓績锛屾紡鎺変簡娓叉煋鍣ㄤ负銆岃鏂瑰潡搴曢潰璐村悎闅旀澘銆嶈€屾柦鍔犵殑涓嬫矇鍋忕Щ
   * 锛圥OD_SEAT_OFFSET_Y = 鍙鐩掗珮/2 鈭?濂戠害鐩掗珮/2锛屽綋鍓嶄负 鈭?.18锛夈€?   * 缁撴灉鏄€変腑 Pod 鏃跺懠鍚哥嚎妗嗘偓鍦ㄦ柟鍧楁涓婃柟绾?0.18 涓栫晫鍗曚綅澶勶紝
   * 鑲夌溂鍙鐨勯敊浣嶁€斺€斿疄娴嬬‘璁ゅ悗淇銆?   *
   * 渚濊禆鍙斁 selectedEntityId / selectedEntityType / pods 涓夎€咃紝
   * 閬垮厤閬ユ祴楂橀瀛楁锛坈pu/mem锛夊彉鍖栬Е鍙戦噸绠椼€?   */
  const anchor = useMemo((): { position: [number, number, number]; rotationY: number } | null => {
    if (selectedEntityType !== 'pod' || selectedEntityId === null) return null;
    const pod = pods.find((p): boolean => p.id === selectedEntityId);
    if (pod === undefined) return null;

    const transform = getPodWorldTransform(pod.rackIndex, pod.slotIndex);
    return {
      position: [
        transform.position[0],
        transform.position[1] + POD_SEAT_OFFSET_Y,
        transform.position[2],
      ],
      rotationY: transform.rotationY,
    };
  }, [selectedEntityType, selectedEntityId, pods]);

  /* ---- 棰勫垎閰嶅姩鐢诲璞″紩鐢?---- */
  const groupRef = useRef<THREE.Group>(null);
  const ringRef = useRef<THREE.Mesh>(null);
  const boxRef = useRef<THREE.LineSegments>(null);

  /**
   * 銆愪慨澶嶏細鍑犱綍浣撳唴瀛樻硠婕忋€?   *
   * 姝ゅ墠鍐欎綔 `<edgesGeometry args={[new THREE.BoxGeometry(0.42, 0.5, 0.42)]} />`
   * 鈥斺€?`new THREE.BoxGeometry(...)` 浣嶄簬 JSX 娓叉煋浣撳唴锛屾瘡娆￠噸娓叉煋閮戒細
   * 鍦ㄥ爢涓婂垱寤轰竴涓柊鐨?BoxGeometry锛屼笖鍏?.dispose() 浠庢湭琚皟鐢ㄣ€?   *
   * 鏈粍浠惰闃?snapshotSummary.pods锛?Hz 蹇収娴侊級锛屽洜姝?*姣忕娉勬紡涓€涓?   * BoxGeometry**鈥斺€旈暱鏃堕棿杩愯浼氭寔缁疮绉?GPU 缂撳啿锛岃繚鍙?AGENTS.md 绗?3 鏉°€?   *
   * 淇锛氬湪 useMemo 涓竴娆℃€у垱寤猴紙绌轰緷璧?鈫?缁勪欢鐢熷懡鍛ㄦ湡鍐呬粎涓€浠斤級锛?   * 骞跺湪鍗歌浇鏃舵樉寮?dispose锛圔oxGeometry 涓庣敱鍏舵淳鐢熺殑 EdgesGeometry 閮借锛夈€?   * 灏哄璺熼殢 POD_BOX_SIZE 澶栨墿 0.08锛岃鍖呭洿妗嗘伆濂藉寘浣忔柊灏哄鐨勬柟鍧椼€?   */
  const { boxGeometry, edgesGeometry } = useMemo((): {
    boxGeometry: THREE.BoxGeometry;
    edgesGeometry: THREE.EdgesGeometry;
  } => {
    const pad = 0.08;
    const box = new THREE.BoxGeometry(
      POD_BOX_SIZE[0] + pad,
      POD_BOX_SIZE[1] + pad,
      POD_BOX_SIZE[2] + pad,
    );
    return { boxGeometry: box, edgesGeometry: new THREE.EdgesGeometry(box) };
  }, []);

  /* 鍗歌浇鏃堕噴鏀?GPU 璧勬簮锛圗dgesGeometry 涓庢簮 BoxGeometry 鍚勮嚜鎸佹湁缂撳啿锛?*/
  useEffect((): (() => void) => {
    return (): void => {
      edgesGeometry.dispose();
      boxGeometry.dispose();
    };
  }, [boxGeometry, edgesGeometry]);

  useFrame((state): void => {
    if (anchor === null) return;

    /* 鐢ㄥ満鏅椂閽熼┍鍔ㄥ姩鐢伙細鍗曚竴鏃堕棿婧愶紝鏍囩椤靛垏鍥炴椂涓嶄細绱Н璺冲彉 */
    const t = state.clock.elapsedTime;

    /* ---- 鍛煎惛缂╂斁锛歴in 娉㈠湪 1卤AMPLITUDE 涔嬮棿寰€澶?---- */
    const group = groupRef.current;
    if (group !== null) {
      const breath = 1 + Math.sin((t / BREATH_PERIOD_S) * Math.PI * 2) * BREATH_AMPLITUDE;
      group.scale.setScalar(breath);
    }

    /* ---- 鍒诲害鐜嚜杞紙浠呮敼 rotation.y锛岄浂鍒嗛厤锛?---- */
    const ring = ringRef.current;
    if (ring !== null) {
      ring.rotation.z = t * SPIN_SPEED;
    }

    /* ---- 绾挎鍖呭洿鐩掑仛杞诲井鍙嶅悜鑷浆锛屽埗閫?閿佸畾鎵弿"灞傛鎰?---- */
    const box = boxRef.current;
    if (box !== null) {
      box.rotation.y = -t * SPIN_SPEED * 0.5;
    }
  });

  /* 鏃?Pod 閫変腑 鈫?涓嶆覆鏌撲换浣曞満鏅妭鐐癸紙闆跺紑閿€锛?*/
  if (anchor === null) return null;

  return (
    <group
      ref={groupRef}
      position={anchor.position}
      rotation={[0, anchor.rotationY, 0]}
      /* 閿佸畾鏍囪涓嶅弬涓庡皠绾挎嬀鍙栵紝閬垮厤閬尅鐪熷疄鐨?Pod 鐐瑰嚮 */
      raycast={(): void => undefined}
    >
      {/*
       * 鍒诲害鐜細韬哄钩鍦?Pod 搴曢儴锛堢粫 X 杞?-90掳 骞抽摵 XZ 骞抽潰锛夛紝
       * 鐢?8 杈瑰舰绾挎 + 绋€鐤忓埢搴︽劅琛ㄨ揪"鎵弿閿佸畾"銆?       */}
      <mesh ref={ringRef} rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.46, 0]} raycast={(): void => undefined}>
        <ringGeometry args={[RING_RADIUS - 0.02, RING_RADIUS, RING_SEGMENTS]} />
        <meshBasicMaterial
          color={BEACON_COLOR}
          transparent
          opacity={0.85}
          side={THREE.DoubleSide}
          toneMapped={false}
          depthWrite={false}
        />
      </mesh>

      {/* 鍐呭湀锛氭洿灏忔洿娣★紝褰㈡垚鍙岀幆灞傛 */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.46, 0]} raycast={(): void => undefined}>
        <ringGeometry args={[RING_RADIUS * 0.55, RING_RADIUS * 0.62, RING_SEGMENTS]} />
        <meshBasicMaterial
          color={BEACON_COLOR}
          transparent
          opacity={0.5}
          side={THREE.DoubleSide}
          toneMapped={false}
          depthWrite={false}
        />
      </mesh>

      {/*
       * 绾挎鍖呭洿鐩掞細EdgesGeometry 鍙繚鐣?12 鏉℃１锛屾瘮瀹炰綋鍗婇€忔槑鍖呭洿鐩掓洿
       * "浠〃鍖?锛屼笖涓夎褰㈡暟涓綅鏁般€傚嚑浣曚綋宸蹭笂鎻愬埌 useMemo 骞堕厤 dispose锛?       * 涓嶅啀闅忔瘡绉掑揩鐓ч噸娓叉煋娉勬紡銆?       */}
      <lineSegments ref={boxRef} geometry={edgesGeometry} raycast={(): void => undefined}>
        <lineBasicMaterial color={BEACON_COLOR} transparent opacity={0.75} toneMapped={false} />
      </lineSegments>

      {/*
       * 椤堕儴鎸囩ず鏉嗭細浠庢櫠浣撻《闈㈠悜涓婄殑鐭粏鏉嗭紝鍦ㄤ刊瑙嗚涓嬪府鍔╁畾浣嶃€?       *
       * 銆愬昂瀵搁殢鏅跺潡閲嶆爣瀹氥€戝師涓?y=0.5 / 楂?0.42锛堥《绔埌 0.71锛夛紝
       * 閭ｆ槸鎸?0.38 楂樼殑鏃ф柟鍧楄璁＄殑锛涙湰杞柟鍧楅珮 0.56 鍚庯紝
       * 鎸囩ず鏉嗙浉瀵逛綋閲忔樉寰楄繃闀跨獊鍏€锛堢壒鍐欐埅鍥惧疄娴嬶級銆傜幇鏀逛负浠庢櫠浣撻《闈?       * (0.56/2 = 0.28) 鍐嶅悜涓?0.34锛岄《绔?0.45锛屾伆濂芥帰鍑烘柟鍧椾竴涓ご銆?       */}
      <mesh position={[0, POD_BOX_SIZE[1] / 2 + BEAM_HEIGHT / 2, 0]} raycast={(): void => undefined}>
        <boxGeometry args={[0.012, BEAM_HEIGHT, 0.012]} />
        <meshBasicMaterial color={BEACON_COLOR} transparent opacity={0.6} toneMapped={false} />
      </mesh>
    </group>
  );
}
