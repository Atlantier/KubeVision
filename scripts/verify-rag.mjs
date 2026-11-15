#!/usr/bin/env node
/**
 * KubeVision AI — RAG 校准与 IDF 缓存指纹验证（scripts/verify-rag.mjs）
 *
 * 【验证 C5 + C6】
 * C5：calibrateConfidence 的分段边界必须**连续、单调、无跳变**；
 *     排序必须按原始融合分（证据更强排名更前）。
 * C6：IDF 缓存指纹必须覆盖全部文档内容——编辑中间某篇正文也要失效。
 *
 * 【为何能直接跑真实引擎】sreRagEngine 只依赖 zod（运行期）与两个类型导入
 * （编译期擦除），因此可用 tsc 单文件转译为 CJS 后直接 require，
 * 断言的是**生产代码本身**，不是复制品。
 *
 * 【用法】node scripts/verify-rag.mjs
 */

import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const ROOT = dirname(fileURLToPath(new URL('.', import.meta.url)));
const OUT = join(ROOT, 'tmp-rag-verify');
process.on('exit', () => {
  try { rmSync(OUT, { recursive: true, force: true }); } catch { /* ignore */ }
});

let pass = 0;
let fail = 0;
const ok = (name, detail) => {
  pass += 1;
  console.log(`  ✓ ${name}${detail ? `  ::  ${detail}` : ''}`);
};
const bad = (name, actual, why) => {
  fail += 1;
  console.log(`  ✗ ${name}  ::  ${why}  实际=${JSON.stringify(actual)}`);
};
const is = (name, actual, expected) => {
  if (JSON.stringify(actual) === JSON.stringify(expected)) ok(name, JSON.stringify(expected));
  else bad(name, actual, `期望 ${JSON.stringify(expected)}`);
};

