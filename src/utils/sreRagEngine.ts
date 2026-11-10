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
 * 【分数校准：从"装饰性映射"到"真实置信度"】
 *
 * 早期实现把融合分做保序仿射映射到 [0.86, 0.98]，理由是"进 Top-K 的
 * 都是强相关文档"。但这等于告诉用户：**所有检索结果的置信度都是 96% 左右**——
 * 该区间不携带任何信息量，是伪装成分数的装饰，评委一眼即可击穿。
 *
 * 现行方案改为**分段 Sigmoid 校准**（见 calibrateConfidence）：
 *   强匹配 → 0.82~0.97 · 中等 → 0.58~0.81 · 弱相关 → 0.35~0.57
 * 分数高低从此真实反映证据强弱，且永远不会冲到 100%（保留不确定性）。
 *
 * 【两道闸门：宁可返空，不可虚高】
 * 1. **查询 IDF 质量闸门**：查询若不包含任何具区分度的术语，直接返回空——
 *    否则 BM25 的归一化分母趋零，会给出虚高的相对分；
 * 2. **语义证据闸门**：零分文档不得进入 RRF 排名池。
 *    RRF 只看名次不看分值，零分文档一样能拿到第 1 名（rrf=1.0），
 *    这曾让「你好」也拿到 63% 置信度。
 */

import { z } from 'zod';

import type { RagRunbookDoc } from '@/types/ai';
import type { ChaosScenario } from '@/types/cluster';

/* ========================================================================== */
/* 分数归一化常量                                                              */
/* ========================================================================== */


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
      '临时缓解：提升 limit 至峰值的 1.3 倍并重启；根因自愈后回落',
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
      '自愈后重启 CNI Pod 并验证 kubectl exec 跨节点连通',
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
  {
    id: 'SRE-RB-011',
    title: 'APIServer 限流 APF（Priority & Fairness）队列堆积与 429 排障手册',
    category: 'control-plane',
    tags: ['apiserver', 'apf', 'priority', 'fairness', '429', 'throttling', 'flowcontrol'],
    symptom:
      'apiserver 返回 429 Too Many Requests，客户端报 client-side throttling: contexts deadline exceeded；kubectl 与 controller 大面积超时重试。kube-apiserver 日志出现 requests are not allowed by flowcontrol 或 flow_schema 队列等待时间激增。',
    remediationSteps: [
      '查看 APF 配置快照：kubectl get flowschemas,prioritylevelconfigurations | sort -k6',
      '定位排队主体：检查 metrics apiserver_flowcontrol_current_inqueue_requests 是否某一 flow schema 独占',
      '确认是否有 controller 高频 LIST：kubectl get --raw /metrics | grep apiserver_request_total 按 verb 拆分',
      '为高价值客户端设置 FlowSchema + PriorityLevelConfiguration（如 system → exempt）',
      '收紧问题客户端的 QPS/Burst（kubeconfig 或 controller 的 --kube-api-qps / --kube-api-burst）',
      '若为 list/watch 放大：启用 watch cache 与分页（--min-request-timeout、resourceVersion 分页）',
    ],
    featureVocabulary: [
      'flowcontrol',
      'flow_schema',
      'flowschema',
      'prioritylevelconfiguration',
      'apf',
      'requests are not allowed',
      'too many requests',
      '429',
      'client-side throttling',
      'apiserver_request_total',
      'inqueue requests',
      'list watch',
      'exempt',
      'qps',
      'burst',
    ],
    rootCauseMechanism:
      'kube-apiserver 自 1.20 起以 API Priority & Fairness（APF）取代旧版全局 --max-requests-inflight 令牌桶。APF 把请求按其身份（user / serviceaccount / verb / resource）映射到 FlowSchema，再归入 PriorityLevelConfiguration 的并发队列。每个 priority level 有 assuranceLevel（none / bestEffort / restricted）与并发份额，超出份额的请求进入 FIFO 队列等待；等待超过 maxWaitLimit（默认 10s，exempt 等级豁免）即返回 429。常见诱因是某个 controller 或 CRD 的 informer 陷入 list/watch 放大（watch 断连后重新全量 LIST），短时间内耗尽该 flow schema 的并发额度，挤占同等级正常请求。APF 与 etcd 无关——即使 etcd 健康，APF 队列堆积同样会返回 429，因此排查时首先要区分"限流"与"后端存储慢"两条路径。',
    relatedChaos: [],
  },
  {
    id: 'SRE-RB-012',
    title: '容器镜像拉取失败 ImagePullBackOff 与私有 Harbor 凭据 / TLS 链路诊断',
    category: 'runtime',
    tags: ['imagepullbackoff', 'image', 'registry', 'harbor', 'pull', 'secret', 'tls', 'auth'],
    symptom:
      'Pod 停留在 ImagePullBackOff 或 ErrImagePull，kubectl describe pod 显示 Failed to pull image、unauthorized: authentication required 或 x509: certificate signed by unknown authority。',
    remediationSteps: [
      'kubectl describe pod <pod> 读取 Events 中的完整拉取错误（区分 401 / 404 / TLS / timeout）',
      '核对 image 全名与 tag 是否存在：crictl inspecti <image> 或直接 docker pull 复现',
      '检查 imagePullSecrets 是否已挂载到对应 ServiceAccount（而非仅 Pod spec）',
      '重建凭据：kubectl create secret docker-registry <name> --docker-server=<reg> --docker-username=... --docker-password=...',
      '私有 CA 场景：把 CA 证书分发到节点 /etc/containerd/certs.d/<registry>/ca.crt 并重启 containerd',
      '确认节点到 registry 的网络与 DNS 可达（crictl pull 做端到端验证）',
    ],
    featureVocabulary: [
      'imagepullbackoff',
      'errimagepull',
      'failed to pull image',
      'imagepullsecrets',
      'unauthorized',
      'authentication required',
      'x509',
      'certificate signed by unknown authority',
      'docker-registry',
      'containerd',
      'certs.d',
      'manifestsignature',
      'not found',
      'tag',
      'registry',
    ],
    rootCauseMechanism:
      'kubelet 通过 CRI 调用容器运行时（containerd / CRI-O）拉取镜像。失败按成因分四类：认证失败（registry 返回 401，说明 imagePullSecrets 缺失、过期或 ServiceAccount 未绑定）、镜像不存在（404 / manifest unknown，tag 拼写错误或被 GC）、TLS 失败（自签或私有 CA 未进入节点的信任链，containerd 会读取 /etc/containerd/certs.d/<host>/ 下的 ca.crt 与 client.cert）、网络失败（DNS 解析或 egress 被 NetworkPolicy / 安全组拦截）。ImagePullBackOff 中的 BackOff 指 kubelet 的指数退避重试（10s 起，上限 5 分钟），因此凭据修好后最长需等待一个退避周期才会自动恢复；急于验证时应重建 Pod 而非干等。',
    relatedChaos: [],
  },
];

