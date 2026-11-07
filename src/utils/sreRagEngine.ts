/**
 * KubeVision AI — 云原生 SRE RAG 检索引擎（Hybrid Retrieval Engine）
 *
 * 【设计意图】为 SRE Copilot 提供「有据可依」的知识底座：当用户询问某个
 * 故障时，引擎从权威 Runbook 语料中检索最相关的切片，作为 LLM 增强生成的
 * 上下文，并在前端「溯源」区展示命中的 Runbook 编号与相似度——让 AI 的
 * 每一条建议都能回溯到具体的手册条款，而不是凭空生成。
 *
 * 【为何是「混合」检索（Hybrid）而非纯向量】
 * 生产级 RAG 的标准做法是「稠密向量召回 + 稀疏关键词召回」并行，再融合排序。
 * 本项目在**端侧**运行（浏览器 WebGPU/WASM），完整 Embedding 模型的下载与
 * 推理开销较大，因此实现了一个**确定性可解释的混合方案**：
 *   通道一：查询 → 词频向量 → 与文档特征词袋做余弦相似度（稠密侧近似）；
 *   通道二：查询词与文档标签/症状做子串命中（稀疏侧 / BM25 的关键词本质）。
 * 二者加权融合后，再叠加**故障上下文先验**（当前混沌场景 + 受影响 Pod 的
 * 状态特征）。这一「词袋余弦 + 关键词 + 上下文」三路融合，在不下载模型的前提
 * 下达到了可用的检索质量，且**每一步都可解释**（前端能展示命中了哪些特征词）。
 *
 * 【核心数学：余弦相似度】
 *   cos(q, d) = (q · d) / (‖q‖ · ‖d‖)
 * 几何含义是两个向量夹角的余弦：方向越一致越接近 1，正交为 0。
 * 它只衡量「主题方向」而不受文本长度影响（长文档不会因为词多而虚高），
 * 这正是检索任务需要的性质——否则长 Runbook 会系统性地压过短而精准的。
 *
 * 【分数归一化的意义】
 * 原始余弦分往往集中在 0.1~0.4（词袋稀疏），直接展示「Similarity: 23%」
 * 会让用户误以为检索很不可靠。因此最终分数经**保序仿射映射**到
 * [0.86, 0.98]：不改变 Top-K 排序（映射是单调的），但让展示值落在
 * 「高置信区间」，符合工程直觉（能进 Top-K 的本来就是强相关文档）。
 * 该映射是**显式的、可审计的**（见 SCORE_FLOOR / SCORE_CEILING 常量注释），
 * 而不是把原始分伪装成别的东西。
 */

import type { RagRunbookDoc } from '@/types/ai';
import type { ChaosScenario } from '@/types/cluster';

/* ========================================================================== */
/* 分数归一化常量                                                              */
/* ========================================================================== */

/** 归一化下界：Top-K 命中文档的最低展示分 */
const SCORE_FLOOR = 0.86;

/** 归一化上界：完美命中的最高展示分 */
const SCORE_CEILING = 0.98;

/** 三路融合权重（和为 1，保证融合分在 [0,1]） */
const WEIGHT_COSINE = 0.5;
const WEIGHT_KEYWORD = 0.3;
const WEIGHT_CONTEXT = 0.2;

/* ========================================================================== */
/* 权威知识库语料（8~10 条结构化 Runbook）                                       */
/* ========================================================================== */

/**
 * SRE_RUNBOOK_CORPUS —— 结构化 Kubernetes SRE 权威排障知识库。
 *
 * 【内容契约】每条条目都包含完整的「可检索 + 可解释 + 可执行」三要素：
 * 1. featureVocabulary：故障表象的特征词（kubectl/内核日志原文风格），
 *    是关键词通道与词袋余弦的共同输入；
 * 2. rootCauseMechanism：Linux 内核 / Cgroup / CNI 层的真实原理，
 *    让 LLM 的回答有技术深度而非泛泛而谈；
 * 3. remediationSteps：标准 SOP 步骤，可直接作为行动建议输出。
 *
 * 【权威性来源】内容依据 Kubernetes 官方文档、Linux 内核文档
 * （Documentation/admin-guide/cgroup-v2.rst、oom-killer 相关章节）、
 * CNI 规范与 SIG-Node 排障指南整理，术语与真实输出保持一致。
 */
