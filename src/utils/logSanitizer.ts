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
  /**
   * 按规则分类的命中计数（本轮新增，可选以保持向后兼容）。
   *
   * 【为何需要分类计数】汇总一个"共脱敏 5 处"对评审毫无说服力——
   * 到底拦住了什么？是 5 个内网 IP，还是 5 个 AWS 密钥？
   * 前者是信息卫生，后者是**阻止了一次凭证泄露**。
   * 分类计数让"零出域"从一句口号变成可核对的账目。
   *
   * 键为 SanitizerRule.name（如 'bearer-token' / 'cloud-access-key' / 'ipv4'），
   * 值为该规则本次命中的次数。
   */
  readonly maskedByRule?: Readonly<Record<string, number>>;
}

/**
 * SanitizerRule —— 单条脱敏规则的形状。
 *
 * 【为何把规则抽成数据表】脱敏是安全关键路径，规则应当**可枚举、可审计、
 * 可单测**。把正则散落在函数体里会让"到底覆盖了哪些敏感类型"这件事
 * 变得不可回答；抽成表后，新增一类敏感信息只是往表里加一项，
 * 且顺序即优先级，一眼可见。
 */
export interface SanitizerRule {
  /** 规则可读名（用于诊断与文档） */
  readonly name: string;
  /** 匹配模式（必须带 g 标志以支持全局替换与计数） */
  readonly pattern: RegExp;
  /** 替换为的语义化占位符 */
  readonly placeholder: string;
}

/* ========================================================================== */
/* 可配置化与 ReDoS 防护（Q6）                                                   */
/* ========================================================================== */

/** 单次脱敏允许处理的最大字符数（超出部分截断，防止超长输入放大回溯成本） */
export const MAX_SANITIZER_INPUT_CHARS = 65_536;

/** 单条规则的执行时间预算（毫秒）——超出后该规则会被禁用 */
export const CUSTOM_RULE_TIMEOUT_MS = 100;

/** 自定义规则条数上限（避免用户塞进一整套正则库拖慢每条日志） */
export const MAX_CUSTOM_RULES = 10;

/** 自定义正则的源码长度上限 */
export const MAX_RULE_PATTERN_LENGTH = 500;

/** 自定义规则 —— 用户/插件提供的额外脱敏规则 */
export interface CustomSanitizerRule {
  /** 规则可读名（必须唯一，用于分类计数与违规上报） */
  readonly name: string;
  /** 正则源码字符串（不接受已有 RegExp，避免跨 realm 的 lastIndex 污染） */
  readonly pattern: string;
  /** 替换为的占位符（可含 $1/$2 捕获组引用） */
  readonly placeholder: string;
}

/** 脱敏引擎的一次违规记录 */
export interface SanitizerViolation {
  /** 规则名 */
  readonly rule: string;
  /** 违规类型 */
  readonly kind:
    | 'invalid-pattern'
    | 'redos-suspect'
    | 'too-many-rules'
    | 'pattern-too-long'
    | 'rule-budget-exceeded'
    | 'input-truncated';
  /** 人类可读说明 */
  readonly detail: string;
}

/** 引擎选项 */
export interface SanitizerEngineOptions {
  /** 自定义规则（在内置规则之后执行） */
  readonly customRules?: readonly CustomSanitizerRule[];
  /** 输入长度上限，缺省 MAX_SANITIZER_INPUT_CHARS */
  readonly maxInputChars?: number;
  /** 单条规则时间预算，缺省 CUSTOM_RULE_TIMEOUT_MS */
  readonly ruleTimeoutMs?: number;
}

/**
 * looksLikeRedos —— 静态识别高危正则结构。
 *
 * 【为什么必须做静态检查】JavaScript 的正则在同一线程内**不可抢占**，
 * 一旦遇到灾难性回溯，任何"运行中熔断"都来不及生效（线程已被占住）。
 * 因此唯一可靠的第一道防线是**编译前拒绝**已知的危险结构：
 *
 * 1. 嵌套量词：`(a+)+` / `(a*)*` / `(?:\w+)++` —— 经典 ReDoS 形态；
 * 2. 带量词的分组内部存在歧义交替：`(a|aa)+`；
 * 3. 连续量词（`a**`、`a+?` 之外的 `a++` 等）在 JS 中本就非法，无需处理。
 *
 * 启发式无法覆盖所有 ReDoS，因此还有第二道防线（输入上限）与第三道
 * （时间预算 + 超预算禁用规则），三层叠加把风险压到可接受范围。
 *
 * @param source 正则源码
 * @returns 疑似 ReDoS 时返回 true
 */
