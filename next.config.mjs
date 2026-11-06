/**
 * KubeVision AI — Next.js 14 (App Router) 构建配置
 *
 * 【设计意图】
 * 从第 1 轮起彻底消除 Three.js 与 Transformers.js（@huggingface/transformers）
 * 在 webpack 打包期的解析冲突与 Node 内置模块回退报错。
 *
 * 【关键决策】
 * 1. transpilePackages: ['three']
 *    three r169 以 ESM 形式分发（含 examples/jsm 子路径），交由 Next 的 SWC 统一转译，
 *    避免 App Router 下 ESM/CJS 互操作与 `three/examples/jsm/*` 深链导入的解析失败。
 *
 * 2. resolve.alias —— 'sharp$': false / 'onnxruntime-node$': false
 *    @huggingface/transformers 在运行期通过 try/catch 动态探测 Node 端可选原生依赖
 *    （sharp 图像处理、onnxruntime-node 本地 ORT 引擎）。本项目只做浏览器端侧推理
 *    （WebGPU / WASM），这两个包无需安装。使用「精确匹配」别名（$ 后缀）将其解析为
 *    false，webpack 会把这些请求替换为空模块：
 *      - 精确匹配保证 three / drei 内部任何名为 sharp 的变量、着色器标识不受影响；
 *      - 探测逻辑在运行期自然走入 catch 分支并回退到 WASM/ONNX Web 运行时；
 *      - 构建期不再抛出 "Can't resolve 'sharp'" / "Can't resolve 'onnxruntime-node'"。
 *
 * 3. resolve.fallback —— fs / path / crypto 置空
 *    上述两个包与部分 Web 侧 polyfill 会引用 Node 内置模块。客户端 bundle 不存在
 *    Node 运行时，显式声明 fallback: false 让 webpack 注入空实现而不是报错，
 *    同时避免为浏览器打包无意义的 Node polyfill（体积与 SSR 水合双重收益）。
 */

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ['three'],

  webpack: (config, { isServer, webpack }) => {
    /**
     * 【精确抑制第三方库的已知无害警告】
     * @huggingface/transformers 内部有 `import.meta` 的直接访问，
     * webpack 会提示 "Critical dependency: Accessing import.meta directly
     * is unsupported"。这是该库在浏览器 ESM 环境下的正常写法，
     * 实际运行不受影响（Worker 端已通过真机 WebGPU 验证）。
     *
     * 这里只匹配**这一个模块的这一条**警告，不用 ignoreWarnings 全局关闭
     * ——全局关闭会让真正的严重警告也被静默，那是危险的。
     */
    config.ignoreWarnings = [
      ...(config.ignoreWarnings ?? []),
      {
        module: /@huggingface[\\/]transformers/,
        message: /Accessing import\.meta directly is unsupported/,
      },
    ];

    config.resolve.alias = {
      ...config.resolve.alias,
      // 可选原生依赖：仅探测、不安装，解析为空模块
      'sharp$': false,
      'onnxruntime-node$': false,
    };

    /**
     * 【Worker 打包修复】@huggingface/transformers 内部存在形如
     * `import('./')` 的动态导入（用于在 Node 环境下探测同目录的
     * onnxruntime 原生绑定）。webpack 打包 Web Worker 时会尝试解析
     * 这个相对路径，但 Worker chunk 的输出目录结构与源目录不同，
     * 于是报 "Module not found: Can't resolve './'"。
     *
     * 处理方式：用 IgnorePlugin 忽略这一无法静态解析的模块引用。
     * 本项目只在浏览器端使用（WebGPU / WASM），Node 分支永远不会执行，
     * 因此忽略解析不影响任何运行时行为。
     */
    config.plugins.push(
      new webpack.IgnorePlugin({
        resourceRegExp: /^\.\/$/,
      }),
    );

    // Node 内置模块在浏览器端一律置空（客户端与服务端构建保持一致，
    // 服务端侧同样不需要 sharp / onnxruntime-node 的真实解析结果）
    config.resolve.fallback = {
      ...config.resolve.fallback,
      fs: false,
      path: false,
      crypto: false,
    };

    // 服务端产物无需最小化，跳过可显著缩短构建时间（客户端行为不变）
    if (isServer) {
      config.optimization.minimize = false;
    }

    return config;
  },
};

export default nextConfig;