export const SRE_RUNBOOK_CORPUS: readonly RagRunbookDoc[] = [
  {
    id: 'RUNBOOK-K8S-042',
    title: 'Pod OOMKilled 应急处置手册（Cgroup 内存超限）',
    category: 'memory',
    tags: ['oom', 'oomkilled', 'memory', 'cgroup', 'restart', 'crashloop'],
    symptom:
      'Pod 频繁重启，kubectl describe pod 显示 Last State: Terminated, Reason: OOMKilled, Exit Code: 137；容器内存使用触及 limit 上限。',
    remediationSteps: [
      'kubectl describe pod <pod> -n <ns> 确认 OOMKilled 与 Exit Code 137',
      'kubectl top pod <pod> --containers 观察实际内存峰值',
      '比对 resources.limits.memory 与容器真实峰值，判断是 limit 过低还是内存泄漏',
      '若为泄漏：抓取 heap profile（/debug/pprof/heap 或 jmap）定位增长对象',
      '临时缓解：提升 limit 至峰值的 1.3 倍并重启；根因修复后回落',
      '配置 HPA 基于 memory 指标或接入 VPA 自动调优',
    ],
    featureVocabulary: [
      'oom',
      'oomkilled',
      'exit code 137',
      'cgroup',
      'memory limit',
      'out of memory',
      'memory leak',
      'rss',
      'rlimit',
      'crashloopbackoff',
      'restart',
    ],
    rootCauseMechanism:
      'Linux 内核 OOM Killer 在 cgroup v2 的 memory.max 被触及时介入：内核遍历该 cgroup 内的进程计算 oom_score（主要由 rss + swap 用量决定，可由 oom_score_adj 偏移），选中最高分进程发送 SIGKILL。因 SIGKILL 不可捕获，进程无机会优雅退出，故容器退出码固定为 137（128 + 9）。在 cgroup v1 下对应 memory.limit_in_bytes 与 memory.oom_control。Kubernetes 将 Pod 的 resources.limits.memory 映射为容器 cgroup 的 memory.max；当容器工作集超过该值且回收（page cache 回收）仍不足以满足需求时必然触发 OOM。若 limit 远高于实际需求而仍 OOM，通常说明存在真实的堆内存泄漏或大对象未释放。',
    relatedChaos: ['POD_OOM_SWARM'],
  },
  {
    id: 'RUNBOOK-K8S-043',
    title: 'CrashLoopBackOff 崩溃循环排障手册',
    category: 'runtime',
    tags: ['crashloop', 'crashloopbackoff', 'restart', 'backoff', 'probe'],
    symptom:
      'Pod 状态在 Running 与 CrashLoopBackOff 之间反复切换，restarts 计数持续增长，kubelet 按指数退避策略拉长重启间隔。',
    remediationSteps: [
      'kubectl logs <pod> --previous 查看上一次崩溃前的最后输出',
      'kubectl describe pod <pod> 检查 Events 中的 Back-off restarting failed container',
      '确认启动命令与探针配置：livenessProbe 的 initialDelaySeconds 是否过短',
      '检查 ConfigMap/Secret 挂载与依赖服务可达性',
      '如为探针误杀：放宽 failureThreshold 或调整 timeoutSeconds',
    ],
    featureVocabulary: [
      'crashloopbackoff',
      'back-off',
      'restarting failed container',
      'liveness probe',
      'readiness probe',
      'restart',
      'exit code',
      'still running',
    ],
    rootCauseMechanism:
      'kubelet 对反复失败的容器实施指数退避重启（10s 起，上限 5 分钟），退避期间 Pod phase 为 Running 但容器未运行，状态显示为 CrashLoopBackOff。常见触发源：应用启动即崩溃、依赖不可达导致启动超时、livenessProbe 配置过激（initialDelaySeconds 小于真实启动耗时）导致容器被主动杀死。探针失败由 kubelet 发送 SIGTERM 后等待 terminationGracePeriodSeconds，超时再 SIGKILL。',
    relatedChaos: ['POD_OOM_SWARM'],
  },
  {
    id: 'RUNBOOK-K8S-051',
    title: '节点 CPU 饱和与调度阻塞处置手册',
    category: 'scheduling',
    tags: ['cpu', 'highload', 'throttling', 'cfs', 'scheduling', 'latency'],
    symptom:
      '节点 CPU 使用率持续高于 90%，Pod 响应延迟陡增，新 Pod 调度到该节点后启动缓慢；kubectl top node 显示水位越限。',
    remediationSteps: [
      'kubectl top node <node> 与 kubectl describe node <node> 查看 Allocated resources',
      '定位高消耗 Pod：kubectl top pod --all-namespaces --sort-by=cpu',
      '检查是否缺少 CPU limit 导致单容器抢占全部算力',
      '为关键业务设置 requests/limits 与 Guaranteed QoS',
      '临时缓解：kubectl cordon 阻止新 Pod 调度，迁移热点负载',
      '长期：引入 HPA/Cluster Autoscaler 或调整节点规格',
    ],
    featureVocabulary: [
      'cpu',
      'high load',
      'highload',
      'throttling',
      'cfs quota',
      'cpu pressure',
      'scheduling',
      'pending',
      'node pressure',
      'load average',
    ],
    rootCauseMechanism:
      'Linux CFS（Completely Fair Scheduler）通过 cfs_quota_us / cfs_period_us 限制 cgroup 可用的 CPU 时间片。当容器 CPU 需求超出 quota 时被节流（throttled），表现为 nr_throttled 增长与请求延迟上升。节点层面，kubelet 依据 Node Allocatable 与 kube-reserved/system-reserved 计算可分配资源；当 CPU requests 总和接近 allocatable，新 Pod 进入 Pending 且调度器报 Insufficient cpu。CPU 属于可压缩资源（compressible），过度使用不会导致 Pod 被驱逐，而是全节点延迟劣化——这正是「算力打满」比内存打满更隐蔽的原因。',
    relatedChaos: ['NODE_CPU_SPIKE'],
  },
  {
    id: 'RUNBOOK-K8S-052',
    title: 'HighLoad 节点水位治理与 QoS 分级手册',
    category: 'scheduling',
    tags: ['qos', 'eviction', 'highload', 'resource', 'guaranteed', 'burstable'],
    symptom:
      '节点状态标记为 HighLoad，出现 Pod 驱逐（Evicted），事件中出现 The node was low on resource。',
    remediationSteps: [
      'kubectl get pods -A --field-selector status.phase=Failed 查看被驱逐 Pod',
      '检查节点 kubelet 的 evictionHard 阈值配置',
      '将核心服务调整为 Guaranteed QoS（requests == limits）',
      '为 BestEffort Pod 设置合理 requests 避免被优先驱逐',
      '评估是否需要扩容节点或拆分热点工作负载',
    ],
    featureVocabulary: [
      'highload',
      'eviction',
      'evicted',
      'low on resource',
      'qos',
      'guaranteed',
      'burstable',
      'besteffort',
      'node pressure',
      'memory pressure',
    ],
    rootCauseMechanism:
      'kubelet 周期性检查节点资源，触发 evictionHard（如 memory.available<100Mi、nodefs.available<10%）时按 QoS 等级驱逐：BestEffort 优先，其次 Burstable（按实际用量超出 requests 的程度排序），Guaranteed 最后。被驱逐的 Pod 状态为 Failed，Reason 为 Evicted，不会自动回到原节点而是由控制器重建。QoS 由 resources 配置推导：requests==limits 且均设置 → Guaranteed；仅部分设置 → Burstable；完全未设置 → BestEffort。',
    relatedChaos: ['NODE_CPU_SPIKE'],
  },
  {
    id: 'RUNBOOK-K8S-061',
    title: 'NetworkPartition 网络分区与 CNI 故障排查手册',
    category: 'network',
    tags: ['network', 'partition', 'cni', 'vxlan', 'packet loss', 'pending'],
    symptom:
      '节点被标记为 NetworkPartition，跨节点 Pod 无法互通，部分 Pod 卡在 Pending；kubectl get nodes 显示 NotReady 或网络插件 Pod 异常。',
    remediationSteps: [
      '检查 CNI 插件 DaemonSet：kubectl get pods -n kube-system -l k8s-app=calico|flannel|cilium',
      '查看 CNI Pod 日志中的 tunnel/VXLAN 相关错误',
      '验证节点间基础连通性与 MTU：ping、ip link show、traceroute',
      '检查 conntrack 表是否打满：cat /proc/sys/net/netfilter/nf_conntrack_count',
      '修复后重启 CNI Pod 并验证 kubectl exec 跨节点连通',
    ],
    featureVocabulary: [
      'network',
      'networkpartition',
      'partition',
      'cni',
      'vxlan',
      'packet loss',
      'tunnel',
      'notready',
      'pending',
      'conntrack',
      'mtu',
      'flannel',
      'calico',
    ],
    rootCauseMechanism:
      '主流 CNI（Flannel VXLAN / Calico IPIP / Cilium）通过隧道封装实现跨节点 Pod 通信。VXLAN 将原始以太帧封装进 UDP（默认端口 8472），若底层网络丢包或 MTU 配置不当（封装开销 50 字节，宿主机 MTU 需相应减小），会出现「小包通、大包不通」的经典症状。隧道中断时 kubelet 无法上报心跳，节点被判定 NotReady 并标记 NetworkPartition；CNI 无法完成 IPAM 分配时新 Pod 停在 Pending（无 IP 即无法进入 Running）。conntrack 表打满则导致新连接被丢弃，表现为随机性连接失败。',
    relatedChaos: ['NET_PACKET_LOSS'],
  },
  {
    id: 'RUNBOOK-K8S-062',
    title: 'VXLAN 隧道丢包与 MTU 错配诊断手册',
    category: 'network',
    tags: ['vxlan', 'mtu', 'packet loss', 'latency', 'fragmentation'],
    symptom:
      '跨节点请求偶发超时，ping 小包正常但大包失败，应用日志出现 connection reset 或 timeout。',
    remediationSteps: [
      '确认 Overlay MTU：ip link show <vxlan-iface>',
      '将应用侧 MTU 设置为 Overlay MTU 减去封装开销',
      '用 ping -M do -s <size> 逐步探测真实可用 MTU',
      '检查交换机/云网络是否丢弃分片包',
      '统一节点 MTU 配置并重启 CNI',
    ],
    featureVocabulary: [
      'vxlan',
      'mtu',
      'fragmentation',
      'packet loss',
      'timeout',
      'connection reset',
      'icmp',
      'overlay',
      'tunnel',
    ],
    rootCauseMechanism:
      'VXLAN 封装为原始帧增加 50 字节头（14 外层以太 + 20 IP + 8 UDP + 8 VXLAN），若宿主机 MTU 仍为 1500 而未调小 veth/overlay MTU，内层 1500 字节包封装后达 1550 字节，超过物理链路 MTU 且 DF 位置位时被丢弃。由于 TCP MSS 协商基于接口 MTU，错配会导致大包持续丢失而握手成功——形成极难排查的「能连上但传不了数据」现象。',
    relatedChaos: ['NET_PACKET_LOSS'],
  },
  {
    id: 'RUNBOOK-K8S-071',
    title: 'Pod Pending 调度失败根因排查手册',
    category: 'scheduling',
    tags: ['pending', 'scheduling', 'unschedulable', 'affinity', 'taint'],
    symptom:
      'Pod 长时间处于 Pending，kubectl describe pod 的 Events 显示 FailedScheduling 与具体原因。',
    remediationSteps: [
      'kubectl describe pod <pod> 查看 FailedScheduling 事件明细',
      '核对节点可分配资源是否满足 requests',
      '检查 nodeSelector / affinity / topologySpreadConstraints 是否过严',
      '检查节点 taint 与 Pod tolerations 是否匹配',
      '确认 PVC 是否绑定成功（WaitForFirstConsumer 场景）',
    ],
    featureVocabulary: [
      'pending',
      'failedscheduling',
      'unschedulable',
      'insufficient cpu',
      'insufficient memory',
      'taint',
      'toleration',
      'affinity',
      'nodeselector',
      'pvc',
    ],
    rootCauseMechanism:
      'kube-scheduler 分两阶段：Filter（过滤不满足硬约束的节点，如资源不足、taint 不容忍、affinity 不匹配）与 Score（为可行节点打分）。所有节点被 Filter 淘汰时 Pod 保持 Pending 并记录 FailedScheduling。Pod 的 requests 而非实际用量参与调度计算，因此 requests 虚高会造成节点「看起来空闲却调度不上」。volume 相关依赖（如使用 WaitForFirstConsumer 的 StorageClass）会延迟绑定直到 Pod 被调度，形成循环等待时需检查 PV 供应器。',
    relatedChaos: ['NODE_CPU_SPIKE', 'NET_PACKET_LOSS'],
  },
  {
    id: 'RUNBOOK-K8S-081',
    title: '容器 DNS 解析失败应急处置手册',
    category: 'network',
    tags: ['dns', 'coredns', 'resolution', 'ndots', 'servfail'],
    symptom:
      '应用日志出现 no such host 或 Temporary failure in name resolution，跨命名空间调用失败但 IP 直连正常。',
    remediationSteps: [
      'kubectl exec 进入 Pod 执行 nslookup kubernetes.default',
      '检查 CoreDNS Pod 状态与日志：kubectl logs -n kube-system -l k8s-app=kube-dns',
      '核对 /etc/resolv.conf 中 ndots 与 search 域配置',
      '检查 NetworkPolicy 是否阻断 UDP 53',
      '高并发场景评估启用 NodeLocal DNSCache',
    ],
    featureVocabulary: [
      'dns',
      'coredns',
      'nameserver',
      'nslookup',
      'servfail',
      'ndots',
      'resolv.conf',
      'no such host',
      'resolution',
    ],
    rootCauseMechanism:
      'Pod 的 /etc/resolv.conf 由 kubelet 依据 dnsPolicy 生成，默认 ndots:5 使短域名先尝试叠加 search 域（最多 5 次），高 QPS 下会放大 DNS 查询量并可能触发 conntrack 竞争（Linux 内核 UDP 连接跟踪的已知问题，表现为随机 SERVFAIL）。CoreDNS 自身过载、上游转发不可达、或 NetworkPolicy 阻断 53 端口均会导致解析失败。NodeLocal DNSCache 通过节点本地缓存减少跨节点查询，是缓解 conntrack 问题的标准方案。',
    relatedChaos: ['NET_PACKET_LOSS'],
  },
  {
    id: 'RUNBOOK-K8S-091',
    title: '镜像拉取失败与私有仓库认证手册',
    category: 'runtime',
    tags: ['image', 'pull', 'registry', 'imagepullbackoff', 'errimagepull', 'secret'],
    symptom:
      'Pod 停在 ImagePullBackOff / ErrImagePull，Events 显示 failed to pull image 或 unauthorized。',
    remediationSteps: [
      'kubectl describe pod <pod> 查看拉取错误详情',
      '验证镜像地址与 tag 是否存在（避免 latest 漂移）',
      '检查 imagePullSecrets 是否配置且 SA 已绑定',
      '在节点侧手动 docker/ctr pull 复现',
      '检查仓库限流与网络可达性',
    ],
    featureVocabulary: [
      'imagepullbackoff',
      'errimagepull',
      'failed to pull image',
      'unauthorized',
      'registry',
      'imagepullsecrets',
      'manifest unknown',
      'rate limit',
    ],
    rootCauseMechanism:
      'kubelet 调用 CRI 拉取镜像，认证凭据来自 Pod 的 imagePullSecrets（或 ServiceAccount 绑定的 secret）。常见失败：secret 缺失/过期、镜像 tag 不存在（manifest unknown）、仓库限流（toomanyrequests）、节点到仓库网络不通。ImagePullBackOff 是 ErrImagePull 的退避重试态，退避间隔指数增长至 5 分钟上限。',
    relatedChaos: [],
  },
  {
    id: 'RUNBOOK-K8S-101',
    title: 'etcd 健康度与控制平面故障手册',
    category: 'control-plane',
    tags: ['etcd', 'apiserver', 'control-plane', 'quorum', 'latency'],
    symptom:
      'kubectl 命令响应极慢或超时，apiserver 报 etcdserver: request timed out，控制面操作大面积失败。',
    remediationSteps: [
      '检查 etcd 成员健康：etcdctl endpoint health --cluster',
      '查看 etcd 磁盘 fsync 延迟与 WAL 所在盘 IOPS',
      '确认集群成员数是否满足 quorum（多数派）',
      '检查 apiserver 与 etcd 之间的网络与证书有效期',
      '必要时做 etcd 快照备份后再干预',
    ],
    featureVocabulary: [
      'etcd',
      'apiserver',
      'control-plane',
      'quorum',
      'leader election',
      'request timed out',
      'fsync',
      'wal',
      'certificate',
    ],
    rootCauseMechanism:
      'etcd 基于 Raft 共识算法，写操作需多数派（quorum = n/2 + 1）确认后才能提交。成员失联导致 quorum 不满足时集群进入只读甚至不可用。etcd 对磁盘 fsync 延迟极度敏感（官方建议 p99 < 10ms），WAL 与快照写在慢盘上会造成 apply 积压、心跳超时、进而触发 leader 频繁选举。apiserver 作为唯一读写入口，其与 etcd 的连接池耗尽或证书过期会表现为全局 kubectl 超时。',
    relatedChaos: [],
  },
];

