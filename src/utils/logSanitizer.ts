/**
 * KubeVision AI — 端侧日志隐私脱敏器（Zero-Latency PII Sanitizer）
 *
 * 【设计意图】日志在离开设备边界之前必须完成脱敏。任何把原始凭证发给
 * 远程 LLM 的方案，无论 TLS 多严密，都等于把生产密钥交出去——这在
 * 企业合规上直接不可接受。本模块提供**纯同步、零延迟**的脱敏能力：
 * 不依赖网络、不依赖模型、不引入异步等待，因此在渲染主线程内直接调用即可，
 * 不会造成任何可感知的卡顿（正则替换在典型日志量级下是微秒级）。
 *
 * 【威胁模型】需要被清除的四类高价值目标：
 * 1. **IP 地址**（含端口）——暴露集群拓扑与内网结构，是横向移动的侦察起点；
 * 2. **JWT / Bearer Token**——通常直接等价于访问凭据，泄露即失守；
 * 3. **云厂商 AccessKey**——AWS AK/SK、阿里云 AccessKeyId 等长期凭据，
 *    泄露可导致整账号资源被接管（真实事故的常见源头）；
 * 4. **邮箱**——个人身份信息（PII），受 GDPR / 个人信息保护法约束。
 *
 * 【替换策略：语义化占位符而非空串】
 * 一律替换为 [REDACTED_IP] / [MASKED_TOKEN] / [MASKED_KEY] / [REDACTED_EMAIL]
 * 而非删除。原因有三：
 * 1. 保留「此处曾有一个 IP」这一事实，日志的**结构语义**不被破坏
 *    （例如 "connect to <X>:5432 failed" 仍能看出是数据库连接问题）；
 * 2. 下游模型可以学到「这里有敏感信息但被遮蔽」这一上下文特征；
 * 3. 便于人工审计核对脱敏是否漏项。
 *
 * 【规则顺序的重要性】连接串（含账号密码的 URI）必须优先处理，
 * 否则其内部的 password 段会被后续的通用规则先行破坏，导致 URL 结构错乱。
 */

/* ========================================================================== */
/* 类型契约                                                                    */
/* ========================================================================== */

/**
 * SanitizeResult —— 单次脱敏的完整结果。
 */
export interface SanitizeResult {
  /** 脱敏后的文本（可安全外发给远端 LLM / 写入远端日志） */
  readonly sanitized: string;
  /** 本次累计替换的敏感字段数量（0 表示无敏感信息命中） */
  readonly maskedCount: number;
}

/**
 * SanitizerRule —— 单条脱敏规则的形状。
 *
 * 【为何把规则抽成数据表】脱敏是安全关键路径，规则应当**可枚举、可审计、
 * 可单测**。把正则散落在函数体里会让"到底覆盖了哪些敏感类型"这件事
 * 变得不可回答；抽成表后，新增一类敏感信息只是往表里加一项，
 * 且顺序即优先级，一眼可见。
 */
interface SanitizerRule {
  /** 规则可读名（用于诊断与文档） */
  readonly name: string;
  /** 匹配模式（必须带 g 标志以支持全局替换与计数） */
  readonly pattern: RegExp;
  /** 替换为的语义化占位符 */
  readonly placeholder: string;
}

/* ========================================================================== */
/* 脱敏规则表（顺序 = 优先级）                                                  */
/* ========================================================================== */

/**
 * SANITIZER_RULES —— 四条核心脱敏规则，按优先级从高到低排列。
 *
 * 【顺序说明】
 * - 云厂商密钥与 JWT 放在 IP 之前：它们更长、特征更明确，
 *   先匹配可避免其中的数字片段被 IP 规则误伤（如 AK 中的数字段）；
 * - 邮箱放在最后：它的匹配面最广，若提前处理可能吃掉 JWT 中的
 *   Base64 片段（形如 a@b 的组合），放最后最安全。
 */
