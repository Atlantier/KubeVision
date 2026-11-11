'use client';

/**
 * KubeVision AI — 程序化 PBR 环境反射与工业金属纹理（ProceduralPbrEnvironment）
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
 * 作为**基底**，再叠加自定义的工业灯带几何，离线生成环境贴图。
 *
 * 【本轮升级：高锐度工业灯带】
 * RoomEnvironment 自带的面板柔和均匀，金属上只形成一片弥散的亮区，
 * 没有"条形高光"——而工业机柜最有辨识度的视觉特征恰恰是：
 * 机柜边角反射出几道**锐利的、有明确方向的长条形灯带**。
 * 因此本文件在环境场景中额外插入 8 条高对比度冷青白灯带
 * （斜 45° 上半球 4 条 + 天顶 4 条），并在 PMREM 预滤波时保持较小的
 * sigma 以保留其边缘锐度。
 *
 * 【管线】
 *   RoomEnvironment（基底）+ 自定义工业灯带（8 条发光长方体）
 *     → PMREMGenerator.fromScene(scene, 0.02)   // 预滤波为 mip 链
 *     → envMap（PMREM 纹理）
 *     → scene.environment = envMap              // 所有标准材质自动采样
 *
 * 【为何 sigma 从 0.04 降到 0.02】sigma 越小，预滤波保留的高频细节越多。
 * 灯带要"锐"，就必须把模糊量压到最低；0.02 在 SwiftShader 与真实 GPU 上
 * 都能稳定保住灯带边缘，再小则可能出现 mip 采样噪点。
 *
 * 【显存契约（AGENTS.md 无明确条目，但这属于必须自己兜住的资源泄漏点）】
 * PMREM 纹理与生成器都持有 GPU 资源，组件卸载时必须成对 dispose，
 * 否则热更新/切页会持续累积显存，最终上下文丢失（黑屏）。
 * 自定义灯带的几何与材质同样需要显式释放。
 */

import { useEffect } from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';

/* ========================================================================== */
/* 环境常量                                                                    */
/* ========================================================================== */

/**
 * PMREM 预滤波强度：越小越高频（保留灯带锐利轮廓）。
 *
 * 【从 0.04 降到 0.02 的缘由】本轮新增的工业灯带是**细长条**，
 * 0.04 的模糊量足以让它们糊成一片均匀亮区，金属上就看不到"条状高光"。
 * 0.02 能让灯带边缘保持清晰，同时不至于产生 mip 采样噪点。
 */
const PMREM_SIGMA = 0.02;

/**
 * 环境反射强度。
 *
 * 【本轮从 0.55 提到 0.78】上一轮有机柜"偏暗色塑料感"的反馈，
 * 根因之一就是环境反射太弱：金属件拿不到足够的 IBL 贡献，
 * 只剩基础漫反射（即"塑料感"）。
 * 0.78 保留暗部层次的同时，让机架的拉丝金属与倒角真正"亮起来"。
 * 上限不超过 0.85——再高会让整场景发灰发白，失去深空基调。
 */
const ENV_INTENSITY = 0.78;

/** 工业灯带的深空冷青灰（R63：从近白 #dff6ff 下调，避免 PMREM 烘焙出白色高光） */
const STRIP_LIGHT_COLOR = '#94a3b8';

/* ========================================================================== */
/* 程序化拉丝金属纹理                                                          */
/* ========================================================================== */

/**
 * 拉丝金属纹理尺寸（正方形）。
 *
 * 【为何是 256】拉丝纹理是高频重复图案，128 在近景会看出明显的重复块，
 * 512 则让显存翻四倍而观感提升有限。256 是这张卡片的甜点值：
 * 配合 repeat(2, 6) 后，纵向拉丝密度足以在 1~2 米视距下读出丝纹。
 */
const BRUSH_TEXTURE_SIZE = 256;

/**
 * 生成拉丝金属纹理对（roughnessMap + bumpMap）所需的哈希噪声。
 *
 * 【为何用整数哈希而非 Math.random】
 * 1. **可复现**：同一版本每次生成的纹理完全一致，
 *    截图回归与时序对比才有意义；Math.random 会让每次刷新都不同。
 * 2. **无全局状态**：不依赖随机数生成器的调用顺序，
 *    即便未来并行生成多张纹理也不会互相影响。
 *
 * 这是 Mulberry32 的整数变体：输入确定，输出落在 [0,1)。
 *
 * @param seed 无符号整数种子
 * @returns [0,1) 区间的确定性伪随机值
 */