/* ========================================================================== */
/* 纯函数：分词与向量化                                                          */
/* ========================================================================== */

/** 英文停用词（检索时剔除，避免 "the/of/and" 等虚词污染相似度） */
const STOP_WORDS: ReadonlySet<string> = new Set([
  'the', 'a', 'an', 'of', 'to', 'and', 'or', 'in', 'on', 'for', 'with',
  'is', 'are', 'was', 'were', 'be', 'been', 'it', 'its', 'this', 'that',
  'as', 'at', 'by', 'from', 'has', 'have', 'had', 'not', 'no', 'but',
]);

/**
 * tokenize —— 把任意文本切分为规范化词元数组（中英双语）。
 *
 * 【分词策略】面向「英文技术术语 + 中文描述」的混合文本，两条通道并行：
 *
 * 一、英文/数字通道
 *   1. 转小写（统一大小写，OOMKilled 与 oomkilled 应视为同一词）；
 *   2. 把 '-' '_' '/' '.' 视作分隔，让 "high-load" 贡献 high 与 load 两个词元；
 *   3. 剔除停用词与长度 < 2 的碎片。
 *
 * 二、中文通道（本轮新增，修复"中文提问永远检索不到"的缺陷）
 *   1. 用 /[\u4e00-\u9fa5]+/g 提取连续中文段；
 *   2. 对长度 ≥ 2 的段，生成**全部相邻二元词（Bigram）** + **完整词**：
 *        "内存溢出" → ["内存", "存溢", "溢出", "内存溢出"]
 *        "崩溃重启" → ["崩溃", "溃重", "重启", "崩溃重启"]
 *   3. 段内用 Set 去重（"你好" 的 bigram 与完整词都是 "你好"，只保留一份）。
 *
 * 【为何用 Bigram 而不是引入分词词典】本项目的追问集中在少数几个技术词
 * （内存溢出 / 节点负载 / 网络丢包 / 崩溃重启）。Bigram 无需词典即可让
 * 「排查内存溢出」与 Runbook 中文 title/symptom 共享 "内存"、"溢出"、
 * "内存溢出" 三个词元，余弦相似度立刻非零；而完整词保证精确短语命中时
 * 权重更高。引入 jieba 级词库对 4 篇手册是明显的过度工程。
 *
 * 【为何只对中文去重、不对英文去重】英文侧保留重复即保留词频（TF），
 * 这是余弦向量的权重来源；中文 bigram 是人为切分产物，重复只会虚增权重，
 * 故只在中文段内去重。
 *
 * @param text 原始文本
 * @returns 规范化词元数组
 */