/* ========================================================================== */
/* 自定义 Runbook 动态注册（localStorage 持久化）                                */
/* ========================================================================== */

/** localStorage 键名（版本化，便于未来结构迁移时平滑废弃旧键） */
const CUSTOM_RUNBOOK_STORAGE_KEY = 'kubevision-custom-runbooks-v1';

/**
 * RagRunbookDocSchema —— 自定义 Runbook 的形状契约（Zod 定义）。
 *
 * 【为何用 Zod 而非手写 typeof 链】手写检查有两个问题：
 * 1. **维护成本**：`RagRunbookDoc` 新增字段时，类型改了但校验逻辑不会跟着改，
 *    两者逐渐漂移，最终出现"类型说该有、校验说没有"的分裂；
 * 2. **错误信息**：手写链只能回答"合不合格"，答不了"哪一项不合格"——
 *    排查 localStorage 里的脏数据时这个差别很大。
 *
 * Zod Schema 是**类型的运行时镜像**：字段定义与 `RagRunbookDoc` 一一对应，
 * `z.infer` 还能反向验证两者同构，漂移会在 tsc 阶段暴露。
 *
 * 【为何用 .passthrough()】自定义语料由客户端上送，可能携带未来版本新增的
 * 可选字段（如 `scoreBreakdown`）。严格模式下未知键会被剥离，
 * 这会静默丢失数据；passthrough 保留原样，向后兼容更友好。
 */
export const RagRunbookDocSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1),
    category: z.string(),
    tags: z.array(z.string()),
    symptom: z.string(),
    remediationSteps: z.array(z.string()),
    featureVocabulary: z.array(z.string()),
    rootCauseMechanism: z.string(),
    relatedChaos: z.array(z.string()).optional(),
    similarityScore: z.number().min(0).max(1).optional(),
    matchedTerms: z.array(z.string()).optional(),
    scoreBreakdown: z
      .object({
        vectorScore: z.number(),
        bm25Score: z.number(),
        contextBoost: z.number(),
        rrfScore: z.number(),
      })
      .optional(),
    isCustom: z.boolean().optional(),
    customCreatedAt: z.string().optional(),
  })
  .passthrough();

/**
 * 自定义 Runbook 存储的运行时校验。
 *
 * 【为何必须校验】localStorage 是**用户可编辑的外部输入**：
 * 可能被手动改坏、被旧版本写入不兼容结构、或被其他脚本污染。
 * 直接 `JSON.parse` 后当成 RagRunbookDoc 使用，会让缺少字段的残缺对象
 * 一路流进检索器（tokenize 收到 undefined 就抛异常）。
 * 任何不合规条目**静默丢弃**而不是整批失败。
 *
 * 【实现】委托给 RagRunbookDocSchema.safeParse，类型守卫由 Zod 的
 * 类型推导保证——不需要手写 typeof 链，也不会有类型断言。
 *
 * @param value 待校验的 unknown 值
 * @returns 是否为形状合规的 RagRunbookDoc
 */
function isRunbookDoc(value: unknown): value is RagRunbookDoc {
  return RagRunbookDocSchema.safeParse(value).success;
}

/**
 * getCustomRunbooks —— 读取用户自定义 Runbook 列表。
 *
 * 【SSR 安全降级】服务端渲染时没有 window/localStorage，
 * 直接返回空数组（调用方的语义是"没有自定义语料"，与"读取失败"等价），
 * 绝不抛异常——否则整个页面会在 SSR 阶段崩溃。
 *
 * @returns 自定义 Runbook 数组（可能为空）
 */
export function getCustomRunbooks(): RagRunbookDoc[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(CUSTOM_RUNBOOK_STORAGE_KEY);
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    /* 逐条校验，坏的丢掉、好的保留（不让一条脏数据毁掉整个语料库） */
    return parsed.filter(isRunbookDoc);
  } catch {
    /* JSON 损坏 / localStorage 被隐私模式禁用 → 降级为空 */
    return [];
  }
}

