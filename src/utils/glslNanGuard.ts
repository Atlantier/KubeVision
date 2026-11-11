/**
 * KubeVision AI — GLSL NaN / Infinity 防线（开发探针 + 生产守卫）
 *
 * 【解决什么问题】片元一旦算出 NaN，GPU 不会报错，也不会中断渲染：
 * 这个像素要么变黑、要么变白，经 Bloom 降采样/升采样后扩散成一整块斑。
 * 光看画面无法定位是哪一段 GLSL 产生的，只能靠猜。
 *
 * 【为什么不能只写 x == x】这是本文件的历史缺陷，也是 R59 修复的核心：
 * 1. 在 Windows Chrome/Edge 上，WebGL 经 ANGLE 转译为 D3D11 HLSL；
 *    HLSL 默认优化会把 `!(x == x)` 静态折叠为 `false`，NaN 直接逃逸；
 * 2. `x == x` 对 ±Infinity 仍返回 true，而 Bloom 里的 `Infinity * 0.0`
 *    会立刻生成 NaN；只判 NaN 等于没判；
 * 3. 部分驱动对 `clamp(NaN, 0.0, 4.0)` 仍返回 NaN，不能把 clamp 当保险。
 *
 * 【正确判据：范围取反 + 有限上界】
 * 对每个通道检查 `!(x >= lo && x <= hi)`：
 * - NaN 与任何数比较都为 false → 取反为 true → 被判为异常；
 * - +Infinity 超过 hi → 异常；-Infinity / 负数低于 lo → 异常；
 * - 该写法不依赖 `x == x`，不会被 HLSL 折叠成常量 false。
 * 异常像素直接清零（加色混合下等于"不发光"），正常像素再做双向夹逼，
 * 保证进入 HalfFloatType 帧缓冲的颜色永远不会是 Inf/NaN。
 *
 * 【生产是否生效】KV_NAN_GUARD_BLOCK 是**无条件**守卫（不再包 #ifdef）：
 * 黑块是线上也必须拦截的渲染事故，不应只在调试构建开启。
 * KV_DEBUG_NAN_DEFINES 保留给仓库里既有的 `#ifdef KV_DEBUG_NAN` 洋红探针块，
 * 二者互不替代。
 *
 * 【用法】
 *   const FRAGMENT_SHADER = withNanGuard(`
 *     void main() { ... gl_FragColor = ...; }
 *   `);
 *
 * withNanGuard 会把守卫块插到 fragment shader 的**最后一个右花括号之前**
 * （即 main 的末尾）。前提约定：着色器最后一个语句是写 gl_FragColor。
 */

/**
 * 注入给 shaderMaterial 的调试 defines。
 *
 * 【类型说明】three 的 `defines` 接受 `Record<string, string | number | boolean>`；
 * 这里只放一个开关，值为 `'1'`。空对象时 three 不会注入任何 `#define`，
 * 既有 shader 中的 `#ifdef KV_DEBUG_NAN` 分支即被剔除。
 *
 * 注意：它只控制"洋红调试探针"，不控制 KV_NAN_GUARD_BLOCK 的生产守卫。
 */
export const KV_DEBUG_NAN_DEFINES: Readonly<Record<string, string>> =
  process.env.NODE_ENV === 'production' ? {} : { KV_DEBUG_NAN: '1' };

/**
 * 追加在 fragment shader main 末尾的强守卫块。
 *
 * 【为何是"事后覆盖"而不是包裹表达式】包裹需要用括号匹配找到 `vec4(...)`
 * 的闭合位置，而 shader 里 `vec4` 可能嵌套多层（clamp 套 mix 套 …），
 * 字符串层面做括号匹配极易出错。写成"再赋值一次"则完全不需要匹配：
 * 异常就把值清零，正常则只做夹逼，不改变语义。
 *
 * 【为何异常时输出透明黑而不是洋红】洋红是调试标记；生产守卫的职责是
 * "不让坏值进入 Bloom"，透明黑在加色混合/预乘 alpha 管线下等价于无贡献。
 *
 * 【为何上界是 64 而不是 3.2】判据负责识别异常（64 是有限上界，远高于
 * 正常 HDR 峰值但远低于 HalfFloat 的 65504）；正常分支再夹到 3.2，
 * 既保留辉光，又给 Bloom 留出安全余量。
 */
export const KV_NAN_GUARD_BLOCK = /* glsl */ `
  // [KV_NAN_GUARD] 拦截 NaN / ±Infinity 并钳制 HDR 峰值，防止 Bloom Mipmap 传染黑块
  bvec4 _kvInvalid = bvec4(
    !(gl_FragColor.r >= 0.0 && gl_FragColor.r <= 64.0),
    !(gl_FragColor.g >= 0.0 && gl_FragColor.g <= 64.0),
    !(gl_FragColor.b >= 0.0 && gl_FragColor.b <= 64.0),
    !(gl_FragColor.a >= 0.0 && gl_FragColor.a <= 1.0)
  );
  if (any(_kvInvalid)) {
    gl_FragColor = clamp(vec4(0.0, 0.0, 0.0, 0.0), 0.0, 1.0);
  } else {
    gl_FragColor.rgb = min(max(gl_FragColor.rgb, vec3(0.0)), vec3(3.2));
    gl_FragColor.a = min(max(gl_FragColor.a, 0.0), 1.0);
  }
`;

/**
 * withNanGuard —— 把强守卫块注入 fragment shader 的 main 末尾。
 *
 * 【实现选择】不引入 GLSL 解析器，只找**最后一个** `}`：
 * 本仓库的自定义 shader 都是"单 main + 末尾无其他函数"的形态；
 * 最后一个 `}` 必然是 main 的闭合。若 shader 还包含辅助函数，
 * 调用方应把守卫块手动放到 main 末尾，或先把辅助函数移到 main 之前。
 *
 * 【为什么不做字符串替换 gl_FragColor】一次 shader 里可能有多个分支写
 * gl_FragColor，逐个替换容易漏；追加一次守卫覆盖所有分支的最后结果。
 *
 * @param fragmentShader 完整 fragment shader 源码（末尾为 main 的 `}`）
 * @returns 已注入守卫的源码；若找不到 `}` 则原样追加守卫（编译性由调用方保证）
 */
export function withNanGuard(fragmentShader: string): string {
  const lastBrace = fragmentShader.lastIndexOf('}');
  if (lastBrace < 0) {
    return `${fragmentShader}\n${KV_NAN_GUARD_BLOCK}`;
  }
  return `${fragmentShader.slice(0, lastBrace)}${KV_NAN_GUARD_BLOCK}${fragmentShader.slice(lastBrace)}`;
}