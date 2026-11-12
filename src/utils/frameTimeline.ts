/**
 * KubeVision AI — 时间轴去重与单调修正纯函数（R4 进阶 · 可测试契约）
 *
 * 【为什么抽成纯函数】R4 Main 把 seq 去重与时间戳守卫内联在 Hook 投递管线里，
 * 运行期正确但无法被 verify-telemetry 直接断言。抽成零依赖纯函数后，
 * 「重复帧丢弃」「时间戳以服务端为准」两条契约可以在 Node 里逐条证明，
 * 浏览器探针再做运行期复核——静态+运行期双证据。
 *
 * 【时钟契约】本文件**绝不引用 Date.now()**：帧时间戳以服务端为准，
 * 客户端只做单调修正。客户端时钟快/慢都不允许污染时间轴。
 */

/**
 * isDuplicateSeq —— 帧序号去重判定。
 *
 * 【契约】seq <= lastSeq 即重复（含回退与相等），调用方应丢弃并计数。
 * 新连接开始时 lastSeq 复位为 -1（服务端从种子 seq=0 重新起步），
 * 因此首帧 seq=0 也能被接受（0 > -1）。
 *
 * @param seq     入站帧序号
 * @param lastSeq 最近已接受帧序号（新连接为 -1）
 * @returns true 表示重复帧，应丢弃
 */
export function isDuplicateSeq(seq: number, lastSeq: number): boolean {
  return seq <= lastSeq;
}

/**
 * guardFrameTimestamp —— 时间戳单调修正（服务端为准）。
 *
 * 【契约】入站时间戳晚于已知进度 → 原样采用（服务端是事实源）；
 * 早于或等于已知进度（服务端重启/代理旧帧/时钟回拨）→ 钳制到
 * 「已知进度 + 一个 tick」，只保证单调，**绝不采用客户端墙钟**。
 *
 * 【为什么不用 Date.now()】客户端时钟可能快几分钟（NTP 漂移/手动改时区），
 * 一旦用客户端时刻覆盖服务端时间戳，时间轴会跳到未来且不可逆；
 * 而「已知进度 + tick」的漂移上界被重复帧去重（isDuplicateSeq）锁死——
 * 重复帧根本进不来，修正只发生在真实的乱序帧上。
 *
 * @param rawTs   入站帧的服务端时间戳（epoch ms）
 * @param knownTs 客户端最近已接受帧的时间戳
 * @param tickMs  推流节拍（毫秒）
 * @returns 修正后的单调时间戳
 */
export function guardFrameTimestamp(rawTs: number, knownTs: number, tickMs: number): number {
  return rawTs > knownTs ? rawTs : knownTs + tickMs;
}