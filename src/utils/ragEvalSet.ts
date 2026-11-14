/**
 * KubeVision AI — RAG 评测集（R42 · Phase 2）
 *
 * 【构造原则】
 * - 基于真实内置语料 `SRE_RUNBOOK_CORPUS` 生成用例，期望文档 id 来自语料本身，
 *   不用手写 id 字符串（避免 id 漂移导致评测静默失真）；
 * - 覆盖三类真实提问形态：**中文口语 / 错别字 / 中英混杂**；
 * - 负例 8 条（寒暄 / 无关 / 跨域），用于统计负例拒答率；
 * - 多文档相关 5 条（分级 2/1/0），用于 NDCG；
 * - 全部纯数据 + 纯函数，无随机、无副作用，可在 dev 路由中稳定复现。
 */

import { SRE_RUNBOOK_CORPUS } from '@/utils/sreRagEngine';

/** 用例类别 */
export type RagEvalKind = 'colloquial' | 'typo' | 'mixed' | 'negative' | 'multi';

/** 一条评测用例 */
export interface RagEvalCase {
  /** 用例 id */
  readonly id: string;
  /** 类别 */
  readonly kind: RagEvalKind;
  /** 查询文本 */
  readonly query: string;
  /** 期望命中的文档 id（负例为空数组） */
  readonly expectedIds: readonly string[];
  /** 分级相关度（多文档用例使用；缺省视为 1） */
  readonly grades?: Readonly<Record<string, number>>;
}

/**
 * typoize —— 对英文术语做一个"真实错别字"变体（模拟手滑/记忆偏差）。
 *
 * 【做法】把单词里第一个出现的连续相同字符或常见元音做一次替换/漏写，
 * 保证结果与原文不同；若无法变形则退化为在末尾加一个重复字符。
 *
 * @param word 原始英文词
 * @returns 错别字变体
 */
function typoize(word: string): string {
  if (word.length < 4) return word + word.slice(-1);
  /* 1) 双写字符漏写：oomkilled → omkilled */
  const doubled = word.match(/(.)\1/);
  if (doubled !== null && doubled.index !== undefined) {
    return word.slice(0, doubled.index) + word.slice(doubled.index + 1);
  }
  /* 2) 元音替换：memory → memery */
  for (let i = word.length - 1; i >= 0; i -= 1) {
    const char = word[i];
    if (char === 'a') return `${word.slice(0, i)}e${word.slice(i + 1)}`;
    if (char === 'e') return `${word.slice(0, i)}a${word.slice(i + 1)}`;
    if (char === 'i') return `${word.slice(0, i)}e${word.slice(i + 1)}`;
    if (char === 'o') return `${word.slice(0, i)}u${word.slice(i + 1)}`;
  }
  /* 3) 兜底 */
  return `${word}x`;
}

/**
 * buildRagEvalSet —— 生成完整评测集。
 *
 * @returns 评测用例数组（12×3 正例 + 8 负例 + 5 多文档）
 */
/**
 * 各权威 Runbook 的自然错别字查询模板（替代旧版统一的「... 报错怎么排查」模板）。
 *
 * 【为何弃用统一模板】旧模板在全部 12 条错别字用例末尾拼入相同后缀「报错怎么排查」，
 * 导致 2-way 引擎在英文关键词因拼写错误而失灵时，仅凭「排查」二字即可在固定子集上
 * 拿到虚高的 Recall@3。现改用贴近各自故障语境的差异化真实口语 + typoize 错拼词，
 * 既消除共享模板泄漏，又真实检验三路 MiniLM 语义向量对拼写噪声的容错收益。
 */