function hashNoise(seed: number): number {
  let t = (seed + 0x6d2b79f5) >>> 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/** 拉丝纹理缓存（模块级单例，避免重复生成与重复上传 GPU） */
let brushedMetalCache: { roughnessMap: THREE.DataTexture; bumpMap: THREE.DataTexture } | null = null;

/**
 * enhanceArmorMaterial —— 机架装甲材质程序化增强（R11 A2/A3/B1）。
 *
 * 通过 onBeforeCompile 注入，不新增 draw call、不新增贴图文件：
 * 1. 倒角高光：fresnel^4 × 冷青灰 × 0.09（掠射角/棱边附近，R63 由 0.25 下调）；
 * 2. 接缝 AO：UV 纵向 4 段接缝附近把漫反射压暗最多 30%（不碰自发光）；
 * 3. 深度大气：按视深 smoothstep(14, 33.6, |viewPos|)×0.35 混向雾色，
 *    远端节点亮度与饱和度同步下降；edge0<edge1 满足 R01。
 *
 * @param shader three 编译期着色器对象
 */
export function enhanceArmorMaterial(shader: {
  vertexShader: string;
  fragmentShader: string;
  uniforms: Record<string, { value: unknown }>;
}): void {
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nvarying vec3 kvViewPos;\nvarying vec3 kvNrm;\nvarying vec2 kvUv;')
    .replace('#include <beginnormal_vertex>', '#include <beginnormal_vertex>\n  kvNrm = normalize(normalMatrix * objectNormal);')
    .replace('#include <project_vertex>', '#include <project_vertex>\n  kvViewPos = - mvPosition.xyz;')
    .replace('#include <uv_vertex>', '#include <uv_vertex>\n  kvUv = uv;');

  shader.fragmentShader = shader.fragmentShader
    .replace(
      '#include <common>',
      '#include <common>\nvarying vec3 kvViewPos;\nvarying vec3 kvNrm;\nvarying vec2 kvUv;\nuniform float uKvHaze;\nuniform vec3 uKvFogColor;',
    )
    .replace(
      '#include <map_fragment>',
      '#include <map_fragment>\n  float kvSeamPhase = fract(kvUv.y * 4.0);\n  float kvSeam = smoothstep(0.94, 1.0, kvSeamPhase) + (1.0 - smoothstep(0.0, 0.06, kvSeamPhase));\n  diffuseColor.rgb *= 1.0 - clamp(kvSeam, 0.0, 1.0) * 0.30;',
    )
    .replace(
      '#include <emissivemap_fragment>',
      '#include <emissivemap_fragment>\n  float kvFres = pow(max(1.0 - abs(dot(normalize(kvNrm), normalize(kvViewPos))), 1.0e-4), 4.0);\n  totalEmissiveRadiance += vec3(0.45, 0.78, 0.96) * kvFres * 0.09;\n  float kvDepth = length(kvViewPos);\n  float kvHaze = smoothstep(uKvHaze, uKvHaze * 2.4, kvDepth) * 0.35;\n  diffuseColor.rgb = mix(diffuseColor.rgb, uKvFogColor, kvHaze);',
    );

  shader.uniforms.uKvHaze = { value: 14 };
  shader.uniforms.uKvFogColor = { value: new THREE.Color(0.008, 0.024, 0.067) };
}

/**
 * getBrushedMetalTextures —— 程序化生成拉丝金属的粗糙度与凹凸贴图。
 *
 * 【产出两张贴图的物理意义】
 * 1. **roughnessMap（粗糙度贴图）**：真实拉丝金属的表面并非均匀粗糙——
 *    拉丝方向上的沟槽让镜面反射被拉长（anisotropic highlight），
 *    而垂直于拉丝方向则有微小起伏。贴图用**纵向高频正弦**模拟丝纹、
 *    叠加哈希微噪点模拟晶粒，使粗糙度在 0.16~0.34 之间起伏。
 *    值的编码：three 读取 roughnessMap 的**绿色通道**，0 = 完全光滑，
 *    255 = 完全粗糙。因此 map 值域映射到 [0.16, 0.34] 需编码为
 *    约 41~87（0.16×255、0.34×255）。
 * 2. **bumpMap（凹凸贴图）**：仅影响法线扰动、不改变几何。
 *    用同一套丝纹但相位/频率略作偏移，让高光沿丝纹方向**断裂成细碎亮点**，
 *    这正是"拉丝"区别于"抛光"的关键视觉特征。
 *
 * 【为何 repeat 设为 (2, 6)】
 * 机柜立柱是**细长的纵向构件**（宽 0.1、高数米），若贴图均匀平铺，
 * 丝纹会显得粗大失真。纵向放大 6 倍使丝纹密集、与真实拉丝的
 * "每厘米数十道"密度接近；横向 2 倍则避免在窄面上出现半条丝纹的接缝感。
 *
 * 【为何是客户端单例】
 * 生成 2 张 256×256 的 Uint8Array 并上传 GPU 约需 1~3ms。
 * 三座机架共用同一份纹理即可（它们材质参数相同），
 * 单例缓存让这份开销只付一次，且三处材质共享同一 GPU 纹理对象。
 *
 * 【SSR 安全】函数内部访问 THREE 与 Uint8Array（均为纯 JS），
 * 但 DataTexture 的 GPU 上传发生在首次渲染时，因此服务端调用本函数
 * 也只会分配 CPU 侧内存、不会触碰 WebGL。调用方仍应在客户端组件内使用。
 *
 * @returns 两张 DataTexture；服务端环境返回 null
 */
export function getBrushedMetalTextures(): {
  roughnessMap: THREE.DataTexture;
  bumpMap: THREE.DataTexture;
} | null {
  /* 已有缓存直接复用（模块级单例，零重复开销） */
  if (brushedMetalCache !== null) return brushedMetalCache;

  /*
   * R11：三座机架共用同一份纹理（模块级单例缓存）。
   * 生成一次、上传一次，材质间共享 GPU 纹理对象。
   */
  /* 服务端没有 WebGL 上下文：返回 null，调用方以无贴图方式降级 */
  if (typeof window === 'undefined') return null;

  const size = BRUSH_TEXTURE_SIZE;

  /* ---- 1. 分配两张贴图的像素缓冲（RGBA：DataTexture 需 4 通道） ---- */
  const roughnessData = new Uint8Array(size * size * 4);
  const bumpData = new Uint8Array(size * size * 4);

  /**
   * 丝纹频率：每行重复的条纹数。
   *
   * 纵向拉丝意味着**水平方向**（x）变化剧烈、**垂直方向**（y）几乎不变。
   * 因此正弦的自变量取 x，频率取一个较高的值（28）让丝纹足够细密；
   * y 方向只叠加极缓慢的整体起伏（模拟板材轻微不平）。
   */
  const brushFrequency = 28;
  /** 缓慢起伏频率（沿 y）：让丝纹有"长尺度不均"而非机械重复 */
  const slowFrequency = 3;

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const index = (y * size + x) * 4;

      /* ---- 2. 主丝纹：横向高频正弦（值域 -1~1） ---- */
      const brushWave = Math.sin((x / size) * Math.PI * 2 * brushFrequency);

      /* ---- 3. 次级丝纹：稍低频率的同向波，制造粗细交替的真实感 ---- */
      const secondaryWave = Math.sin((x / size) * Math.PI * 2 * (brushFrequency * 0.42) + 1.7);

      /* ---- 4. 长尺度起伏：沿纵向缓慢变化，打破机械重复 ---- */
      const slowWave = Math.sin((y / size) * Math.PI * 2 * slowFrequency);

      /* ---- 5. 哈希微噪点：模拟金属晶粒的亚像素不规则 ---- */
      const grain = hashNoise(x * 7919 + y * 104729) - 0.5;

      /* ---- 6. 合成粗糙度 ----
       * R11：基准 0.55、丝纹 ±0.07、次纹 ±0.03、长尺度 ±0.04、
       * 晶粒 ±0.02、低频污渍 ±0.05 —— 总范围收敛到 **0.38~0.72**。
       * 这比"镜面不锈钢"更接近真实机柜：面板有使用痕迹与油污，
       * 高光不会整片过曝，近景才有材质可读性。
       */
      /* 低频污渍：32px 块的稀疏哈希，模拟指印/油污，半径远大于丝纹 */
      const stain =
        (hashNoise((Math.floor(x / 32) * 73856093) ^ Math.floor(y / 32)) - 0.5) * 0.10;
      const roughness =
        0.55 + brushWave * 0.07 + secondaryWave * 0.03 + slowWave * 0.04 + grain * 0.04 + stain;

      /* 归一化到 [0,1] 再编码为字节（三通道同值：three 读绿通道，写满更稳） */
      const roughnessClamped = Math.max(0, Math.min(1, roughness));
      const roughnessByte = Math.round(roughnessClamped * 255);

      /* ---- 7. 合成凹凸 ----
       * 凹凸贴图编码的是**相对高度**（凸=亮、凹=暗）。
       * 与粗糙度用相同的丝纹相位但方向略偏，让高光沿丝纹断裂而非连续。
       */
      const bumpValue =
        0.5 + brushWave * 0.32 + secondaryWave * 0.1 + grain * 0.18;
      const bumpClamped = Math.max(0, Math.min(1, bumpValue));
      const bumpByte = Math.round(bumpClamped * 255);

      roughnessData[index] = roughnessByte;
      roughnessData[index + 1] = roughnessByte;
      roughnessData[index + 2] = roughnessByte;
      /* 严格不透明：alpha 固定 255，避免部分驱动对 alpha 做额外混合 */
      roughnessData[index + 3] = 255;

      bumpData[index] = bumpByte;
      bumpData[index + 1] = bumpByte;
      bumpData[index + 2] = bumpByte;
      bumpData[index + 3] = 255;
    }
  }

  /* ---- 8. 包装为 DataTexture ---- */
  const roughnessMap = new THREE.DataTexture(roughnessData, size, size, THREE.RGBAFormat);
  const bumpMap = new THREE.DataTexture(bumpData, size, size, THREE.RGBAFormat);

  /*
   * 【纹理参数（两张完全相同）】
   * - wrapS/wrapT = RepeatWrapping：机柜立面尺寸远超贴图原始比例，
   *   必须重复平铺（ClampToEdge 会在边缘拉出一条亮边）。
   * - repeat.set(2, 6)：横向 2 次、纵向 6 次——立柱是纵向细长构件，
   *   纵向放大才能让丝纹密度看起来真实（详见函数 JSDoc）。
   * - magFilter = LinearFilter：放大时平滑，避免丝纹出现锯齿块。
   * - generateMipmaps = true + minFilter = LinearMipmapLinearFilter：
   *   远距离机架用 mip 层采样，消除摩尔纹（拉丝纹理是典型的高频图案，
   *   不做 mipmap 在远处会剧烈闪烁）。
   * - colorSpace 保持默认（NoColorSpace）：粗糙度与凹凸都是**数据贴图**，
   *   绝不能当 sRGB 色彩空间处理，否则数值会被伽马校正扭曲。
   */
  for (const texture of [roughnessMap, bumpMap]) {
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.repeat.set(2, 6);
    texture.magFilter = THREE.LinearFilter;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.generateMipmaps = true;
    /* 显式声明不需要翻转：three 对 DataTexture 默认不翻转，保持一致 */
    texture.flipY = false;
    /* 关键：把数据变化提交到 GPU。DataTexture 不会自动标记，必须手动置位 */
    texture.needsUpdate = true;
  }

  brushedMetalCache = { roughnessMap, bumpMap };
  return brushedMetalCache;
}