function looksLikeRedos(source: string): boolean {
  /* 嵌套量词：分组内容里出现量词，分组本身又被量词修饰 */
  const nestedQuantifier = new RegExp(String.raw`\((?:\?:)?[^()]*[+*]\)[+*]`);
  /* 分组内歧义交替 + 外层量词 */
  const ambiguousAlternation = new RegExp(String.raw`\((?:\?:)?[^()]*\|[^()]*\)[+*]`);
  /* 量词出现在分组中段、外层再套量词 */
  const mixedNested = new RegExp(String.raw`\((?:\?:)?[^()]*[+*][^()]*\)[+*]`);

  return nestedQuantifier.test(source) || ambiguousAlternation.test(source) || mixedNested.test(source);
}
/**
 * buildCustomRules —— 校验并编译自定义规则。
 *
 * @param customRules 用户规则
 * @param violations 违规收集器（原地追加）
 * @returns 可执行规则数组
 */
function buildCustomRules(
  customRules: readonly CustomSanitizerRule[],
  violations: SanitizerViolation[],
): SanitizerRule[] {
  const compiled: SanitizerRule[] = [];

  if (customRules.length > MAX_CUSTOM_RULES) {
    violations.push({
      rule: '*',
      kind: 'too-many-rules',
      detail: `自定义规则 ${customRules.length} 条，超过上限 ${MAX_CUSTOM_RULES}；仅前 ${MAX_CUSTOM_RULES} 条生效`,
    });
  }

  for (const rule of customRules.slice(0, MAX_CUSTOM_RULES)) {
    if (rule.pattern.length > MAX_RULE_PATTERN_LENGTH) {
      violations.push({
        rule: rule.name,
        kind: 'pattern-too-long',
        detail: `正则长度 ${rule.pattern.length} 超过上限 ${MAX_RULE_PATTERN_LENGTH}`,
      });
      continue;
    }
    if (looksLikeRedos(rule.pattern)) {
      violations.push({
        rule: rule.name,
        kind: 'redos-suspect',
        detail: '检测到嵌套量词/歧义交替结构，已拒绝该规则',
      });
      continue;
    }
    try {
      /* 统一补 g 标志：替换与计数都依赖全局匹配；不保留用户的其他标志，避免 y/u 带来的行为差异 */
      compiled.push({ name: rule.name, pattern: new RegExp(rule.pattern, 'g'), placeholder: rule.placeholder });
    } catch {
      violations.push({
        rule: rule.name,
        kind: 'invalid-pattern',
        detail: '正则编译失败（语法错误）',
      });
    }
  }
  return compiled;
}

/** 脱敏引擎实例 */
export interface SanitizerEngine {
  /** 当前生效的规则（内置 + 通过校验的自定义规则） */
  readonly rules: readonly SanitizerRule[];
  /** 引擎构建期与运行期的违规记录（只增） */
  readonly violations: readonly SanitizerViolation[];
  /** 执行脱敏 */
  readonly sanitize: (raw: string) => SanitizeResult;
}

/**
 * createSanitizerEngine —— 构建带 ReDoS 防护的可配置脱敏引擎。
 *
 * 【三层防护】
 * 1. 静态拒绝高危正则（见 looksLikeRedos）；
 * 2. 输入长度上限（默认 64K 字符，超出截断并记违规）；
 * 3. 单规则 100ms 预算：超预算的规则被**永久禁用**（后续日志不再执行），
 *    并记录 rule-budget-exceeded。
 *
 * 【诚实边界】第 3 层无法中止**已经在跑**的那一次正则（JS 同步正则不可抢占），
 * 它保证的是"不重复付出代价"。真正彻底的方案是把自定义规则放进 Worker 并在
 * 100ms 后 terminate，本模块保留该扩展点。
 *
 * @param options 引擎选项
 * @returns 引擎实例
 */