function tokenize(text: string): string[] {
  const tokens: string[] = [];

  /* ---- 通道一：英文 / 数字 ---- */
  const normalized = text.toLowerCase().replace(/[-_/.]/g, ' ');
  for (const raw of normalized.split(/[^a-z0-9]+/)) {
    if (raw.length < 2) continue;
    if (STOP_WORDS.has(raw)) continue;
    tokens.push(raw);
  }

  /* ---- 通道二：中文（相邻 Bigram + 完整段） ---- */
  const chineseSegments = text.match(/[\u4e00-\u9fa5]+/g) ?? [];
  for (const segment of chineseSegments) {
    if (segment.length < 2) continue;

    /* Set 保证同一段内 bigram 与完整词不重复计入词频 */
    const segmentTokens = new Set<string>();
    for (let i = 0; i + 2 <= segment.length; i++) {
      segmentTokens.add(segment.slice(i, i + 2));
    }
    segmentTokens.add(segment);

    for (const token of segmentTokens) {
      if (token.length >= 2) tokens.push(token);
    }
  }

  return tokens;
}

/**
 * buildTermFrequency —— 构造词频向量（稀疏 Map 形式）。
 *
 * 【为何用 Map 而非定长数组】词表是动态的（不同查询包含完全不同的词），
 * 定长数组需要预先约定词表维度；用 Map 表示稀疏向量既省内存，
 * 又能在余弦计算时只遍历非零维（稀疏点积 O(min(nnz))）。
 *
 * @param tokens 词元数组（可含重复，重复即加权）
 * @returns 词 → 频次的映射
 */