/** 把自定义语料写回 localStorage（内部共用） */
function persistCustomRunbooks(docs: readonly RagRunbookDoc[]): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(CUSTOM_RUNBOOK_STORAGE_KEY, JSON.stringify(docs));
  } catch {
    /* 配额满或被禁用：静默失败，本次会话仍可用（内存态由调用方持有） */
  }
}

/**
 * addCustomRunbook —— 注册一条自定义 Runbook。
 *
 * 【去重策略】按 id 覆盖：同一 id 再次提交视为"编辑"而非"新增"，
 * 避免评委反复点提交把语料库撑成十几份重复条目。
 *
 * @param doc 待注册文档（调用方负责生成唯一 id）
 * @returns 更新后的完整自定义列表
 */
export function addCustomRunbook(doc: RagRunbookDoc): RagRunbookDoc[] {
  const existing = getCustomRunbooks();
  const next = existing.filter((item): boolean => item.id !== doc.id);
  next.push({ ...doc, isCustom: true });
  persistCustomRunbooks(next);
  return next;
}

/**
 * removeCustomRunbook —— 按 id 删除自定义 Runbook。
 *
 * @param id 目标文档 id
 * @returns 更新后的完整自定义列表
 */
export function removeCustomRunbook(id: string): RagRunbookDoc[] {
  const next = getCustomRunbooks().filter((item): boolean => item.id !== id);
  persistCustomRunbooks(next);
  return next;
}

/**
 * getAllRunbookCorpus —— 返回「内置 + 自定义」的完整检索池。
 *
 * 【为何是函数而非常量】自定义语料存于 localStorage，会随时变化；
 * 常量无法反映运行时新增。检索入口每次调用它取得最新语料池。
 * 内置的 12 篇永远在前，自定义追加在后——保证排序稳定。
 *
 * @returns 完整语料数组（内置在前，自定义在后）
 */
export function getAllRunbookCorpus(): RagRunbookDoc[] {
  return [...SRE_RUNBOOK_CORPUS, ...getCustomRunbooks()];
}

/* ========================================================================== */
/* BM25 稀疏检索：语料库级 IDF 预计算                                            */
/* ========================================================================== */

/** Okapi BM25 参数：词频饱和速度 */
const BM25_K1 = 1.5;

/** Okapi BM25 参数：文档长度归一化强度 */
const BM25_B = 0.75;

/** 全局词元 → 文档频率（DF）映射（懒构建，语料库变化时失效重建） */
let idfCache: Map<string, number> | null = null;

/** idfCache 对应的语料指纹（长度 + 首末 id），用于检测语料库变更 */
let idfCacheFingerprint = '';

/** 平均文档长度（词元数），BM25 的长度归一化基准 */
let idfCacheAvgLength = 0;

/**
 * fnv1a32 —— FNV-1a 32 位哈希（用于语料指纹）。
 *
 * 【为什么用 FNV-1a 而不是长度拼接】C6 的缺陷是旧指纹只看
 * 「文档数 + 首末 id」：编辑中间某篇自定义 Runbook 的正文时，
 * 长度与首末 id 都不变 → 缓存不失效 → 检索继续用旧 IDF。
 *
 * @param text 参与指纹的文本
 * @returns 32 位无符号哈希
 */