export function createSanitizerEngine(options: SanitizerEngineOptions = {}): SanitizerEngine {
  const violations: SanitizerViolation[] = [];
  const customRules = buildCustomRules(options.customRules ?? [], violations);
  const disabledRules = new Set<string>();
  const maxInputChars = options.maxInputChars ?? MAX_SANITIZER_INPUT_CHARS;
  const ruleTimeoutMs = options.ruleTimeoutMs ?? CUSTOM_RULE_TIMEOUT_MS;

  const allRules: SanitizerRule[] = [...SANITIZER_RULES, ...customRules];

  const sanitize = (raw: string): SanitizeResult => {
    if (typeof raw !== 'string' || raw.length === 0) {
      return { sanitized: typeof raw === 'string' ? raw : '', maskedCount: 0 };
    }

    let input = raw;
    if (input.length > maxInputChars) {
      input = input.slice(0, maxInputChars);
      violations.push({
        rule: '*',
        kind: 'input-truncated',
        detail: `输入 ${raw.length} 字符超过上限 ${maxInputChars}，仅处理前 ${maxInputChars} 字符`,
      });
    }

    let sanitized = input;
    let maskedCount = 0;
    const maskedByRule: Record<string, number> = {};

    for (const rule of allRules) {
      if (disabledRules.has(rule.name)) continue;

      const startedAt = typeof performance !== 'undefined' ? performance.now() : Date.now();
      let ruleMasked = 0;
      sanitized = sanitized.replace(rule.pattern, (...args: unknown[]): string => {
        const match = String(args[0] ?? '');
        if (PLACEHOLDER_TEST.test(match)) return match;
        ruleMasked += 1;
        return rule.placeholder.replace(/\$(\d)/g, (_token, index: string): string => {
          const group = args[Number(index)];
          return group === undefined ? '' : String(group);
        });
      });
      const elapsed = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - startedAt;

      if (ruleMasked > 0) {
        maskedCount += ruleMasked;
        maskedByRule[rule.name] = (maskedByRule[rule.name] ?? 0) + ruleMasked;
      }

      /*
       * 时间预算：本轮已经跑完无法中止，但超预算规则从下一次开始禁用，
       * 避免每条日志都重复付出 100ms+ 的代价。
       */
      if (elapsed > ruleTimeoutMs) {
        disabledRules.add(rule.name);
        violations.push({
          rule: rule.name,
          kind: 'rule-budget-exceeded',
          detail: `单次执行 ${elapsed.toFixed(1)}ms 超过预算 ${ruleTimeoutMs}ms，该规则已禁用`,
        });
      }
    }

    return { sanitized, maskedCount, maskedByRule };
  };

  return { rules: allRules, violations, sanitize };
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
/**
 * 占位符识别 —— 幂等性的判据。
 *
 * 【为什么用宽松模式】占位符有四种：[REDACTED_IP] / [MASKED_TOKEN] /
 * [MASKED_KEY] / [REDACTED_EMAIL] / [REDACTED_CREDENTIAL] / [REDACTED_PASSWORD]。
 * 将来可能新增，因此只要形如 `[大写_大写]` 就视为已脱敏标记。
 */
const PLACEHOLDER_TEST = /\[(?:REDACTED|MASKED)_[A-Z_]+\]/;

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
    /**
     * 【B4 自愈：密码内的未转义 '@'】
     *
     * 旧正则用 `[^\s@/]+@` 匹配密码段，遇到密码含 '@'（如 `p@ssw0rd`）时
     * 只会吃到第一个 '@' 之前，结果：
     *   postgres://svc:p@ssw0rd@db.internal  →
     *   postgres://[REDACTED_CREDENTIAL]@ssw0rd@db.internal
     * 剩余 `ssw0rd@db.internal` 又被邮箱规则误伤成 [REDACTED_EMAIL]，
     * 文本结构被破坏、密码后半段是否泄露取决于后续规则——不可接受。
     *
     * 现在密码段改为 `[^\s/]+`（**包含 '@'**，贪婪），正则会自动回溯到
     * 最后一个能让整体成立的 '@'，也就是 host 之前的那个分隔符。
     */
    pattern: /\b([a-z][a-z0-9+.-]*):\/\/[^\s:/@]+:[^\s/]+@/gi,
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
    /**
     * 【B4 自愈：JSON 形态的带引号键名】
     *
     * `{"password": "hunter2"}` 里键名是 `"password"`，闭合引号出现在
     * 分隔符之前。旧正则要求键名后**立即**是 `\s*[=:]`，因此整个形态
     * 匹配失败（实测漏脱敏）。现在允许键名与分隔符之间出现一个可选引号。
     */
    pattern:
      /(?<![A-Za-z0-9])((?:[A-Za-z0-9_.-]*)(?:password|passwd|pwd|secret|passphrase))["']?\s*[=:]\s*["']?([^\s"',;}]{4,})/gi,
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
  /*
   * 按规则分类累计（本轮新增）。
   * 用普通对象累积，仅在确有命中时才写入键，避免返回一堆 0 值的噪音。
   */
  const maskedByRule: Record<string, number> = {};

  /*
   * 【B4 自愈：幂等的真正实现】
   *
   * 旧注释声称"占位符本身不匹配任何规则"，但 password-field 规则会再次
   * 命中 `db_password=[REDACTED_PASSWORD]`（值部分仍满足 {4,}），
   * 于是二次脱敏时 maskedCount 虚增 1——调用方重试一次，审计角标就多记一笔，
   * "共脱敏 N 处"这个对外数字就不可信了。
   *
   * 现在改为**回调式替换**：先看本次 match 是否已包含占位符，
   * 是则原样返回、不计数；否则展开 $1/$2 后替换并计数。
   */
  for (const rule of SANITIZER_RULES) {
    sanitized = sanitized.replace(rule.pattern, (...args: unknown[]): string => {
      const match = String(args[0] ?? '');
      /* 已含占位符 → 该处此前已脱敏，保持原样且不计数 */
      if (PLACEHOLDER_TEST.test(match)) return match;

      maskedCount += 1;
      maskedByRule[rule.name] = (maskedByRule[rule.name] ?? 0) + 1;

      /* 展开 $1/$2… 捕获组（captures 从 args[1] 开始） */
      return rule.placeholder.replace(/\$(\d)/g, (_token, index: string): string => {
        const group = args[Number(index)];
        return group === undefined ? '' : String(group);
      });
    });
  }

  return { sanitized, maskedCount, maskedByRule };
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