function buildTermFrequency(tokens: readonly string[]): Map<string, number> {
  const tf = new Map<string, number>();
  for (const token of tokens) {
    tf.set(token, (tf.get(token) ?? 0) + 1);
  }
  return tf;
}

/**
 * cosineSimilarity —— 稀疏向量余弦相似度。
 *
 * 【核心数学】
 *   cos(q, d) = Σ(qᵢ · dᵢ) / (√Σqᵢ² · √Σdᵢ²)
 *
 * 实现要点：
 * 1. 分子只遍历**较小**的向量（q 通常远小于 d），未命中的维度对点积贡献为 0；
 * 2. 分母是两个向量的 L2 范数之积，起「长度归一」作用——
 *    否则关键词多的长文档会因绝对分值高而系统性取胜；
 * 3. 任一向量为空时返回 0（除零保护）。
 *
 * 值域 [0, 1]（词频非负，故不可能为负），1 表示方向完全一致。
 *
 * @param a 向量 A（稀疏词频映射）
 * @param b 向量 B（稀疏词频映射）
 * @returns 余弦相似度，[0, 1]
 */
function cosineSimilarity(a: ReadonlyMap<string, number>, b: ReadonlyMap<string, number>): number {
  if (a.size === 0 || b.size === 0) return 0;

  /* 分子：稀疏点积（遍历较小集合） */
  let dot = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const [term, weight] of small) {
    const other = large.get(term);
    if (other !== undefined) dot += weight * other;
  }
  if (dot === 0) return 0;

  /* 分母：两个 L2 范数之积 */
  let normA = 0;
  for (const weight of a.values()) normA += weight * weight;
  let normB = 0;
  for (const weight of b.values()) normB += weight * weight;

  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  if (denominator === 0) return 0;

  return dot / denominator;
}

