/**
 * KubeVision AI — 全站术语表与翻译五分法契约（R11 唯一权威事实源）
 *
 * 【五类术语分类法（A–E）】
 * - A 类（必须保留英文）：Kubernetes 核心资源、字段路径、CLI 命令、日志/错误码原文、
 *   与前后端/AI 工程协议名（如 kubectl、Pod、Deployment、Namespace、memory.max、
 *   oom_score_adj、--wait=false、NDJSON、SSE、MCP、BM25、RRF、TF-IDF、WebGPU、WASM）。
 * - B 类（首次双写、后续中文）：架构与平台概念首次出现采用「中文（English）」，
 *   同屏后续只写中文（如：命名空间（Namespace）、节点（Node）、控制平面（Control Plane））。
 * - C 类（必须汉化、绝不出现英文）：面向运维人员的 UI 动词、状态提示、错误/空态指引、
 *   模态副标题与按钮文案（如：立即执行自愈方案、请先勾选确认、崩溃重启、影响范围、网络分区）。
 * - D 类（保留英文并随行中文释义）：行业标准缩写初次呈现时随行解释
 *   （如：Pod（容器组）、QoS（服务质量等级）、SLO（服务等级目标）、QPS（每秒查询率））。
 * - E 类（本项目专有黑话禁译）：领域架构自创专名保持统一中文，禁止随意改写或回译英文
 *   （如：免疫窗口、幽灵透视、导演引擎、双擎、端侧）。
 *
 * 【硬性同屏原则】同一屏幕内同一概念严禁同时出现两种拼写或两套译名。
 */

/** 术语分类编码（A–E 五分法） */
export type GlossaryCategory = 'A' | 'B' | 'C' | 'D' | 'E';

/** 单条术语契约定义 */
export interface GlossaryTermEntry {
  /** 唯一词条键 */
  readonly key: string;
  /** 规范展示写法 */
  readonly canonical: string;
  /** 所属五分法类别 */
  readonly category: GlossaryCategory;
  /** 英文原词或缩写 */
  readonly english: string;
  /** 对应中文名称或释义 */
  readonly chinese: string;
  /** 同屏或文案中明确禁止的异形拼写 / 误译 */
  readonly forbiddenVariants: readonly string[];
  /** 使用边界与场景规则 */
  readonly usageRule: string;
  /** 工程与产品裁决依据 */
  readonly rationale: string;
}

/** R11 三条产品决策裁决记录 */
export interface ProductDecisionEntry {
  /** 决策编号 */
  readonly id: 'J1' | 'J2' | 'J3';
  /** 议题描述 */
  readonly question: string;
  /** 最终产品裁决 */
  readonly decision: string;
  /** 工程与可理解性依据 */
  readonly rationale: string;
}

/** 五分法分类元数据（供术语表只读 UI 分组渲染） */
export const GLOSSARY_CATEGORY_META: Readonly<
  Record<
    GlossaryCategory,
    {
      readonly code: GlossaryCategory;
      readonly title: string;
      readonly summary: string;
    }
  >
> = {
  A: {
    code: 'A',
    title: 'A 类 · 保留权威英文',
    summary: 'K8s 资源、字段、命令行参数、原生报错与工程协议保持官方英文写法',
  },
  B: {
    code: 'B',
    title: 'B 类 · 首次双写后续中文',
    summary: '首次呈现写作「中文（English）」，同屏后续只写中文以减少视觉噪音',
  },
  C: {
    code: 'C',
    title: 'C 类 · UI 必须全面汉化',
    summary: '所有交互按钮、面板标题、状态徽章、错误提示与空状态指引必须使用地道中文',
  },
  D: {
    code: 'D',
    title: 'D 类 · 保留缩写并随行释义',
    summary: '行业通用缩写保留英文主体，首次展示或术语表中随行给出中文释义',
  },
  E: {
    code: 'E',
    title: 'E 类 · 项目专有概念',
    summary: 'KubeVision 自研核心机制采用固定中文专名，禁止意译变形或回译英文',
  },
};

/**
 * PRODUCT_DECISIONS —— R11 三项核心产品与术语裁决（J1–J3）。
 */
