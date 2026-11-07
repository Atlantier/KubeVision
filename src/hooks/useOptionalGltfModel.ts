/**
 * KubeVision AI — Blender GLTF 可选模型钩子（useOptionalGltfModel）
 *
 * 【解决什么问题】美术需要随时把 Blender 导出的高精度 `.glb` 硬件模型放进
 * `public/models/` 替换程序化几何体，但**绝大多数时候这些文件并不存在**。
 * 若直接用 GLTFLoader 去加载一个不存在的路径，浏览器会打印 404 报错、
 * 抛出异常、并让首屏等待一次失败的网络往返——这对演示是纯负收益。
 *
 * 因此本钩子做三件事：
 *
 * 1. **零噪音探测**：先用 `fetch(url, { method: 'HEAD' })` 探一次，
 *    并校验 `Content-Type` 不是 `text/html`。
 *    Next.js 对未命中的静态路径会回落到页面路由并返回一个 HTML 的 404 页面
 *    （部分部署形态下 `response.ok` 甚至为 true），仅看状态码会误判成"文件存在"，
 *    随后 GLTFLoader 解析 HTML 直接抛错。校验 Content-Type 才能真正确认是模型。
 *
 * 2. **绝不阻塞渲染**：探测在 `useEffect` 内进行（客户端、挂载后），
 *    首帧一定先渲染程序化几何体；探测完成后若有模型再切换。
 *    整个过程 `scene` 初值为 `null`、`isAvailable` 初值为 `false`，
 *    调用方可以无条件先渲染 fallback。
 *
 * 3. **模块级缓存 + 克隆**：同一 URL 只加载一次（`Map<url, Promise>`），
 *    多份实例共享同一份解析结果，每次取用时 `clone(true)` 得到独立 Group，
 *    避免多个机架共享同一批 Object3D（共享会导致变换/材质互相污染）。
 *
 * 【阴影契约】加载后遍历所有子网格，强制 `castShadow = receiveShadow = true`：
 * Blender 导出的 glTF 不带阴影开关，若不显式开启，模型会"浮"在场景里没有接地感。
 */

import { useEffect, useState } from 'react';

import type { Group, Mesh } from 'three';

/** 钩子返回值 */
export interface OptionalGltfModelResult {
  /** 可用模型的克隆（不可用时为 null） */
  readonly scene: Group | null;
  /** 该路径下是否检测到真实可加载的 .glb */
  readonly isAvailable: boolean;
}

/**
 * 模块级缓存：URL → 已加载并预处理过的原始 Group（未克隆）。
 *
 * 【为什么缓存"原始"而非"克隆"】克隆发生在每次调用处，
 * 缓存原始模板可保证克隆源永远干净（不会被某一处的变换污染）。
 * 缓存 Promise 而非结果，天然处理"并发挂载时重复请求"的竞态。
 */
const modelCache = new Map<string, Promise<Group | null>>();

/**
 * probeModelExists —— 轻量探测 .glb 是否真实存在。
 *
 * @param url 模型路径（如 '/models/worker-rack.glb'）
 * @returns 存在且确为二进制模型时 true
 */
async function probeModelExists(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { method: 'HEAD', cache: 'no-store' });
    if (!response.ok) return false;

    /*
     * 关键：校验 Content-Type。
     * Next.js 的静态回退会为不存在的路径返回 HTML 404 页面；
     * 某些 CDN/平台下 `ok` 仍为 true，此时若不校验类型，
     * 后续 GLTFLoader 会拿到一段 HTML 并抛出解析错误。
     */
    const contentType = response.headers.get('content-type') ?? '';
    if (contentType.toLowerCase().includes('text/html')) return false;
    if (!contentType.toLowerCase().includes('model') && !contentType.toLowerCase().includes('octet-stream')) {
      /*
       * 部分静态服务器对 .glb 返回 application/gltf-binary 或 octet-stream，
       * 也有返回空 Content-Type 的情况。空类型时仍放行——真正的校验交给
       * GLTFLoader 解析，探测阶段只排除"明确是 HTML"的情况。
       */
      if (contentType.length > 0 && !contentType.startsWith('application/')) return false;
    }
    return true;
  } catch {
    /* 网络异常一律视作不可用，不向调用方抛错 */
    return false;
  }
}

/**
 * loadModel —— 动态加载并预处理 glTF 模型（模块级缓存）。
 *
 * @param url 模型路径
 * @returns 预处理后的原始 Group；失败返回 null
 */
function loadModel(url: string): Promise<Group | null> {
  const cached = modelCache.get(url);
  if (cached !== undefined) return cached;

  const task = (async (): Promise<Group | null> => {
    const exists = await probeModelExists(url);
    if (!exists) return null;

    try {
      /* 动态导入：GLTFLoader 只在真正存在模型时才会进入客户端包 */
      const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
      const loader = new GLTFLoader();
      const gltf = await loader.loadAsync(url);
      const root = gltf.scene;

      /*
       * 阴影契约：Blender 导出的 glTF 不携带阴影开关，
       * 必须逐个网格显式开启，否则模型在场景里没有投影、缺乏接地感。
       */
      root.traverse((child): void => {
        if ((child as Mesh).isMesh === true) {
          child.castShadow = true;
          child.receiveShadow = true;
        }
      });

      return root;
    } catch {
      /*
       * 解析失败（损坏文件 / 非 glTF 内容）视作不可用：
       * 静默回落程序化几何体，绝不把错误抛到渲染树里炸掉整个 Canvas。
       */
      return null;
    }
  })();

  modelCache.set(url, task);
  return task;
}

/**
 * useOptionalGltfModel —— 可选的 Blender 模型加载钩子。
 *
 * @param url `.glb` 的公开路径，如 '/models/worker-rack.glb'
 * @returns { scene, isAvailable }；不可用时 scene 恒为 null
 */
export function useOptionalGltfModel(url: string): OptionalGltfModelResult {
  const [scene, setScene] = useState<Group | null>(null);
  const [isAvailable, setIsAvailable] = useState<boolean>(false);

  useEffect((): void | (() => void) => {
    /* 卸载标记：模型加载是异步的，组件可能在加载途中被卸载 */
    let cancelled = false;

    void loadModel(url).then((template): void => {
      if (cancelled) return;
      if (template === null) {
        /* 无模型：保持 fallback，不触发任何状态噪音 */
        setIsAvailable(false);
        return;
      }
      /* 每次使用都克隆，确保多份实例互不干扰变换与材质 */
      setScene(template.clone(true));
      setIsAvailable(true);
    });

    return (): void => {
      cancelled = true;
    };
  }, [url]);

  return { scene, isAvailable };
}