const DOMAIN_TYPO_QUERIES: Readonly<Record<string, string>> = {
  'RUNBOOK-K8S-042': `容器触发 ${typoize('oomkilled')} 内存限制被强杀重启`,
  'RUNBOOK-K8S-043': `业务副本持续处于 ${typoize('crashloopbackoff')} 探针反复失败`,
  'RUNBOOK-K8S-051': `工作节点 CPU 发生 ${typoize('throttling')} 调度阻塞延时升高`,
  'RUNBOOK-K8S-052': `高水位节点依据 ${typoize('qos')} 分级机制触发资源驱逐`,
  'RUNBOOK-K8S-061': `跨节点 ${typoize('network')} 分区导致插件转发与连通中断`,
  'RUNBOOK-K8S-062': `隧道链路 ${typoize('vxlan')} 封装丢包与分片延时毛刺`,
  'RUNBOOK-K8S-071': `新建 Pod 状态停在 ${typoize('pending')} 调度队列无法绑定`,
  'RUNBOOK-K8S-081': `集群容器域名解析 ${typoize('coredns')} 返回超时或解析失败`,
  'RUNBOOK-K8S-091': `节点从私有仓库拉取 ${typoize('image')} 提示认证异常失败`,
  'RUNBOOK-K8S-101': `控制平面 ${typoize('etcd')} 成员心跳失联引发选主延迟`,
  'SRE-RB-011': `API 入口队列 ${typoize('apiserver')} 限流堆积返回 429 拒载`,
  'SRE-RB-012': `私有仓库 ${typoize('harbor')} 拉取镜像触发 ${typoize('imagepullbackoff')} 证书或凭据失效`,
};

/**
 * buildRagEvalSet —— 构造完整 49 条评测集（12×3 + 5 多文档 + 8 负例）。
 */
export function buildRagEvalSet(): RagEvalCase[] {
  const cases: RagEvalCase[] = [];
  const docs = SRE_RUNBOOK_CORPUS;

  docs.forEach((doc, index): void => {
    const tags = doc.tags ?? [];
    const primaryTag = tags[0] ?? doc.category;
    const secondaryTag = tags[1] ?? doc.category;
    const shortTitle = doc.title.split('（')[0] ?? doc.title;

    /* 中文口语 */
    cases.push({
      id: `c${index + 1}-colloquial`,
      kind: 'colloquial',
      query: `${shortTitle} 这个情况一般怎么处理啊`,
      expectedIds: [doc.id],
    });

    /* 错别字（差异化故障症状 + 英文术语错拼变体，消除共享后缀泄漏） */
    const typoQuery =
      DOMAIN_TYPO_QUERIES[doc.id] ?? `${shortTitle} 发生 ${typoize(primaryTag)} 指标异常波动`;
    cases.push({
      id: `c${index + 1}-typo`,
      kind: 'typo',
      query: typoQuery,
      expectedIds: [doc.id],
    });

    /* 中英混杂 */
    cases.push({
      id: `c${index + 1}-mixed`,
      kind: 'mixed',
      query: `${primaryTag} ${secondaryTag} error 怎么定位`,
      expectedIds: [doc.id],
    });
  });

  /* 负例：寒暄 / 无关 / 跨域（应被拒答） */
  const negatives = [
    '你好，今天天气怎么样',
    '帮我写一首关于秋天的诗',
    'React 的 useEffect 依赖数组该怎么写',
    'Python pandas 怎么合并两个表格',
    '红烧肉的家常做法',
    '解释一下量子纠缠是什么意思',
    '帮我订一张明天去上海的机票',
    '推荐几部好看的科幻电影',
  ];
  negatives.forEach((query, index): void => {
    cases.push({
      id: `neg-${index + 1}`,
      kind: 'negative',
      query,
      expectedIds: [],
    });
  });

  /* 多文档相关：跨类别故障并发（分级 2/1） */
  const multi: ReadonlyArray<{ query: string; first: number; second: number }> = [
    { query: 'Pod 内存超限 OOM 同时节点 CPU 饱和了怎么处理', first: 0, second: 2 },
    { query: '网络分区 CNI 丢包 同时 VXLAN 隧道 MTU 错配', first: 4, second: 5 },
    { query: 'Pod Pending 调度不上去 同时镜像拉取失败', first: 6, second: 8 },
    { query: 'etcd 健康度异常 同时 API Server 限流 429 堆积', first: 9, second: 10 },
    { query: 'CrashLoopBackOff 崩溃循环 同时 HighLoad 水位治理', first: 1, second: 3 },
  ];
  multi.forEach((item, index): void => {
    const firstDoc = docs[item.first];
    const secondDoc = docs[item.second];
    if (firstDoc === undefined || secondDoc === undefined) return;
    cases.push({
      id: `multi-${index + 1}`,
      kind: 'multi',
      query: item.query,
      expectedIds: [firstDoc.id, secondDoc.id],
      grades: { [firstDoc.id]: 2, [secondDoc.id]: 1 },
    });
  });

  return cases;
}