export const PRODUCT_DECISIONS: readonly ProductDecisionEntry[] = [
  {
    id: 'J1',
    question: '是否将界面中的 Pod 全部汉化为“容器组”？',
    decision: '不强行替换；UI 主体统一使用精确大小写 Pod，术语表及首次科普标注为「Pod（容器组）」，严禁全大写 POD。',
    rationale:
      'Kubernetes 运维一线、kubectl 输出与故障手册均直接称呼 Pod；强行通篇改为“容器组”反而降低云原生工程师辨识度。保留首字母大写的 Pod 并在术语表注记「容器组」，兼顾专业性与初学者可读性；同时禁止全大写 POD 造成的视觉噪声。',
  },
  {
    id: 'J2',
    question: 'CrashLoopBackOff 与 OOMKilled 原生状态枚举是否进入中文 UI？',
    decision: '分场景使用：Pod 状态徽章、终端回执与原始事件保留官方状态值 OOMKilled / CrashLoopBackOff；按钮、正文叙述与演练标题一律使用中文（如「内存溢出」「崩溃重启」）。',
    rationale:
      '真实集群排查必须核对官方 Pod.status.reason 原值，隐藏枚举会失去排障锚点；但操作按钮与引导文案若直接堆砌英文枚举会破坏整站中文一致性和可行动性。因此状态值“只读锚定”、交互与解释“全部中文”。',
  },
  {
    id: 'J3',
    question: 'Runbook / SOP / 手册 / 剧本 四词如何明确切分？',
    decision: '四词严格分工：Runbook 专指知识库检索条目；SOP 专指条目内部的标准处置步骤；手册为知识库条目的中文统称；剧本仅指顶部全自动演示脚本。',
    rationale:
      '此前四词混用导致用户分不清“故障演练”（手动触发混沌场景）与“剧本路演”（四阶段全自动导演脚本），也分不清知识库条目与内部步骤。严格切分后，知识库沙盒谈 Runbook 与处置 SOP，演示控制谈故障演练与剧本路演，语义零歧义。',
  },
];

/**
 * TERMS —— 全站 34 条权威术语表（覆盖 A–E 全部分类与附录 A 全部核心词条）。
 */