/* ========================================================================== */
/* 工业灯带几何构造                                                            */
/* ========================================================================== */

/**
 * createStripLightGeometry —— 构造一条工业灯带（细长发光长方体）。
 *
 * 【为何用长方体而非平面】灯带要能被环境贴图从**任意方向**采样到。
 * 平面是单面发光，从侧面/背面看不到，反射中会出现"灯带消失"的破绽；
 * 长方体六个面都发光，无论机柜朝向哪个角度，都能在倒角上反射到它。
 *
 * @param width  灯带长度
 * @param height 灯带宽度（发光截面高度）
 * @param depth  灯带宽度（发光截面深度）
 * @returns 可直接添加到环境场景的几何
 */
function createStripLightGeometry(width: number, height: number, depth: number): THREE.BoxGeometry {
  return new THREE.BoxGeometry(width, height, depth);
}

/**
 * createStripLightMaterial —— 工业灯带的自发光材质。
 *
 * 【为何用 meshBasicMaterial 而非 standard】环境场景只用于烘焙，
 * 材质不需要被光照——它的作用就是**作为光源被反射**。
 * meshBasicMaterial 输出恒定高亮颜色，烘焙结果最纯净。
 *
 * 【强度控制】颜色值可以超过 1 来表达 HDR 亮度。
 * R63：从 3.2 下调到 1.35——旧值把 8 根灯带烘成过曝光源，
 * 所有采样该 PMREM 的金属件都泛白；1.35 仍能在倒角上形成锐利冷光，
 * 但不再抬高整个环境的亮度基线。
 *
 * @returns 灯带材质（调用方负责 dispose）
 */