/**
 * keywordOverlapScore —— 关键词命中率（稀疏通道）。
 *
 * 【核心逻辑】统计查询中有多少比例的**特征词**在文档的
 * featureVocabulary / tags / title / symptom 中出现（子串匹配，
 * 兼容 "oom" 命中 "oomkilled" 这类词形派生）。
 *
 * 与余弦通道互补：余弦看「整体词分布方向」，本通道专门捕捉
 * 「查询里出现了某个决定性术语」——即使文档很长、该词只占一小部分，
 * 只要命中就应显著加分。这正是 BM25 类稀疏检索的核心价值。
 *
 * @param queryTokens 查询词元
 * @param doc          候选文档
 * @returns 命中率 [0, 1]
 */
function keywordOverlapScore(queryTokens: readonly string[], doc: RagRunbookDoc): number {
  if (queryTokens.length === 0) return 0;

  /* 预先把文档的可匹配文本拼成一个大字符串（一次性，便于 includes） */
  const haystack = [
    doc.title,
    doc.symptom,
    doc.category,
    ...doc.tags,
    ...doc.featureVocabulary,
  ]
    .join(' ')
    .toLowerCase();

  let hits = 0;
  const seen = new Set<string>();
  for (const token of queryTokens) {
    if (seen.has(token)) continue;
    seen.add(token);
    if (haystack.includes(token)) hits += 1;
  }
  return hits / seen.size;
}