export const TERMS: readonly GlossaryTermEntry[] = [
  {
    key: 'pod',
    canonical: 'Pod（容器组）',
    category: 'D',
    english: 'Pod',
    chinese: '容器组',
    forbiddenVariants: ['POD', 'pod 实体全大写'],
    usageRule: '界面与文本中统一首字母大写 Pod，术语表与科普处写「Pod（容器组）」，不得全大写 POD。',
    rationale: 'Kubernetes 最小调度与运维单元，运维人员直接以 Pod 识别，禁止全大写噪音。',
  },
  {
    key: 'deployment',
    canonical: 'Deployment',
    category: 'A',
    english: 'Deployment',
    chinese: '无状态部署控制器',
    forbiddenVariants: ['部署对象译名混用'],
    usageRule: '作为 K8s 资源类型名保留官方英文 Deployment。',
    rationale: '扩缩容 MCP 工具直接作用于 Deployment 资源，保留原名与 kubectl 保持一致。',
  },
  {
    key: 'namespace',
    canonical: '命名空间（Namespace）',
    category: 'B',
    english: 'Namespace',
    chinese: '命名空间',
    forbiddenVariants: ['NS 口语缩写做正文'],
    usageRule: '术语表与首处出现写作「命名空间（Namespace）」，表格列头与正文后续写「命名空间」。',
    rationale: '中文表意足够清晰，避免通篇 Namespace 堆叠。',
  },
  {
    key: 'node',
    canonical: '节点（Node）',
    category: 'B',
    english: 'Node',
    chinese: '节点',
    forbiddenVariants: ['工作机混称'],
    usageRule: '首处写作「节点（Node）」，后续统计与巡检标题统一写作「节点」。',
    rationale: '与 Node.status.conditions 状态模型一一对应。',
  },
  {
    key: 'control-plane',
    canonical: '控制平面（Control Plane）',
    category: 'B',
    english: 'Control Plane',
    chinese: '控制平面',
    forbiddenVariants: ['控制面', '主控机'],
    usageRule: '全站统一写作「控制平面」，严禁缩写为「控制面」。',
    rationale: '与 Kubernetes 1.24+ 官方中文文档保持一致，避免单屏出现「控制面/控制平面」混用。',
  },
  {
    key: 'api-server',
    canonical: 'API Server',
    category: 'A',
    english: 'API Server',
    chinese: '集群接口服务',
    forbiddenVariants: ['API-Server', 'API-SERVER', 'APIServer', 'ApiServer'],
    usageRule: '全站产品文案统一写「API Server」；仅 kube-apiserver 进程名或原始日志引述保留原串。',
    rationale: '此前全站存在五种拼写，收敛为单一官方空格写法「API Server」。',
  },
  {
    key: 'kubectl',
    canonical: 'kubectl',
    category: 'A',
    english: 'kubectl',
    chinese: '集群命令行工具',
    forbiddenVariants: ['Kubectl', 'KUBECTL'],
    usageRule: '命令行与回执命令块保持全小写 kubectl。',
    rationale: 'CLI 二进制文件名区分大小写，全小写确保工程师可直接复制执行。',
  },
  {
    key: 'cgroup',
    canonical: 'cgroup',
    category: 'A',
    english: 'cgroup',
    chinese: 'Linux 控制组',
    forbiddenVariants: ['Cgroup', 'CGROUP'],
    usageRule: '正文与标题统一小写 cgroup。',
    rationale: '遵循 Linux 内核 cgroup v2 文档标准小写规范。',
  },
  {
    key: 'memory-max',
    canonical: 'memory.max',
    category: 'A',
    english: 'memory.max',
    chinese: 'cgroup v2 内存硬上限文件',
    forbiddenVariants: ['内存上限文件名翻译'],
    usageRule: '涉及 cgroup v2 限额机制时保留 memory.max 与 oom_score_adj 原名。',
    rationale: '内核接口文件路径不得翻译，以便于排障核验。',
  },
  {
    key: 'wait-false',
    canonical: '--wait=false',
    category: 'A',
    english: '--wait=false',
    chinese: '异步下发标志',
    forbiddenVariants: ['异步参数汉化改写'],
    usageRule: 'kubectl delete / rollout 参数原样保留英文标志。',
    rationale: '命令参数必须逐字符可复现。',
  },
  {
    key: 'qos',
    canonical: 'QoS（服务质量等级）',
    category: 'D',
    english: 'QoS',
    chinese: '服务质量等级',
    forbiddenVariants: ['仅写 QOS 全大写无中文'],
    usageRule: '提及 Pod 驱逐优先级时写作「QoS（服务质量等级）」。',
    rationale: '说明 BestEffort / Burstable / Guaranteed 与 OOM 优先级的关系。',
  },
  {
    key: 'slo',
    canonical: 'SLO（服务等级目标）',
    category: 'D',
    english: 'SLO',
    chinese: '服务等级目标',
    forbiddenVariants: ['与 SLA 混称'],
    usageRule: '涉及响应延迟与可用性目标时写作「SLO（服务等级目标）」。',
    rationale: '区分内部工程可靠性目标与对外商务协议。',
  },
  {
    key: 'qps',
    canonical: 'QPS',
    category: 'D',
    english: 'QPS',
    chinese: '每秒查询率',
    forbiddenVariants: ['req/s', '次数/s'],
    usageRule: '吞吐单位全站统一写作「QPS」，严禁使用 req/s 或以 /s 充当 QPS 单位。',
    rationale: '消除顶栏 QPS 与后端回答 req/s 不一致的问题。',
  },
  {
    key: 'ndjson',
    canonical: 'NDJSON',
    category: 'A',
    english: 'NDJSON',
    chinese: '换行分隔 JSON 流协议',
    forbiddenVariants: ['行 JSON 混译'],
    usageRule: 'AI 诊断流式协议名统一写作 NDJSON。',
    rationale: '工程架构固定协议名，区分于遥测的 SSE 长连接。',
  },
  {
    key: 'sse',
    canonical: 'SSE',
    category: 'A',
    english: 'SSE',
    chinese: '服务端事件推送',
    forbiddenVariants: ['Server-Sent 事件混写'],
    usageRule: '遥测流通道名统一写作 SSE。',
    rationale: '与 EventSource 浏览器原生传输层标准一致。',
  },
  {
    key: 'mcp',
    canonical: 'MCP',
    category: 'A',
    english: 'MCP',
    chinese: '模型上下文协议',
    forbiddenVariants: ['工具网关随意改名'],
    usageRule: '自愈工具协议及回执前缀统一写 MCP（如「[MCP 执行回执]」）。',
    rationale: '体现标准化的只读查证与写动作工具调用规范。',
  },
  {
    key: 'bm25-rrf-tfidf',
    canonical: 'BM25 / RRF / TF-IDF',
    category: 'A',
    english: 'BM25 / RRF / TF-IDF',
    chinese: '稀疏检索 / 倒数秩融合 / 词频向量',
    forbiddenVariants: ['检索算法名音译'],
    usageRule: '检索算法缩写保持英文，在检索沙盒说明中配合中文原理注解。',
    rationale: '便于评委直接核对混合检索数学实现。',
  },
  {
    key: 'cni-vxlan-ipvs',
    canonical: 'CNI / VXLAN / IPVS / conntrack',
    category: 'A',
    english: 'CNI / VXLAN / IPVS / conntrack',
    chinese: '容器网络接口 / 隧道封装 / 内核负载均衡 / 连接跟踪表',
    forbiddenVariants: ['网络协议拼音或错拼'],
    usageRule: '网络层协议与内核子系统保持权威大小写。',
    rationale: '与网络分区场景根因链路严格对应。',
  },
  {
    key: 'ai-copilot',
    canonical: 'AI 运维副驾',
    category: 'C',
    english: 'AI Copilot',
    chinese: 'AI 运维副驾',
    forbiddenVariants: ['SRE Copilot', '智能副驾', 'AI Copilot 视图', 'Copilot 视图'],
    usageRule: '导航、抽屉页签与标题统一称「AI 运维副驾」，短称「副驾」。',
    rationale: '收敛此前页签、元信息、移动端拨片四套混杂叫法。',
  },
  {
    key: 'edge-auditor',
    canonical: '端侧日志审计',
    category: 'C',
    english: 'Edge Log Auditor',
    chinese: '端侧日志审计',
    forbiddenVariants: ['Edge Auditor', 'Edge Log Auditor 可见页签'],
    usageRule: '用户可见页签与命令面板统一写「端侧日志审计」；测试锚点通过 sr-only 隐藏节点保留。',
    rationale: '让评审与普通用户一眼读懂浏览器端侧脱敏与分类功能。',
  },
  {
    key: 'fault-drill',
    canonical: '故障演练',
    category: 'C',
    english: 'Fault Drill / Chaos Injection',
    chinese: '故障演练',
    forbiddenVariants: ['混沌演练混用指路演', 'CHAOS ACTIVE'],
    usageRule: '专指用户主动点选或从命令面板注入的混沌故障场景。',
    rationale: '与四阶段全自动的「剧本路演」严格区分职责边界。',
  },
  {
    key: 'demo-runbook-script',
    canonical: '剧本路演',
    category: 'C',
    english: 'Automated Script Walkthrough',
    chinese: '剧本路演',
    forbiddenVariants: ['RUNBOOK·自动演练', 'STAGE-00 / IDLE'],
    usageRule: '专指由导演引擎驱动的四阶段自动化演示脚本。',
    rationale: '避免与 Runbook 知识库条目及手动故障演练混淆。',
  },
  {
    key: 'runbook-sop-glossary',
    canonical: 'Runbook / SOP / 手册 / 剧本',
    category: 'C',
    english: 'Runbook / SOP',
    chinese: '知识库条目 / 标准处置步骤 / 排障手册 / 演示剧本',
    forbiddenVariants: ['将知识库条目称为剧本', '将自动路演标为 RUNBOOK'],
    usageRule: 'Runbook 指知识库单条文档；SOP 指条目内部处置步骤清单；手册为口语统称；剧本专指演示脚本。',
    rationale: '落实 J3 产品裁决，消除同屏语义冲突。',
  },
  {
    key: 'chaos-oom',
    canonical: 'OOM 内存溢出',
    category: 'C',
    english: 'POD_OOM_SWARM',
    chinese: 'OOM 内存溢出',
    forbiddenVariants: ['OOM 风暴', 'OOM 雪崩', '内存溢出雪崩', 'Pod OOM 集群性爆发'],
    usageRule: '六个混沌场景展示入口统一读 chaos.ts 常量「OOM 内存溢出」。',
    rationale: '此前同一场景存在四种叫法，现收敛为单一事实源。',
  },
  {
    key: 'chaos-cpu',
    canonical: '节点 CPU 饱和',
    category: 'C',
    english: 'NODE_CPU_SPIKE',
    chinese: '节点 CPU 饱和',
    forbiddenVariants: ['CPU 尖峰', 'CPU 尖刺', '节点 CPU 尖峰', '节点 CPU 尖刺', '计算节点算力打满'],
    usageRule: '六个混沌场景展示入口统一读 chaos.ts 常量「节点 CPU 饱和」。',
    rationale: '描述准确且全站一致，避免尖峰/尖刺/打满多词漂移。',
  },
  {
    key: 'chaos-net',
    canonical: 'CNI 网络分区丢包',
    category: 'C',
    english: 'NET_PACKET_LOSS',
    chinese: 'CNI 网络分区丢包',
    forbiddenVariants: ['网络丢包', 'CNI 网络丢包', '网络丢包分区', 'CNI 网络插件分区丢包'],
    usageRule: '六个混沌场景展示入口统一读 chaos.ts 常量「CNI 网络分区丢包」。',
    rationale: '明确指明故障层在 CNI 与分区丢包机理。',
  },
  {
    key: 'blast-radius',
    canonical: '影响范围',
    category: 'C',
    english: 'Impact Scope',
    chinese: '影响范围',
    forbiddenVariants: ['爆炸半径', '故障爆炸半径'],
    usageRule: '根因卡与复盘报告统一写作「故障影响范围」或「影响范围」，禁用直译词「爆炸半径」。',
    rationale: '中文工程表达更严谨克制，符合国内运维语言习惯。',
  },
  {
    key: 'network-partition',
    canonical: '网络分区',
    category: 'C',
    english: 'NetworkPartition',
    chinese: '网络分区',
    forbiddenVariants: ['脑裂'],
    usageRule: '对应状态枚举 NetworkPartition 一律译作「网络分区」，禁用误译「脑裂」。',
    rationale: 'Node 网络吞吐骤降失联属于网络分区，并不等同于分布式状态机双主脑裂。',
  },
  {
    key: 'ack-confirm-button',
    canonical: '请先勾选确认',
    category: 'C',
    english: 'Acknowledgement Required',
    chinese: '请先勾选确认',
    forbiddenVariants: ['需二次确认'],
    usageRule: '高危动作未勾选复选框时按钮提示「请先勾选确认」，勾选后为「立即执行自愈方案」。',
    rationale: '动词引导告诉用户如何解锁按钮，替代被动名词状态。',
  },
  {
    key: 'trace-metrics-ui',
    canonical: '链路追踪 / 词元 / 估算成本',
    category: 'C',
    english: 'TRACE / TOKENS / COST',
    chinese: '链路追踪 / 词元 / 估算成本',
    forbiddenVariants: ['TRACE', 'TOKENS', 'COST'],
    usageRule: '链路瀑布面板与回执徽章统一使用中文标签。',
    rationale: '消除卡片内生硬的全大写英文面板头。',
  },
  {
    key: 'immune-window',
    canonical: '免疫窗口',
    category: 'E',
    english: 'Immunity Window',
    chinese: '免疫窗口',
    forbiddenVariants: ['保护期', '冷却期', '屏蔽期'],
    usageRule: '本项目 SSE 状态收敛专有概念固定称「免疫窗口」，禁译换词。',
    rationale: '保持 3D 视口自愈确认与 SSE 合并机制的一致心智模型。',
  },
  {
    key: 'ghost-xray',
    canonical: '幽灵透视',
    category: 'E',
    english: 'Ghost X-Ray',
    chinese: '幽灵透视',
    forbiddenVariants: ['X 光模式', '半透模式'],
    usageRule: '状态过滤时将非匹配机架淡出的渲染模式固定称「幽灵透视」。',
    rationale: 'KubeVision 标志性可观测交互特性专名。',
  },
  {
    key: 'director-engine',
    canonical: '导演引擎',
    category: 'E',
    english: 'Demo Director Engine',
    chinese: '导演引擎',
    forbiddenVariants: ['编排器', '脚本播放器'],
    usageRule: '驱动四阶段全自动路演与旁白调度的状态机固定称「导演引擎」。',
    rationale: '精准表达跨视口、相机与副驾的时间线调度职责。',
  },
  {
    key: 'dual-engine-edge',
    canonical: '双擎 / 端侧',
    category: 'E',
    english: 'Dual-Engine / On-Device Edge',
    chinese: '双擎 / 端侧',
    forbiddenVariants: ['双引擎混译', '本地侧', '客户端侧'],
    usageRule: '「双擎」指云端大模型与确定性容灾引擎无缝切换；「端侧」指浏览器内 WebGPU / WASM 本地运行。',
    rationale: '统一项目核心技术叙事标识词。',
  },
];