function createStripLightMaterial(): THREE.MeshBasicMaterial {
  const color = new THREE.Color(STRIP_LIGHT_COLOR);
  /* R63：深空冷青灰 × 1.35，替代原来的近白 × 3.2 */
  color.multiplyScalar(1.35);
  return new THREE.MeshBasicMaterial({ color, toneMapped: false });
}

/* ========================================================================== */
/* 组件                                                                        */
/* ========================================================================== */

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

    /**
     * 自定义工业灯带几何与材质（用于卸载时成对释放）。
     *
     * 【为何不复用同一个几何】不同灯带长度不同，共享几何需要缩放变换，
     * 而 mesh 的 scale 会影响其在环境场景中的视觉尺寸——
     * 用独立几何最直观。8 条灯带的几何总开销可忽略（每个 12 三角形）。
     */
    const stripGeometries: THREE.BoxGeometry[] = [];
    const stripMaterial = createStripLightMaterial();

    /**
     * ---- 上半球斜 45° 灯带（4 条）----
     *
     * 【布局】以 Y 轴为轴，在 0°/90°/180°/270° 四个方位各放一条，
     * 每条抬高到 y=2.6 并绕 X 轴倾斜 45°，形成"从斜上方打下来"的
     * 环形灯带组。机柜立柱的竖直棱边会反射出这四道斜向条光。
     *
     * 【为何倾斜 45°】竖直灯带只会在竖直面上反射出竖直光条；
     * 45° 倾斜能让**顶冠的水平边框**与**立柱的竖直棱边**同时捕获高光，
     * 这是工业摄影棚里最经典的"三点布光"简化版。
     */
    const DIAGONAL_STRIP_COUNT = 4;
    for (let i = 0; i < DIAGONAL_STRIP_COUNT; i += 1) {
      const angle = (i / DIAGONAL_STRIP_COUNT) * Math.PI * 2;
      const radius = 4.2;
      /* 灯带长度 3.4、截面 0.06×0.16 —— 细长比约 50:1，反射中才会呈现为"条" */
      const geometry = createStripLightGeometry(3.4, 0.06, 0.16);
      stripGeometries.push(geometry);

      const strip = new THREE.Mesh(geometry, stripMaterial);
      strip.position.set(Math.cos(angle) * radius, 2.6, Math.sin(angle) * radius);
      /*
       * 【朝向中心 + 倾斜 45°】
       * 先绕 Y 让灯带长度方向垂直于半径（面向中心），再绕局部 X 倾斜。
       * 用 rotation.set(x, y, 0) 的 YXZ 默认顺序即可近似达到目的：
       * 视觉上形成环绕中心的斜置灯带环。
       */
      strip.rotation.set(Math.PI / 4, -angle, 0);
      environmentScene.add(strip);
    }

    /**
     * ---- 天顶灯带（4 条平行排列）----
     *
     * 【布局】在 y=4.5 的天顶平面，沿 X 轴方向排布 4 条平行长灯带，
     * 间距 0.9。机柜顶冠的水平面与顶冠边框会在反射中呈现**平行条纹**，
     * 这是金属顶盖最有辨识度的高光形态。
     */
    const CEILING_STRIP_COUNT = 4;
    for (let i = 0; i < CEILING_STRIP_COUNT; i += 1) {
      const geometry = createStripLightGeometry(5.0, 0.05, 0.1);
      stripGeometries.push(geometry);

      const strip = new THREE.Mesh(geometry, stripMaterial);
      /* 居中排布：i - (count-1)/2 得到对称的偏移量 */
      const offset = (i - (CEILING_STRIP_COUNT - 1) / 2) * 0.9;
      strip.position.set(0, 4.5, offset);
      environmentScene.add(strip);
    }

    /* 预滤波：把程序化环境（基底 + 灯带）烘成带 mip 链的 PMREM 纹理 */
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
       * 自定义灯带：材质与几何都需显式释放。
       * 它们已随 environmentScene.dispose() 之外独立持有引用
       * （stripMaterial 被 8 个 mesh 共享，stripGeometries 各持一份），
       * 必须在这里成对清理，否则每次热更新都会泄漏 8 份几何 + 1 份材质。
       */
      stripMaterial.dispose();
      for (const geometry of stripGeometries) {
        geometry.dispose();
      }

      /*
       * RoomEnvironment 内部也是有几何/材质的真实场景，
       * 同样需要显式释放，否则每次热更新都会泄漏一份。
       */
      environmentScene.dispose();
    };
  }, [gl, scene]);

  return null;
}