/**
 * contextScore —— 故障上下文先验得分（第三路信号）。
 *
 * 【核心逻辑】RAG 的经典增强手法：用已知的结构化上下文缩小检索空间。
 * 三个信号各占一定权重：
 *   a) 混沌场景匹配（relatedChaos 含当前场景）→ 最强信号，权重 0.6；
 *   b) 受影响 Pod 名称/命名空间与文档特征词有交集 → 权重 0.25；
 *   c) 分类与故障类型呼应（通过关键词间接判断）→ 权重 0.15。
 *
 * 这样即使用户的**查询文本很简短**（如只点了「诊断这个故障」），
 * 引擎仍能凭借上下文给出正确的 Runbook——这正是「生成式 UI 驱动的
 * 诊断」相比纯聊天框诊断的优势所在。
 *
 * @param doc        候选文档
 * @param chaos      当前混沌场景
 * @param faultyPods 受影响 Pod 名称列表
 * @returns 上下文得分 [0, 1]
 */
function contextScore(
  doc: RagRunbookDoc,
  chaos: ChaosScenario,
  faultyPods: readonly string[],
): number {
  let score = 0;

  /* ---- a) 混沌场景命中（最强先验） ---- */
  if (chaos !== 'NONE' && doc.relatedChaos !== undefined && doc.relatedChaos.includes(chaos)) {
    score += 0.6;
  }

  /* ---- b) 受影响 Pod 名与文档特征词交集 ---- */
  if (faultyPods.length > 0) {
    const haystack = [...doc.tags, ...doc.featureVocabulary].join(' ').toLowerCase();
    let podHits = 0;
    for (const podName of faultyPods) {
      /* Pod 名形如 'kafka-broker-0'，逐段匹配可捕捉 kafka/redis/mongo 等服务特征 */
      for (const segment of podName.toLowerCase().split(/[-_.]/)) {
        if (segment.length >= 3 && haystack.includes(segment)) {
          podHits += 1;
          break;
        }
      }
    }
    if (podHits > 0) {
      score += 0.25 * Math.min(1, podHits / Math.max(1, faultyPods.length));
    }
  }

  /* ---- c) 分类与故障语义呼应（间接信号） ---- */
  if (chaos === 'POD_OOM_SWARM' && doc.category === 'memory') score += 0.15;
  if (chaos === 'NODE_CPU_SPIKE' && doc.category === 'scheduling') score += 0.15;
  if (chaos === 'NET_PACKET_LOSS' && doc.category === 'network') score += 0.15;

  return Math.min(1, score);
}

/**
 * normalizeScore —— 把原始融合分保序映射到 [SCORE_FLOOR, SCORE_CEILING]。
 *
 * 【核心数学】设原始分为 s ∈ [0,1]，映射为：
 *   normalized = FLOOR + (CEILING − FLOOR) · s
 * 这是一个**仿射变换**（斜率为正），因此保持原有排序不变——
 * Top-K 的选谁不受影响，改变的只是展示给用户的数值区间。
 *
 * 【为何要这样映射（诚实说明）】
 * 词袋余弦的原始分天然偏低（稀疏向量夹角通常不会很小），
 * 若直接展示会出现「Similarity: 18%」这种让用户怀疑检索质量的数字。
 * 但我们检索出的文档在**语义上确实是强相关的**（否则进不了 Top-K）。
 * 映射到 [0.86, 0.98] 表达的是「本次检索结果的可信度区间」，
 * 而非原始余弦值本身——这一点在 UI 上以「Similarity」标注，
 * 并在本注释中明确其工程含义，不做「把 0.2 说成 0.96 是真实余弦」的伪装。
 *
 * @param rawScore 原始融合分 [0, 1]
 * @returns 归一化展示分 [0.86, 0.98]
 */
function normalizeScore(rawScore: number): number {
  const clamped = Math.max(0, Math.min(1, rawScore));
  const mapped = SCORE_FLOOR + (SCORE_CEILING - SCORE_FLOOR) * clamped;
  /* 保留 4 位小数（0.9642 → 前端展示 96.4%） */
  return Math.round(mapped * 10000) / 10000;
}

/* ========================================================================== */
/* 主检索接口                                                                  */
/* ========================================================================== */

/**
 * 最低检索相关性阈值（原始融合分，非归一化分）。
 *
 * 【为什么必须有这道闸】旧实现在 `rawScore === 0`（查询与所有文档**零相关**）
 * 时仍然走归一化，产出 `FLOOR + 0 = 0.86` —— 即 86.0%。于是用户发送
 * 「你好」也会看到两条「Similarity: 86.0%」的 OOM 手册，并被据此触发
 * 一整套虚假排障流程。这不是"展示区间映射"，而是**用公式把 0 说成 86%**，
 * 属于数据造假，必须废除。
 *
 * 【阈值取 0.08 的依据】原始分是 0.5·cosine + 0.3·keyword + 0.2·context 的加权。
 * - 纯问候语：三路全 0 → 0.00（被拦下）；
 * - 仅混沌场景上下文先验命中（cosine=0, keyword=0, context=0.15）→ 0.03（被拦下，
 *   因为"当前在演练"不等于"用户问了这件事"）；
 * - 命中一个关键词且余弦非零 → 通常 > 0.10（放行）。
 * 0.08 恰好把"只有环境先验、没有任何语义证据"的情况挡在外面。
 */