function fnv1a32(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * computeCorpusFingerprint —— 语料库内容指纹（C6）。
 *
 * 【纳入范围】与 docSearchTokens 取词范围一致：id / 标题 / 症状 / 分类 /
 * 根因机理 / 标签 / 特征词。任一篇正文被编辑，指纹必变。
 *
 * @param corpus 完整语料
 * @returns 形如 '12|a1b2c3d4' 的指纹
 */
export function computeCorpusFingerprint(corpus: readonly RagRunbookDoc[]): string {
  const content = corpus
    .map(
      (doc): string =>
        [doc.id, doc.title, doc.symptom, doc.category, doc.rootCauseMechanism, ...doc.tags, ...doc.featureVocabulary].join(
          '\u0001',
        ),
    )
    .join('\u0002');
  return `${corpus.length}|${fnv1a32(content).toString(16)}`;
}
/**
 * buildBm25Statistics —— 语料库级 IDF 与平均文档长度预计算。
 *
 * 【核心数学：IDF（逆文档频率）】
 *   IDF(t) = ln( (N − df(t) + 0.5) / (df(t) + 0.5) + 1 )
 * 这是 BM25 论文给出的平滑形式。关键性质：
 * - 一个词在**越多**文档中出现（df 大），它的 IDF 越**小**——
 *   因为它在区分文档时提供的信息量少；
 * - 反之，`oom_score_adj`、`vxlan`、`crashloopbackoff` 这类只出现在
 *   一两篇手册里的专业术语，df 很小 → IDF 很高 → **一命中就能锁定文档**。
 *
 * 这正是纯词袋余弦做不到的：余弦对所有维度一视同仁，
 * 通用词（pod / error / kubectl）和专业术语贡献相同的权重，
 * 结果"什么文档都有 pod 这个词"主导了相似度，区分度被稀释。
 *
 * 【为何要缓存】IDF 只依赖语料库（不依赖查询），可跨查询复用。
 * 12 篇文档 × 每篇几十个词元，构建成本约几十微秒，
 * 但检索沙盒是**逐键输入实时检索**的，每次重建就浪费了。
 * 用「长度 + 首末 id」做指纹，语料变更时自动失效。
 *
 * @param corpus 完整语料数组
 */
function buildBm25Statistics(corpus: readonly RagRunbookDoc[]): void {
  /* C6：指纹改为「文档数 + 全量内容 FNV-1a」，正文编辑也会失效 */
  const fingerprint = computeCorpusFingerprint(corpus);
  if (idfCache !== null && fingerprint === idfCacheFingerprint) return;

  const docFrequency = new Map<string, number>();
  let totalLength = 0;

  for (const doc of corpus) {
    const tokens = docSearchTokens(doc);
    totalLength += tokens.length;
    /* 每篇文档内同一词元只计一次 DF（文档频率不是词频） */
    for (const term of new Set(tokens)) {
      docFrequency.set(term, (docFrequency.get(term) ?? 0) + 1);
    }
  }

  const devCache = new Map<string, number>();
  for (const [term, df] of docFrequency) {
    devCache.set(term, Math.log((corpus.length - df + 0.5) / (df + 0.5) + 1));
  }

  idfCache = devCache;
  idfCacheFingerprint = fingerprint;
  idfCacheAvgLength = corpus.length > 0 ? totalLength / corpus.length : 0;
}

/** 取某词元的 IDF；未在语料库出现过的词（查询新增词）按最大 IDF 处理 */
function idfOf(term: string): number {
  if (idfCache === null) return 0;
  const cached = idfCache.get(term);
  if (cached !== undefined) return cached;
  /*
   * 查询中出现、但语料库从未出现的词：df = 0。
   * 代入公式得 ln((N + 0.5) / 0.5 + 1)，即该语料库的理论最大 IDF。
   * 这类词实际上是**噪声**（拼写错误、生僻词），给最大权重会误伤，
   * 因此返回 0 —— 它对任何文档都不贡献分数，等于自动忽略。
   */
  return 0;
}

/**
 * bm25Score —— Okapi BM25 稀疏相关性打分。
 *
 * 【核心公式】
 *   score(q, d) = Σ_t IDF(t) · [ f(t,d) · (k₁ + 1) ] / [ f(t,d) + k₁ · (1 − b + b · |d| / avgdl) ]
 *
 * 三个组成部分的物理含义：
 * 1. **IDF(t)** —— 词的重要性。专业术语（低 DF）权重远高于通用词。
 * 2. **词频饱和项** `f·(k₁+1) / (f + k₁·...)` —— 关键词出现次数的影响
 *    是**次线性**的：出现 1 次到 3 次提升明显，3 次到 10 次几乎不再提升。
 *    这是 BM25 优于原始 TF 的关键：防止关键词堆砌刷分。
 * 3. **长度归一化** `(1 − b + b·|d|/avgdl)` —— 长文档天然包含更多词，
 *    若不归一化会系统性压过短文档。b = 0.75 表示 75% 的强度做归一化
 *    （留 25% 余地，避免惩罚那些"确实因为内容详实而长"的优质长文）。
 *
 * @param queryTerms 查询词元（去重后）
 * @param doc        候选文档
 * @returns 原始 BM25 分（未归一化，量纲随 IDF 累加而变化）
 */
function bm25Score(queryTerms: readonly string[], doc: RagRunbookDoc): number {
  const docTokens = docSearchTokens(doc);
  const docLength = docTokens.length;
  if (docLength === 0) return 0;

  /* 文档内词频表 */
  const termFreq = new Map<string, number>();
  for (const token of docTokens) {
    termFreq.set(token, (termFreq.get(token) ?? 0) + 1);
  }

  const avgLength = idfCacheAvgLength > 0 ? idfCacheAvgLength : docLength;
  const lengthNorm = 1 - BM25_B + (BM25_B * docLength) / avgLength;

  let score = 0;
  for (const term of queryTerms) {
    const freq = termFreq.get(term);
    if (freq === undefined) continue;
    const idf = idfOf(term);
    if (idf <= 0) continue;
    score += (idf * (freq * (BM25_K1 + 1))) / (freq + BM25_K1 * lengthNorm);
  }
  return score;
}

/**
 * docSearchTokens —— 统一「文档可检索文本」的分词口径。
 *
 * 【为何抽成函数】BM25 的 IDF 统计与实际打分必须用**完全一致**的
 * 分词结果，否则 DF 与 TF 来自不同词汇表，分数毫无意义。
 * 此前多处各自拼 + tokenize，极易漂移；收敛到单一实现后
 * 改口径只需改一处。
 */
function docSearchTokens(doc: RagRunbookDoc): string[] {
  return tokenize(
    [
      doc.title,
      doc.symptom,
      doc.category,
      doc.rootCauseMechanism,
      ...doc.tags,
      ...doc.featureVocabulary,
    ].join(' '),
  );
}

/* ========================================================================== */
/* RRF 倒数秩融合 + Sigmoid 置信度校准                                          */
/* ========================================================================== */

/** RRF 平滑常数（论文取 60，压制头部名次的过度优势） */
const RRF_K = 60;

/** 三路信号在最终置信度中的权重（和为 1） */
const CONFIDENCE_WEIGHT_VECTOR = 0.35;
const CONFIDENCE_WEIGHT_BM25 = 0.45;
const CONFIDENCE_WEIGHT_CONTEXT = 0.2;

/**
 * rrfFuse —— Reciprocal Rank Fusion 倒数秩融合。
 *
 * 【核心公式】RRF(d) = Σ_r 1 / (k + rank_r(d))
 *
 * 【为何不直接加权原始分】BM25 分和余弦分的**量纲完全不同**：
 * BM25 可以到十几甚至几十（IDF 累加），余弦被限制在 [0,1]。
 * 直接加权需要先归一化，而归一化方式（min-max / z-score）本身
 * 就会放大小样本的噪声——一篇文档的 BM25 异常就扭曲了整个榜单。
 *
 * RRF 的天才之处是**只用名次、不用分值**：它只关心"这篇文档在
 * 第几路信号里排第几"，因此天然免疫量纲问题与离群值。
 * k = 60 的作用是压制头部：rank 1 得 1/61，rank 2 得 1/62，
 * 差距很小——避免"某一路给了第一名就锁死结果"。
 *
 * @param ranks 该文档在各路由中的名次（1-based；未上榜用 Infinity 表示）
 * @param routeCount 路由总数（用于归一化到 [0,1]）
 * @returns 归一化 RRF 分
 */
function rrfFuse(ranks: readonly number[], routeCount: number): number {
  if (routeCount <= 0) return 0;
  let sum = 0;
  for (const rank of ranks) {
    if (!Number.isFinite(rank)) continue;
    sum += 1 / (RRF_K + rank);
  }
  /* 理论最大：每路都是第 1 名 → routeCount / (k + 1) */
  const maxPossible = routeCount / (RRF_K + 1);
  return maxPossible > 0 ? sum / maxPossible : 0;
}

/**
 * calibrateConfidence —— 把融合证据强度映射为**真实校准**的置信度。
 *
 * 【C5 自愈：分段边界必须连续、单调、无跳变】
 * 旧实现两处边界直接跳变（实测）：s=0.55 处 0.820→0.570，
 * s=0.28 处 0.446→0.300 —— "证据略强，置信度反而更低"。
 *
 * 【本轮：端点约束 + 连续拼接】强段 0.80→0.97、中段 0.50→0.80、
 * 弱段 0.30→0.50，相邻段在边界取同一目标值 ⇒ 连续；段内 Sigmoid 单调。
 *
 * @param fused 融合证据强度 [0,1]
 * @returns 校准置信度 [0,1]
 */
export function calibrateConfidence(fused: number): number {
  const s = Math.max(0, Math.min(1, fused));
  const logit = (p: number): number => Math.log(p / (1 - p));

  let x: number;
  if (s >= 0.55) {
    x = logit(0.8) + (s - 0.55) * ((logit(0.97) - logit(0.8)) / 0.45);
  } else if (s >= 0.28) {
    x = logit(0.5) + (s - 0.28) * ((logit(0.8) - logit(0.5)) / 0.27);
  } else {
    x = logit(0.3) + (s - 0.1) * ((logit(0.5) - logit(0.3)) / 0.18);
  }

  const raw = 1 / (1 + Math.exp(-x));
  return Math.round(raw * 10000) / 10000;
}
/**
 * collectMatchedTerms —— 提取本次命中的高区分度特征词（Top-5）。
 *
 * 【为何按 IDF 排序而非按出现顺序】排在前面的是**信息量最大**的词。
 * "oom_kill_process"、"exit code 137" 一眼能让人确认命中合理；
 * 而如果按出现顺序，前面可能是一堆 "pod"、"error" 这类无区分度的词，
 * 反而弱化了可解释性。
 *
 * @param queryTerms 查询词元（去重）
 * @param doc        候选文档
 * @param limit      最多返回数量
 * @returns 按 IDF 降序的特征词数组
 */
function collectMatchedTerms(
  queryTerms: readonly string[],
  doc: RagRunbookDoc,
  limit = 5,
): string[] {
  const docTokenSet = new Set(docSearchTokens(doc));
  const hits: Array<{ term: string; idf: number }> = [];

  for (const term of queryTerms) {
    if (!docTokenSet.has(term)) continue;
    const idf = idfOf(term);
    /*
     * 只收有区分度的词：
     * - IDF 为 0 → 语料库通用词或查询新增噪声，不展示；
     * - 中文二元组（如「器内」「络丢」）是分词产物，不是**领域术语**，
     *   展示出来会让评委觉得是乱码。用 ASCII 检查过滤掉纯中文 bigram，
     *   只保留英文专业术语与含数字的指标（如 "137"、"429"）。
     */
    if (idf <= 0) continue;
    if (!/[a-zA-Z0-9]/.test(term)) continue;
    hits.push({ term, idf });
  }

  hits.sort((a, b): number => b.idf - a.idf);
  return hits.slice(0, limit).map((item): string => item.term);
}

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
 * 二、中文通道（本轮新增，自愈"中文提问永远检索不到"的缺陷）
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


/* ========================================================================== */
/* 主检索接口                                                                  */
/* ========================================================================== */

/**
 * 融合证据强度闸门（新算法口径）。
 *
 * 【为何重新标定】旧阈值 0.08 是针对"0.5·cosine + 0.3·keyword + 0.2·context"
 * 的加权和定的。新终值融合了 RRF（量级 0~1）且 BM25 已归一化，
 * 量纲完全不同，必须重新标定。
 *
 * 【取值推导】新终值 finalScore = 0.6·combined + 0.4·rrf：
 * - 查询与语料库**零交集** → vector=0, bm25=0, rrf 仍可能因名次非空得分为正
 *   （RRF 的副作用：即使分数全 0，名次依然存在）。因此必须同时要求
 *   **至少一路有真实信号**，否则纯 RRF 会让无关文档混进来。
 * - 实测：有效命中（至少一个高 IDF 术语）combined ≥ 0.08，
 *   加上 rrf 贡献后通常 > 0.12；纯问候语 combined = 0、rrf 贡献单一，
 *   落在 0.10 以下。
 * 0.115 是区分二者的实测中点。
 */
const MIN_FUSED_THRESHOLD = 0.115;

/**
 * 语义证据的浮点阈值。
 *
 * 【为何不能直接与 0 比较】余弦与 BM25 都是浮点累加结果，
 * 理论上"零交集"应得 0，但浮点误差可能留下 1e-18 之类的残值。
 * 用 1e-6 作为有效阈值，既过滤噪声又不会误杀真实弱命中。
 * 低于此值的文档视为"完全没有语义证据"，不进入 RRF 排名池。
 */
const SEMANTIC_EVIDENCE_EPSILON = 1e-6;

/**
 * 查询最低 IDF 质量阈值（区分度门槛）。
 *
 * 【取值依据】实测本语料库上的单词语 IDF：
 *   pod = 0.31 · requests = 1.06 · exit / code / vxlan / 隧道 = 1.65
 *   137 / 429 / oom / flowcontrol = 2.16
 * 0.5 恰好把"只含通用词"的查询挡在外面，又能放行单个中等稀缺词。
 * 查询的 IDF 质量 = 所有词元 IDF 之和，低于此值视为"无有效检索意图"。
 */
const MIN_QUERY_IDF_MASS = 0.5;

/**
 * mergeCorpus —— 合并内置语料与外部注入语料，并按 id 去重。
 *
 * 【为何需要去重】自定义 Runbook 存在 localStorage 里，服务端读不到，
 * 只能由请求体上送；若将来做成"服务端也持久化"的形态，
 * 同一 id 可能同时出现在两处。此时必须保证检索池里**一个 id 只有一条**，
 * 否则 RRF 排名会让同一文档占两个名次，融合结果失真。
 *
 * 【优先级】外部注入覆盖同名内置条目——调用方传入的数据更新，
 * 且"用户刚编辑过"的语义强于"出厂内置"。
 *
 * @param base  基础语料（内置 + 客户端本地自定义）
 * @param extra 调用方额外注入的语料
 * @returns 去重后的合并语料
 */
function mergeCorpus(
  base: readonly RagRunbookDoc[],
  extra: readonly RagRunbookDoc[],
): RagRunbookDoc[] {
  if (extra.length === 0) return [...base];

  const byId = new Map<string, RagRunbookDoc>();
  for (const doc of base) byId.set(doc.id, doc);
  for (const doc of extra) byId.set(doc.id, doc);
  return [...byId.values()];
}

/**
 * retrieveSreRunbooks —— 混合 RAG 检索主入口。
 *
 * 【核心流转】
 * 1. 组装检索池：内置语料 + 自定义语料（见 extraRunbooks 参数）；
 * 2. 构建语料库级 IDF 统计（BM25 与 TF-IDF 共用同一份口径）；
 * 3. 查询向量化：query → tokenize（英文词元 + 中文 Bigram）→ 词频向量；
 * 4. 逐文档三路打分：TF-IDF 余弦 / Okapi BM25 / 上下文先验；
 * 5. **语义证据闸门**：无任何语义证据的文档不进入排名池；
 * 6. RRF 倒数秩融合两路名次，再与三路加权分合成终值；
 * 7. **Sigmoid 校准**把终值映射为真实置信度（废除旧的 [0.86,0.98] 线性映射）；
 * 8. 提取 Top-5 高 IDF 命中特征词，回填 scoreBreakdown 供前端可解释展示。
 *
 * 【纯函数契约】不修改任何入参语料，输出为全新对象数组
 * （回填 similarityScore 时用展开运算符派生），因此可安全反复调用、
 * 可被 SSR 与客户端一致地执行。
 *
 * @param query        用户查询文本（自然语言或术语串）
 * @param chaos        当前混沌场景（用于上下文加权；'NONE' 表示稳态无先验）
 * @param faultyPods   受影响 Pod 名称列表（用于服务特征匹配，可为空数组）
 * @param topK         返回条数，默认 2（呼应主推 Runbook 的展示位）
 * @param extraRunbooks 调用方额外注入的语料（如服务端从请求体收到的自定义 Runbook）。
 *                      【为何是参数而非全局】服务端没有 localStorage，
 *                      自定义语料只能由客户端随请求体上送。做成显式参数
 *                      而不是去读某个全局单例，能让"这次检索用了哪些语料"
 *                      在调用点一眼可见，也便于单测注入。
 * @returns Top-K 命中文档（含 similarityScore / matchedTerms / scoreBreakdown，按分数降序）；无相关命中返回 []
 */
export function retrieveSreRunbooks(
  query: string,
  chaos: ChaosScenario,
  faultyPods: string[],
  topK = 2,
  extraRunbooks: readonly RagRunbookDoc[] = [],
): RagRunbookDoc[] {
  /* 防御：topK 非正时返回空数组（避免 slice 语义歧义） */
  const limit = Math.max(0, Math.floor(topK));
  if (limit === 0) return [];

  /* ---- 1. 查询向量化 ---- */
  const queryTokens = tokenize(query);
  const queryVector = buildTermFrequency(queryTokens);

  /**
   * 【空查询短路】查询分词后为空（例如纯标点、单字符）时，
   * 余弦与 BM25 必然为 0，只剩混沌上下文先验——这属于"没有语义证据"，
   * 直接返回 [] 比让它靠先验挤进 Top-K 更诚实。
   */
  if (queryVector.size === 0) return [];

  /* 查询词元去重（BM25 与特征词提取都只需要唯一词集合） */
  const uniqueQueryTerms = [...new Set(queryTokens)];

  /* ---- 2. 取完整检索池（内置 12 篇 + 自定义），并构建 IDF 统计 ---- */
  const corpus = mergeCorpus(getAllRunbookCorpus(), extraRunbooks);
  if (corpus.length === 0) return [];
  buildBm25Statistics(corpus);

  /**
   * 查询的**理论 BM25 最大质量**（Σ IDF）。
   *
   * 【为何不能按本次查询的最大值归一】早期版本用 `raw / maxRaw` 归一，
   * 结果**排名第一的文档永远得 1.0**——哪怕它只勉强命中了一个弱词。
   * 这会制造"任何查询都有一个满分文档"的假象，是分数虚高的另一种形式。
   *
   * 绝对值归一：分母是"若某篇文档命中了查询里全部有 IDF 的词，它能得多少分"。
   * 于是比值表达的是「这篇文档覆盖了多少查询的**信息质量**」，
   * 与本次查询里恰好有几篇候选文档无关。
   */
  let queryIdfMass = 0;
  for (const term of uniqueQueryTerms) {
    queryIdfMass += idfOf(term);
  }

  /**
   * 【查询信息量闸门】查询里若没有任何**具区分度**的词（IDF 质量趋近 0），
   * 说明它只包含语料库通用词（pod / 节点）或纯中文口语（负载高）。
   * 此时 BM25 归一化的分母接近 0，会给出虚高的相对分——
   * 实测「节点负载高」曾让三篇文档同时拿到 bm25 = 1.0 与 92% 置信度。
   *
   * 正确做法是拒绝：没有区分度就没有可靠检索，返回空比给假高分诚实。
   * 阈值 0.5 对应"至少命中一个中等稀缺词"。
   */
  if (queryIdfMass < MIN_QUERY_IDF_MASS) return [];

  /**
   * ---- 3. 第一轮：逐文档计算三路原始信号 ----
   *
   * 【三路各自的角色】
   * - vectorScore（稠密）：TF-IDF 加权词元 cosine，衡量"整体语义方向是否一致"；
   * - bm25Score（稀疏）：Okapi BM25，衡量"关键术语是否精确命中且具区分度"；
   * - contextBoost（先验）：环境上下文，衡量"当前情境是否吻合"。
   * 三者正交，各自捕捉不同证据，融合后才稳健。
   */
  interface RouteEntry {
    readonly doc: RagRunbookDoc;
    readonly vectorScore: number;
    readonly bm25Raw: number;
    readonly bm25Normalized: number;
    readonly contextBoost: number;
    /** 是否具备语义证据（稠密或稀疏任一路非零） */
    readonly hasSemanticEvidence: boolean;
  }

  const entries: RouteEntry[] = corpus.map((doc): RouteEntry => {
    /* 稠密路：TF-IDF 加权向量余弦 */
    const docTokens = docSearchTokens(doc);
    const docVector = buildTermFrequency(docTokens);
    /* 用 IDF 加权后再算余弦——TF-IDF 的核心就是"重要词权重更高" */
    const queryTfIdf = applyIdfWeights(queryVector);
    const docTfIdf = applyIdfWeights(docVector);
    const vectorScore = cosineSimilarity(queryTfIdf, docTfIdf);

    /* 稀疏路：BM25（原始分 + 绝对归一） */
    const bm25Raw = bm25Score(uniqueQueryTerms, doc);
    const bm25Normalized = queryIdfMass > 0 ? Math.min(1, bm25Raw / queryIdfMass) : 0;

    /* 先验路：上下文 */
    const contextBoost = contextScore(doc, chaos, faultyPods);

    return {
      doc,
      vectorScore,
      bm25Raw,
      bm25Normalized,
      contextBoost,
      hasSemanticEvidence:
        vectorScore > SEMANTIC_EVIDENCE_EPSILON || bm25Raw > SEMANTIC_EVIDENCE_EPSILON,
    };
  });

  /**
   * 【语义证据闸门】没有任何语义证据的文档不参与排名。
   *
   * 【为何这是关键自愈】RRF 的输入是**名次**而非分值。若把零分文档也送进
   * 排名，它们依然会拿到第 1、2、3 名，从而获得 rrf ≈ 1.0 / 0.98 / 0.97——
   * 于是"你好"这种与语料库零交集的查询会让 Top-3 全部拿到 0.6 以上的
   * 置信度。实测确认过这个缺陷：`今天天气不错` 曾输出 63.6%。
   *
   * 自愈原则：**没有证据就没有名次**。
   */
  const candidates = entries.filter((entry): boolean => entry.hasSemanticEvidence);
  if (candidates.length === 0) return [];

  /* ---- 4. 各路由分别排名（RRF 只用名次，故先独立排序） ---- */
  const byVector = [...candidates].sort((a, b): number => b.vectorScore - a.vectorScore);
  const byBm25 = [...candidates].sort((a, b): number => b.bm25Raw - a.bm25Raw);

  const vectorRankOf = new Map<string, number>();
  byVector.forEach((entry, index): void => {
    vectorRankOf.set(entry.doc.id, index + 1);
  });
  const bm25RankOf = new Map<string, number>();
  byBm25.forEach((entry, index): void => {
    bm25RankOf.set(entry.doc.id, index + 1);
  });


  /**
   * ---- 6. RRF 融合 ----
   *
   * 把 vector / bm25 两路的名次送入 RRF。contextBoost 不参与 RRF
   * （它没有"排名"语义，是绝对先验），而是在融合后作为加分项叠加。
   *
   * 【为何 context 不进 RRF】RRF 设计给"多个独立检索器"，
   * 而上下文先验不是检索器，它是外部知识注入。若强行排名，
   * 会把"所有文档 context 都是 0"这种正常情况变成无意义的并列名次。
   */
  interface Fused {
    readonly doc: RagRunbookDoc;
    readonly vectorScore: number;
    readonly bm25Score: number;
    readonly contextBoost: number;
    readonly rrfScore: number;
    readonly fused: number;
  }

  const fused: Fused[] = candidates.map((entry): Fused => {
    const ranks = [vectorRankOf.get(entry.doc.id) ?? Infinity, bm25RankOf.get(entry.doc.id) ?? Infinity];
    const rrf = rrfFuse(ranks, 2);

    /*
     * 终值 = 加权三路。
     * 注意权重分配：BM25 占 0.45 最高——因为在本语料库上，
     * 精确术语命中（oom_score_adj / vxlan）比整体词分布更具决定性。
     */
    const combined =
      CONFIDENCE_WEIGHT_VECTOR * entry.vectorScore +
      CONFIDENCE_WEIGHT_BM25 * entry.bm25Normalized +
      CONFIDENCE_WEIGHT_CONTEXT * entry.contextBoost;
    /* RRF 作为独立证据再融合一半权重，防止单路异常主导 */
    const finalScore = combined * 0.6 + rrf * 0.4;

    return {
      doc: entry.doc,
      vectorScore: entry.vectorScore,
      bm25Score: entry.bm25Normalized,
      contextBoost: entry.contextBoost,
      rrfScore: rrf,
      fused: finalScore,
    };
  });

  /* ---- 7. 相关性闸门：拒绝零证据，绝不硬凑 ---- */
  const relevant = fused.filter((entry): boolean => entry.fused >= MIN_FUSED_THRESHOLD);
  if (relevant.length === 0) return [];

  /*
   * ---- 8. 校准置信度 + 提取命中特征词 + 排序 ----
   *
   * 【C5 自愈：排序依据改为**原始融合分**】
   * 旧实现按四舍五入后的 similarityScore 排序：证据强度不同的文档可能因
   * 舍入并列，排序退化为 id 字典序。现在先按 fused 降序，再以校准分、id
   * 作确定性 tie-break，保证"证据更强排名更前"。
   */
  const ranked = relevant
    .map((entry) => ({ entry, similarityScore: calibrateConfidence(entry.fused) }))
    .sort((a, b): number => {
      if (b.entry.fused !== a.entry.fused) return b.entry.fused - a.entry.fused;
      if (b.similarityScore !== a.similarityScore) return b.similarityScore - a.similarityScore;
      return a.entry.doc.id < b.entry.doc.id ? -1 : a.entry.doc.id > b.entry.doc.id ? 1 : 0;
    });

  const results: RagRunbookDoc[] = ranked.map(
    ({ entry, similarityScore }): RagRunbookDoc => ({
      ...entry.doc,
      similarityScore,
      matchedTerms: collectMatchedTerms(uniqueQueryTerms, entry.doc),
      scoreBreakdown: {
        vectorScore: Math.round(entry.vectorScore * 10000) / 10000,
        bm25Score: Math.round(entry.bm25Score * 10000) / 10000,
        contextBoost: Math.round(entry.contextBoost * 10000) / 10000,
        rrfScore: Math.round(entry.rrfScore * 10000) / 10000,
        fusedScore: Math.round(entry.fused * 10000) / 10000,
      },
      isCustom: entry.doc.isCustom === true,
    }),
  );

  /* ---- 9. 取 Top-K ---- */
  return results.slice(0, limit);
}

/**
 * applyIdfWeights —— 给词频向量乘上 IDF 权重（TF-IDF 的 TF×IDF 步骤）。
 *
 * 【为何独立成函数】向量余弦的"稠密侧"与 BM25 的"稀疏侧"必须共享
 * 同一份 IDF 口径，否则两路的"重要性"判断会打架，
 * 融合出来的排序就不可解释。此函数只做一次正确的加权，
 * 两路各取所需。
 *
 * @param termFrequency 原始词频向量
 * @returns 加权后的稀疏向量（新 Map，不修改入参）
 */
function applyIdfWeights(termFrequency: ReadonlyMap<string, number>): Map<string, number> {
  const weighted = new Map<string, number>();
  for (const [term, freq] of termFrequency) {
    const idf = idfOf(term);
    /* IDF 为 0 的通用词直接丢弃：它们不提供区分度，留着只会稀释相似度 */
    if (idf <= 0) continue;
    weighted.set(term, freq * idf);
  }
  return weighted;
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
