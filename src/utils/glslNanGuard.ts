/**
 * KubeVision AI — GLSL NaN 可视化探针（开发期）
 *
 * 【解决什么问题】片元算出一个 NaN 后，GPU 不会报错，也不会中断渲染：
 * 这个像素要么变黑、要么变白、要么被后处理的 bloom 扩散成一整块斑。
 * 光看画面**无法定位是哪一段 GLSL 产生的**——只能靠猜。
 * 本模块让污染像素直接变成刺眼的洋红（1,0,1），一眼就能在屏幕上圈出问题区域。
 *
 * 【为什么不用 WebGL2 的 isnan() / isinf()】这两个内建函数只在
 * GLSL ES 3.00（`#version 300 es`）中可用。本项目所有自定义 shader 都以
 * ES 1.00 编译（three 默认不注入 `#version` 指令），直接写 isnan 会**编译失败**，
 * 整个材质变黑——比原来的 NaN 更糟。
 * 因此这里用三条在 ES 1.00 中同样成立的等价判据：
 *   1. `v != v`        —— IEEE-754 下 NaN 是唯一不等于自身的值；
 *   2. `abs(v) > 1e38` —— 超出 float32 表示范围的有限值必然已溢出为 Inf；
 *   3. 逐通道检查 rgb —— 只要任一通道异常就整像素标洋红。
 *
 * 【生产构建零成本】探针体整段被 `#ifdef KV_DEBUG_NAN` 包裹，而
 * `KV_DEBUG_NAN_DEFINES` 在 production 下是空对象 → 预处理器直接把整段删掉，
 * 不产生任何指令、不占用 uniform、不影响分支预测。
 *
 * 【用法】
 *   <shaderMaterial defines={KV_DEBUG_NAN_DEFINES} ... />
 *   并在 fragment 源码里、每次写完 gl_FragColor 之后追加 KV_NAN_GUARD_BLOCK。
 */

/**
 * 注入给 shaderMaterial 的 defines。
 *
 * 【类型说明】three 的 `defines` 接受 `Record<string, string | number | boolean>`；
 * 这里只放一个开关，值为 `'1'`。空对象时 three 不会注入任何 `#define`，
 * `#ifdef KV_DEBUG_NAN` 分支即被剔除。
 */
export const KV_DEBUG_NAN_DEFINES: Readonly<Record<string, string>> =
  process.env.NODE_ENV === 'production' ? {} : { KV_DEBUG_NAN: '1' };

/**
 * 追加在 `gl_FragColor` 赋值之后的守卫块。
 *
 * 【为什么是"事后覆盖"而不是包裹表达式】包裹需要用括号匹配找到 `vec4(...)`
 * 的闭合位置，而 shader 里 `vec4` 可能嵌套多层（clamp 套 mix 套 …），
 * 字符串层面做括号匹配极易出错。写成"再赋值一次"则完全不需要匹配：
 * 异常就把值换掉，正常则不产生任何可见变化。
 *
 * 【为什么不用 discard】discard 会让该像素透明，在加色混合/后处理链里
 * 表现为"洞"，反而不如洋红醒目；而且 discard 会打断早期深度测试，影响性能。
 */
export const KV_NAN_GUARD_BLOCK = `
  #ifdef KV_DEBUG_NAN
    if (!(gl_FragColor.r == gl_FragColor.r)
        || !(gl_FragColor.g == gl_FragColor.g)
        || !(gl_FragColor.b == gl_FragColor.b)
        || !(gl_FragColor.a == gl_FragColor.a)
        || abs(gl_FragColor.r) > 1.0e38
        || abs(gl_FragColor.g) > 1.0e38
        || abs(gl_FragColor.b) > 1.0e38) {
      gl_FragColor = vec4(1.0, 0.0, 1.0, 1.0); // glsl-lint-allow: 洋红调试标记为常量输出，无 HDR 溢出风险
    }
  #endif
`;