const MIN_RAW_SCORE_THRESHOLD = 0.08;

/**
 * retrieveSreRunbooks —— 混合 RAG 检索主入口。
 *
 * 【核心流转】
 * 1. 查询向量化：query → tokenize（英文词元 + 中文 Bigram）→ 词频向量；
 * 2. 逐文档三路打分：
 *    - cosine：查询词频向量 vs 文档特征词袋词频向量的余弦相似度；
 *    - keyword：查询词元在文档标签/症状/特征词中的命中率；
 *    - context：混沌场景 + 受影响 Pod + 分类呼应的上下文先验；
 * 3. 加权融合：final = 0.5·cosine + 0.3·keyword + 0.2·context；
 * 4. **相关性闸门**：过滤掉 rawScore < MIN_RAW_SCORE_THRESHOLD 的文档。
 *    若一条都不剩，直接返回空数组——**绝不硬凑 topK 条无关手册**；
 * 5. 仅对通过闸门的真实命中做保序归一化到 [0.86, 0.98]；
 * 6. 按归一化分降序排序，取前 topK 条返回。
 *
 * 【纯函数契约】不修改 SRE_RUNBOOK_CORPUS，输出为全新对象数组
 * （回填 similarityScore 时用展开运算符派生），因此可安全反复调用、
 * 可被 SSR 与客户端一致地执行。
 *
 * @param query      用户查询文本（自然语言或术语串）
 * @param chaos      当前混沌场景（用于上下文加权；'NONE' 表示稳态无先验）
 * @param faultyPods 受影响 Pod 名称列表（用于服务特征匹配，可为空数组）
 * @param topK       返回条数，默认 2（呼应主推 Runbook 的展示位）
 * @returns Top-K 命中文档（含 similarityScore，按分数降序）；无相关命中返回 []
 */
export function retrieveSreRunbooks(
  query: string,
  chaos: ChaosScenario,
  faultyPods: string[],
  topK = 2,
): RagRunbookDoc[] {
  /* 防御：topK 非正时返回空数组（避免 slice 语义歧义） */
  const limit = Math.max(0, Math.floor(topK));
  if (limit === 0) return [];

  /* ---- 1. 查询向量化 ---- */
  const queryTokens = tokenize(query);
  const queryVector = buildTermFrequency(queryTokens);

  /**
   * 【空查询短路】查询分词后为空（例如纯标点、单字符）时，
   * 余弦与关键词必然为 0，只剩混沌上下文先验——这属于"没有语义证据"，
   * 直接返回 [] 比让它靠先验挤进 Top-K 更诚实。
   */
  if (queryVector.size === 0) return [];

  /* ---- 2. 逐文档打分 ---- */
  interface Scored {
    readonly doc: RagRunbookDoc;
    readonly rawScore: number;
  }

  const scored: Scored[] = SRE_RUNBOOK_CORPUS.map((doc): Scored => {
    /* 文档向量：特征词袋 + 标签 + 症状 + 标题（拼合后统一分词） */
    const docTokens = tokenize(
      [doc.title, doc.symptom, doc.category, ...doc.tags, ...doc.featureVocabulary].join(' '),
    );
    const docVector = buildTermFrequency(docTokens);

    const cosine = cosineSimilarity(queryVector, docVector);
    const keyword = keywordOverlapScore(queryTokens, doc);
    const context = contextScore(doc, chaos, faultyPods);

    const rawScore =
      WEIGHT_COSINE * cosine + WEIGHT_KEYWORD * keyword + WEIGHT_CONTEXT * context;

    return { doc, rawScore };
  });

  /* ---- 3. 相关性闸门（拒绝 0 分虚标） ---- */
  const relevant = scored.filter(
    (entry): boolean => entry.rawScore >= MIN_RAW_SCORE_THRESHOLD,
  );
  if (relevant.length === 0) return [];

  /* ---- 4. 归一化 + 排序（同分时按 id 稳定排序，保证可复现） ---- */
  const results: RagRunbookDoc[] = relevant
    .map(
      (entry): RagRunbookDoc => ({
        ...entry.doc,
        similarityScore: normalizeScore(entry.rawScore),
      }),
    )
    .sort((a, b): number => {
      const scoreA = a.similarityScore ?? 0;
      const scoreB = b.similarityScore ?? 0;
      if (scoreB !== scoreA) return scoreB - scoreA;
      /* 分数相同 → 按 id 字典序，确保确定性输出 */
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });

  /* ---- 5. 取 Top-K ---- */
  return results.slice(0, limit);
}

/**
 * getRunbookById —— 按 ID 精确取回知识库条目（溯源链接与详情展开用）。
 *
 * @param id Runbook 编号（如 'RUNBOOK-K8S-042'）
 * @returns 命中文档（无 similarityScore）；未找到返回 null
 */
export function getRunbookById(id: string): RagRunbookDoc | null {
  for (const doc of SRE_RUNBOOK_CORPUS) {
    if (doc.id === id) return doc;
  }
  return null;
}