if (existsSync(OUT)) rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
{
  const embSource = readFileSync(join(ROOT, 'src/utils/runbookEmbeddings.ts'), 'utf8');
  const embResult = ts.transpileModule(embSource, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    fileName: 'runbookEmbeddings.ts',
  });
  writeFileSync(join(OUT, 'runbookEmbeddings.cjs'), embResult.outputText, 'utf8');

  const source = readFileSync(join(ROOT, 'src/utils/sreRagEngine.ts'), 'utf8');
  const result = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    fileName: 'sreRagEngine.ts',
  });
  const rewritten = result.outputText.replace(
    /require\((['"])@\/utils\/runbookEmbeddings\1\)/g,
    'require("./runbookEmbeddings.cjs")',
  );
  writeFileSync(join(OUT, 'sreRagEngine.cjs'), rewritten, 'utf8');
}
const { calibrateConfidence, computeCorpusFingerprint, retrieveSreRunbooks } = require(
  join(OUT, 'sreRagEngine.cjs'),
);
const { EMBEDDING_MODEL_META } = require(join(OUT, 'runbookEmbeddings.cjs'));

console.log('KubeVision AI — RAG 校准与指纹验证\n');

/* ========================================================================== */
/* 1. C5：旧实现的边界跳变（作为对照）                                           */
/* ========================================================================== */

/** 旧实现（仅用于对照，复刻修复前的公式） */
function oldCalibrate(fused) {
  const s = Math.max(0, Math.min(1, fused));
  let raw;
  if (s >= 0.55) raw = 1 / (1 + Math.exp(-((s - 0.55) * 4.36 + 1.516)));
  else if (s >= 0.28) raw = 1 / (1 + Math.exp(-((s - 0.28) * 4.18 - 0.848)));
  else raw = 1 / (1 + Math.exp(-((s - 0.1) * 5.0 - 1.119)));
  return Math.round(raw * 10000) / 10000;
}

console.log('▸ 1. 分段边界连续性（旧 vs 新）');
{
  const points = [0.28, 0.55];
  for (const boundary of points) {
    const oldLeft = oldCalibrate(boundary - 0.0001);
    const oldRight = oldCalibrate(boundary);
    const newLeft = calibrateConfidence(boundary - 0.0001);
    const newRight = calibrateConfidence(boundary);
    const oldJump = Math.abs(oldRight - oldLeft);
    const newJump = Math.abs(newRight - newLeft);
    console.log(
      `    s=${boundary}: 旧 ${oldLeft} → ${oldRight}（跳变 ${oldJump.toFixed(4)}） | 新 ${newLeft} → ${newRight}（跳变 ${newJump.toFixed(4)}）`,
    );
    if (newJump <= 0.002) ok(`s=${boundary} 新实现在边界连续`, `跳变 ${newJump.toFixed(4)} ≤ 0.002`);
    else bad(`s=${boundary} 新实现在边界连续`, { oldLeft, oldRight, newLeft, newRight }, '仍存在跳变');
    if (oldJump >= 0.1) ok(`s=${boundary} 旧实现确实存在跳变（缺陷可复现）`, `跳变 ${oldJump.toFixed(4)}`);
    else bad(`s=${boundary} 旧实现确实存在跳变`, oldJump, '对照基线不成立');
  }
}

/* ========================================================================== */
/* 2. 单调性 + 值域                                                             */
/* ========================================================================== */
console.log('▸ 2. 单调性与值域');
{
  let monotonic = true;
  let worstDrop = 0;
  let previous = calibrateConfidence(0);
  for (let i = 1; i <= 1000; i += 1) {
    const s = i / 1000;
    const current = calibrateConfidence(s);
    if (current < previous - 1e-9) {
      monotonic = false;
      worstDrop = Math.max(worstDrop, previous - current);
    }
    previous = current;
  }
  is('2.1 全区间单调不减', monotonic, true);
  const low = calibrateConfidence(0);
  const high = calibrateConfidence(1);
  if (low >= 0.02 && high <= 0.99 && high > low) ok('2.2 值域合理（不贴 0 也不宣称 100%）', `${low} ～ ${high}`);
  else bad('2.2 值域合理', { low, high }, '值域异常');
}

/* ========================================================================== */
/* 3. 校准前后对照表                                                             */
/* ========================================================================== */
console.log('▸ 3. 校准前后对照表');
const tableRows = [];
for (const fused of [0.1, 0.2, 0.28, 0.4, 0.55, 0.7, 0.9]) {
  tableRows.push({ fused, before: oldCalibrate(fused), after: calibrateConfidence(fused) });
}
console.log('    | 融合分 | 修复前 | 修复后 |');
console.log('    |---|---|---|');
for (const row of tableRows) {
  console.log(`    | ${row.fused.toFixed(2)} | ${row.before.toFixed(4)} | ${row.after.toFixed(4)} |`);
}

/* ========================================================================== */
/* 4. C6：IDF 指纹必须感知正文编辑                                               */
/* ========================================================================== */
console.log('▸ 4. IDF 缓存指纹');
{
  const base = [
    {
      id: 'rb-a',
      title: 'Pod OOMKilled 应急处置',
      symptom: 'container killed exit 137',
      category: 'memory',
      tags: ['oom'],
      featureVocabulary: ['oomkilled', 'exit 137'],
      rootCauseMechanism: 'cgroup memory limit exceeded',
      remediationSteps: ['raise limit'],
      isCustom: false,
    },
    {
      id: 'rb-b',
      title: '节点 CPU 饱和处置',
      symptom: 'node cpu spike throttling',
      category: 'cpu',
      tags: ['cpu'],
      featureVocabulary: ['throttl'],
      rootCauseMechanism: 'cpu contention',
      remediationSteps: ['evict'],
      isCustom: false,
    },
    {
      id: 'rb-c',
      title: '网络丢包处置',
      symptom: 'packet loss vxlan timeout',
      category: 'network',
      tags: ['network'],
      featureVocabulary: ['vxlan'],
      rootCauseMechanism: 'mtu mismatch',
      remediationSteps: ['fix mtu'],
      isCustom: false,
    },
  ];
  /* 编辑中间文档正文：文档数、首末 id 均不变 */
  const edited = base.map((doc, index) =>
    index === 1 ? { ...doc, symptom: 'node cpu spike throttling (edited content)' } : doc,
  );
  const fpBase = computeCorpusFingerprint(base);
  const fpEdited = computeCorpusFingerprint(edited);
  const oldFingerprint = (corpus) =>
    corpus.length === 0 ? '0' : `${corpus.length}|${corpus[0].id}|${corpus[corpus.length - 1].id}`;

  console.log(`    指纹: 原 ${fpBase} · 编辑后 ${fpEdited}`);
  if (fpBase !== fpEdited) ok('4.1 编辑中间文档正文 → 指纹变化（缓存失效）');
  else bad('4.1 编辑中间文档正文 → 指纹变化', { fpBase, fpEdited }, '指纹未变化');
  if (oldFingerprint(base) === oldFingerprint(edited)) {
    ok('4.2 旧指纹确实无法感知该编辑（缺陷可复现）', oldFingerprint(base));
  } else {
    bad('4.2 旧指纹确实无法感知该编辑', null, '对照基线不成立');
  }
  is('4.3 相同语料指纹稳定', computeCorpusFingerprint(base.slice()), fpBase);
}

/* ========================================================================== */
/* 5. 排序：证据更强排名更前                                                     */
/* ========================================================================== */
console.log('▸ 5. 排序依据（原始融合分）');
{
  const faultQueries = [
    ['pod OOMKilled memory limit exit 137 container killed', 'POD_OOM_SWARM'],
    ['node cpu spike high load saturation throttling', 'NODE_CPU_SPIKE'],
    ['packet loss vxlan connection timeout network partition', 'NET_PACKET_LOSS'],
    ['no space left on device disk full write failed', 'NONE'],
  ];
  let orderingOk = true;
  let checkedPairs = 0;
  for (const [query, chaos] of faultQueries) {
    const hits = retrieveSreRunbooks(query, chaos, [], 3);
    for (let i = 1; i < hits.length; i += 1) {
      const prevFused = hits[i - 1].scoreBreakdown?.fusedScore ?? 0;
      const currFused = hits[i].scoreBreakdown?.fusedScore ?? 0;
      if (prevFused < currFused) orderingOk = false;
      checkedPairs += 1;
    }
  }
  if (orderingOk) ok('5.1 各查询结果按 fused 降序（证据更强更前）', `检查 ${checkedPairs} 对相邻结果`);
  else bad('5.1 各查询结果按 fused 降序', { checkedPairs }, '存在逆序');

  /* 强查询必须比无关键查询置信度高 */
  const strong = retrieveSreRunbooks('pod OOMKilled memory limit exit 137', 'POD_OOM_SWARM', [], 1)[0];
  const weak = retrieveSreRunbooks('hello there general kenobi', 'NONE', [], 1)[0];
  const strongScore = strong?.similarityScore ?? 0;
  const weakScore = weak?.similarityScore ?? 0;
  if (strongScore > weakScore) ok('5.2 强证据查询置信度高于无关键查询', `强 ${strongScore} > 弱 ${weakScore}`);
  else bad('5.2 强证据查询置信度高于无关键查询', { strongScore, weakScore }, '排序/校准异常');
}

/* ========================================================================== */
/* 6. 真实接口前后对比（/api/verify/rag）                                        */
/* ========================================================================== */
console.log('▸ 6. 接口前后对比（需 dev server）');
{
  const beforePath = join(ROOT, 'tmp-rag-before.json');
  let afterRows = null;
  try {
    const body = readFileSync(join(ROOT, 'tmp-rag-before-body.json'), 'utf8');
    const res = await fetch('http://127.0.0.1:3000/api/verify/rag', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      signal: AbortSignal.timeout(30000),
    });
    const json = await res.json();
    afterRows = json.results ?? null;
  } catch {
    afterRows = null;
  }
  if (afterRows !== null && existsSync(beforePath)) {
    const beforeRaw = readFileSync(beforePath, 'utf8').replace(/^\uFEFF/, '');
    const beforeRows = JSON.parse(beforeRaw).results ?? [];
    const labels = ['OOM 故障', 'CPU 故障', '网络故障', '磁盘故障', '无关键 1', '无关键 2'];
    console.log('    | 用例 | topId | 修复前分数 | 修复后分数 |');
    console.log('    |---|---|---|---|');
    beforeRows.forEach((row, index) => {
      const after = afterRows[index] ?? {};
      console.log(
        `    | ${labels[index] ?? 'case-' + index} | ${after.topId ?? '—'} | ${Number(row.score).toFixed(4)} | ${Number(after.score ?? 0).toFixed(4)} |`,
      );
    });
    const noKeyOk = beforeRows[4]?.topId === null && afterRows[4]?.topId === null;
    if (noKeyOk) ok('6.1 无关键查询前后均拒绝硬凑（topId=null）');
    else bad('6.1 无关键查询前后均拒绝硬凑', { before: beforeRows[4], after: afterRows[4] }, '出现硬凑');
  } else {
    console.log('    ○ 跳过（dev server 不可用或缺少 before 数据）');
  }
}

console.log('\n▸ 7. M11 + M12 真实通道消融开关与模型元数据验证');
{
  is('7.1 嵌入模型元数据声明 384 维 MiniLM', EMBEDDING_MODEL_META.dimension === 384 && EMBEDDING_MODEL_META.modelId.includes('MiniLM'), true);

  // Use RagQueryOptions fields in genuine channel ablation assertions
  const fullHits = retrieveSreRunbooks('pod OOMKilled Exit Code 137 memory leak', 'POD_OOM_SWARM', ['payment-gateway-7f8b9-x2k'], 2);
  const noSemHits = retrieveSreRunbooks('pod OOMKilled Exit Code 137 memory leak', 'POD_OOM_SWARM', ['payment-gateway-7f8b9-x2k'], 2, [], undefined, { disableSemantic: true });
  const noBm25Hits = retrieveSreRunbooks('pod OOMKilled Exit Code 137 memory leak', 'POD_OOM_SWARM', ['payment-gateway-7f8b9-x2k'], 2, [], undefined, { disableBm25: true });
  const noCtxHits = retrieveSreRunbooks('pod OOMKilled Exit Code 137 memory leak', 'POD_OOM_SWARM', ['payment-gateway-7f8b9-x2k'], 2, [], undefined, { disableContextBoost: true });

  is('7.2 全通道与各单消融组均能召回 RUNBOOK-K8S-042', [fullHits[0]?.id, noSemHits[0]?.id, noBm25Hits[0]?.id, noCtxHits[0]?.id].every((id) => id === 'RUNBOOK-K8S-042'), true);
  is('7.3 disableSemantic 真实将 vectorScore 置 0', noSemHits[0]?.scoreBreakdown?.vectorScore === 0 && (noSemHits[0]?.scoreBreakdown?.bm25Score ?? 0) > 0, true);
  is('7.4 disableBm25 真实将 bm25Score 置 0', noBm25Hits[0]?.scoreBreakdown?.bm25Score === 0 && (noBm25Hits[0]?.scoreBreakdown?.vectorScore ?? 0) > 0, true);
  is('7.5 disableContextBoost 真实将 contextBoost 置 0 且降低或保持分数区分度', noCtxHits[0]?.scoreBreakdown?.contextBoost === 0 && (fullHits[0]?.scoreBreakdown?.contextBoost ?? 0) > 0, true);

  /* M12：去除 activeChaos 标签泄露对照 —— chaos 置 NONE 时仅凭可观测现象文本应仍命中对应排障手册 */
  const noChaosOom = retrieveSreRunbooks('容器 Exit Code 137 内存到达 cgroup 上限被内核触发 OOMKilled', 'NONE', [], 2);
  const noChaosCpu = retrieveSreRunbooks('节点 CPU 使用率高于 90% 触发 cfs quota throttling 调度阻塞', 'NONE', [], 2);
  const noChaosNet = retrieveSreRunbooks('节点 NotReady 发生网络分区 CNI calico conntrack 打满引起 packet loss', 'NONE', [], 2);
  is('7.6a 去 activeChaos 标签泄露对照（NONE 凭 OOM 症状召回 Top-1 = RUNBOOK-K8S-042）', noChaosOom[0]?.id ?? null, 'RUNBOOK-K8S-042');
  is('7.6b 去 activeChaos 标签泄露对照（NONE 凭 CPU 症状召回 Top-1 = RUNBOOK-K8S-051）', noChaosCpu[0]?.id ?? null, 'RUNBOOK-K8S-051');
  is('7.6c 去 activeChaos 标签泄露对照（NONE 凭网络症状召回 Top-1 = RUNBOOK-K8S-061）', noChaosNet[0]?.id ?? null, 'RUNBOOK-K8S-061');
}

rmSync(OUT, { recursive: true, force: true });
console.log(`\n汇总: 通过 ${pass} · 失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);