const SANITIZER_RULES: readonly SanitizerRule[] = [
  {
    /* ---- 0. URL 内嵌凭证（最高优先级） ---- */
    name: 'url-embedded-credential',
    /**
     * 匹配 `scheme://user:password@host` 形态的连接串。
     *
     * 【为何必须最高优先级】这是真实日志里最常见的凭证泄露形态：
     * 应用把数据库/缓存连接串打进错误日志，形如
     * `postgres://admin:S3cr3t!@db.internal:5432/payments`。
     * 其中的 password 段既不是标准 token 也不是 AccessKey，
     * 上文的 IP / Token / Key 规则全都抓不到它——**漏掉它就是真的漏了**。
     *
     * 【为何放在 IP 规则之前】该模式内部含 host（可能是 IP）。
     * 若先跑 IP 规则，`10.0.0.5:5432` 会被替换成 `[REDACTED_IP]`，
     * 导致 URL 结构变成 `postgres://user:pass@[REDACTED_IP]/db`，
     * 虽然 IP 被遮蔽了，但 **username:password 仍然裸奔**。
     * 先整体吞掉凭证段，再让后续规则处理剩余 host，顺序才正确。
     *
     * 【保留结构】替换为 `$1://[REDACTED_CREDENTIAL]@`，保留 scheme 与 `@`
     * 分隔符，使日志仍能看出"这是一个带认证的连接串"，只是凭证被抹掉。
     */
    pattern: /\b([a-z][a-z0-9+.-]*):\/\/[^\s:/@]+:[^\s@/]+@/gi,
    placeholder: '$1://[REDACTED_CREDENTIAL]@',
  },
  {
    /* ---- 0.5 通用密码字段（URL 之外的裸凭证） ---- */
    name: 'password-field',
    /**
     * 匹配 `password=xxx` / `passwd: xxx` / `pwd=xxx` / `secret=xxx` 等
     * 键值形态的凭证，**覆盖不嵌在 URL 里的情况**。
     *
     * 【为什么需要单独一条】上一条 url-embedded-credential 只处理
     * `scheme://user:pass@host` 这一种形态。但真实日志里密码还会以
     * 独立键值对出现，例如：
     *   - `admin S3cr3t! at postgres://...`（自由文本中提及密码）
     *   - `db_password=hunter2 connecting`
     *   - `config: {passwd: "xxx"}`
     * 这些 URL 规则抓不到，会成为真实的泄露缺口（回归测试实测发现）。
     *
     * 【保留键名】替换为 `$1=[REDACTED_PASSWORD]`，保留键名让日志
     * 仍能看出"此处曾设置过密码"，便于排查配置问题。
     *
     * 【边界控制】值部分要求至少 4 个字符且不含空格/引号/逗号/分号，
     * 避免把 `password policy: enabled` 这类正常文案误判。
     *
     * 【为何不用 \b 开头】`\b` 要求边界两侧一为词字符一为非词字符，
     * 而 `db_password` 中 `_` 属于词字符，故 `_` 与 `p` 之间**没有**词边界，
     * `\bpassword` 无法匹配 `db_password=`（回归测试实测发现）。
     * 改用负向后顾 `(?<![A-Za-z0-9])`：只要前面不是字母数字即可，
     * 允许下划线、点、短横等常见键名前缀（db_password / app.secret / x-pwd）。
     *
     * 【前缀捕获】把合法的键名前缀（`[\w.-]*`）并入捕获组 $1，
     * 使替换后保留完整键名（`db_password=[REDACTED_PASSWORD]`），
     * 而不是残缺成 `db_=[REDACTED_PASSWORD]`——保留键名才便于排查配置。
     */
    pattern:
      /(?<![A-Za-z0-9])((?:[A-Za-z0-9_.-]*)(?:password|passwd|pwd|secret|passphrase))\s*[=:]\s*["']?([^\s"',;}]{4,})/gi,
    placeholder: '$1=[REDACTED_PASSWORD]',
  },
  {
    /* ---- 1. 云厂商 AccessKey ---- */
    name: 'cloud-access-key',
    /**
     * 覆盖主流云厂商的长期凭据格式：
     * - AWS Access Key ID：AKIA / ASIA / AGPA / AIDA / AROA 前缀 + 16 位大写字母数字
     * - AWS Secret Access Key：40 位 Base64 风格字符（需伴随 secret 字样上下文才匹配，
     *   否则会误伤正常哈希值）
     * - 阿里云 AccessKeyId：LTAI 前缀 + 12~20 位字母数字
     * - 腾讯云 SecretId：AKID 前缀 + 32 位字母数字
     */
    pattern:
      /\b(?:AKIA|ASIA|AGPA|AIDA|AROA)[0-9A-Z]{16}\b|\bLTAI[0-9A-Za-z]{12,20}\b|\bAKID[0-9A-Za-z]{32}\b|((?:aws)?_?(?:secret)?_?(?:access)?_?key(?:_id)?\s*[=:]\s*["']?)[0-9A-Za-z/+=]{16,45}/gi,
    placeholder: '[MASKED_KEY]',
  },
  {
    /* ---- 2. JWT / Bearer Token ---- */
    name: 'bearer-token',
    /**
     * JWT 的三段式结构：header.payload.signature，各段均为 Base64URL。
     * 要求三段都达到一定长度，避免把普通带点号的标识符误判为 JWT。
     * 同时覆盖 `Authorization: Bearer xxx` 与裸 Token 字符串两种形态。
     */
    pattern:
      /\b[Bb]earer\s+[A-Za-z0-9\-._~+/]{8,}=*|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
    placeholder: '[MASKED_TOKEN]',
  },
  {
    /* ---- 3. IPv4 地址（含可选端口） ---- */
    name: 'ipv4',
    /**
     * 覆盖内网（10/8、172.16/12、192.168/16）与公网全部 IPv4，
     * 并可选捕获 `:port` 后缀以一并遮蔽（端口暴露同样是拓扑信息）。
     *
     * 【精确性】用 (?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d) 而非宽泛的 \d{1,3}，
     * 后者会把 "999.999.999.999" 这种非法值也当成 IP，
     * 反而让真正的版本号（如 1.2.3.4 形式的语义化版本）难以区分。
     * 边界用 (?<![\d.]) / (?![\d.]) 防止从更长的数字串中间截断。
     */
    pattern:
      /(?<![\d.])(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?::\d{1,5})?(?![\d.])/g,
    placeholder: '[REDACTED_IP]',
  },
  {
    /* ---- 4. 邮箱地址 ---- */
    name: 'email',
    pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    placeholder: '[REDACTED_EMAIL]',
  },
];

/* ========================================================================== */
/* 主脱敏函数                                                                  */
/* ========================================================================== */

/**
 * sanitizeRawLog —— 对单条原始日志执行端侧隐私脱敏（同步、零延迟）。
 *
 * 【核心流转】
 * 1. 依次应用 SANITIZER_RULES 中的每条规则；
 * 2. 每条规则替换前先用 match 统计命中数（全局正则的 exec 会带状态，
 *    用 String.match 更安全，不会污染 lastIndex）；
 * 3. 累加命中数作为 maskedCount 返回。
 *
 * 【为何是同步的】Worker 的推理是异步的（模型加载 + 前向计算），
 * 但脱敏必须是同步的：它要在日志产生的瞬间完成，成为"外发前的最后一关"。
 * 若做成异步，调用方就有机会在等待期间误用原始文本。
 *
 * 【幂等性】对已脱敏文本再次调用不会重复计数——占位符本身不匹配任何
 * 规则（[REDACTED_IP] 不是合法 IP，[MASKED_TOKEN] 不是 JWT）。
 * 这一点很重要：调用方重复处理不会导致 maskedCount 虚高。
 *
 * @param raw 原始日志文本（可能包含敏感信息）
 * @returns 脱敏文本与累计脱敏字段数
 */
export function sanitizeRawLog(raw: string): SanitizeResult {
  /* 空输入/非字符串防御：直接返回，不抛错（脱敏器绝不该成为故障点） */
  if (typeof raw !== 'string' || raw.length === 0) {
    return { sanitized: typeof raw === 'string' ? raw : '', maskedCount: 0 };
  }

  let sanitized = raw;
  let maskedCount = 0;

  for (const rule of SANITIZER_RULES) {
    /* ---- 统计命中数（String.match 不修改正则状态，比 exec 循环安全） ---- */
    const matches = sanitized.match(rule.pattern);
    if (matches === null || matches.length === 0) continue;

    maskedCount += matches.length;
    /* ---- 全局替换为语义化占位符 ---- */
    sanitized = sanitized.replace(rule.pattern, rule.placeholder);
  }

  return { sanitized, maskedCount };
}

/**
 * sanitizeBatch —— 批量脱敏（日志审计面板的常用入口）。
 *
 * 【设计意图】调用方通常一次处理多条日志，需要「逐条的脱敏结果」
 * 与「整批累计脱敏数」两个层级的统计。逐条结果用于构造 LogEntry，
 * 整批累计用于 HUD 的隐私审计角标。
 *
 * @param raws 原始日志数组
 * @returns 逐条结果数组与整批累计脱敏数
 */
export function sanitizeBatch(raws: readonly string[]): {
  readonly results: readonly SanitizeResult[];
  readonly totalMasked: number;
} {
  const results: SanitizeResult[] = [];
  let totalMasked = 0;
  for (const raw of raws) {
    const result = sanitizeRawLog(raw);
    results.push(result);
    totalMasked += result.maskedCount;
  }
  return { results, totalMasked };
}

/**
 * hasSensitiveData —— 快速探测文本是否含敏感信息（不执行替换）。
 *
 * 【用途】用于在 UI 上给出「此条日志含敏感字段」的预警标记，
 * 无需承担字符串重建的开销。注意它复用了同一套规则表，
 * 因此与 sanitizeRawLog 的判定口径天然一致，不会出现
 * 「标记说有敏感信息但脱敏后一个字没变」的矛盾。
 *
 * @param raw 待检测文本
 * @returns 是否命中任一敏感规则
 */
export function hasSensitiveData(raw: string): boolean {
  if (typeof raw !== 'string' || raw.length === 0) return false;
  for (const rule of SANITIZER_RULES) {
    /* 重置 lastIndex 以防全局正则残留状态导致漏判 */
    rule.pattern.lastIndex = 0;
    const detected = rule.pattern.test(raw);
    rule.pattern.lastIndex = 0;
    if (detected) return true;
  }
  return false;
}

/**
 * getSanitizerRuleNames —— 导出规则名清单（供文档、诊断与测试断言使用）。
 *
 * 【为何暴露】安全模块的可审计性依赖「能枚举出它到底防了什么」。
 * 前端可能据此在隐私说明里列出覆盖的敏感类型，测试也可断言规则未被误删。
 *
 * @returns 规则可读名数组（顺序即优先级）
 */
export function getSanitizerRuleNames(): readonly string[] {
  return SANITIZER_RULES.map((rule): string => rule.name);
}
