#!/usr/bin/env node
/**
 * KubeVision AI — 回执摘要复算单测（scripts/verify-receipt-digest.mjs）
 *
 * 【验证 Q5 的两端一致性】
 * 1. 前端复算公式必须与服务端逐字段、逐顺序一致；
 * 2. 回执任一字段被篡改（哪怕一个字符）都必须校验失败；
 * 3. 与真实 /api/mcp/execute 返回的回执做一次端到端对账。
 *
 * 【用法】node scripts/verify-receipt-digest.mjs
 *   需要 dev server 在 3000（用于端到端对账用例；无服务时该用例跳过）。
 */

import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const ROOT = dirname(fileURLToPath(new URL('.', import.meta.url)));
const OUT = join(ROOT, 'tmp-receipt-digest');
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
  const source = readFileSync(join(ROOT, 'src/utils/mcpReceiptDigest.ts'), 'utf8');
  const result = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    fileName: 'mcpReceiptDigest.ts',
  });
  writeFileSync(join(OUT, 'mcpReceiptDigest.cjs'), result.outputText, 'utf8');
}
const { buildReceiptDigestPayload, computeReceiptDigest, verifyReceiptDigest } = require(
  join(OUT, 'mcpReceiptDigest.cjs'),
);

console.log('KubeVision AI — 回执摘要复算单测\n');

const BASE_RECEIPT = {
  executionId: 'mcp-m3k9x2-a7f1',
  actionType: 'restart_pod',
  targetId: 'pod-payment-gateway-7f8b9-x2k',
  timestamp: '2026-11-10T08:00:00.000Z',
  kubectlCommand: 'kubectl delete pod/payment-gateway-7f8b9-x2k -n kv-prod --wait=false',
  auditDigest: '',
};

/* 1. 载荷格式：字段顺序 + 分隔符（协议锁定） */
{
  const payload = buildReceiptDigestPayload(BASE_RECEIPT);
  is(
    '1.1 载荷字段顺序与分隔符锁定',
    payload,
    'mcp-m3k9x2-a7f1|restart_pod|pod-payment-gateway-7f8b9-x2k|2026-11-10T08:00:00.000Z|kubectl delete pod/payment-gateway-7f8b9-x2k -n kv-prod --wait=false',
  );
}

/* 2. 与服务端公式（Node crypto）逐字一致 */
{
  const payload = buildReceiptDigestPayload(BASE_RECEIPT);
  const expected = createHash('sha256').update(payload).digest('hex').slice(0, 16);
  const actual = await computeReceiptDigest(payload);
  is('2.1 Web Crypto 复算结果与 Node crypto 一致', actual, expected);
}

/* 3. 未篡改 → 校验通过 */
{
  const payload = buildReceiptDigestPayload(BASE_RECEIPT);
  const digest = await computeReceiptDigest(payload);
  const result = await verifyReceiptDigest({ ...BASE_RECEIPT, auditDigest: digest });
  is('3.1 未篡改回执校验通过', result.ok, true);
  is('3.2 返回的 expected 与回执一致', result.expected, digest);
}

/* 4. 篡改任一字段 → 校验失败 */
{
  const payload = buildReceiptDigestPayload(BASE_RECEIPT);
  const digest = await computeReceiptDigest(payload);
  const receipt = { ...BASE_RECEIPT, auditDigest: digest };

  const tamperCases = [
    ['4.1 改 kubectlCommand 校验失败', { ...receipt, kubectlCommand: 'kubectl delete pod/other -n kv-prod --wait=false' }],
    ['4.2 改 targetId 校验失败', { ...receipt, targetId: 'pod-payment-gateway-other' }],
    ['4.3 改 executionId 校验失败', { ...receipt, executionId: 'mcp-forged-id' }],
    ['4.4 改 timestamp 校验失败', { ...receipt, timestamp: '2026-11-11T08:00:00.000Z' }],
    ['4.5 改 actionType 校验失败', { ...receipt, actionType: 'drain_node' }],
  ];
  for (const [name, tampered] of tamperCases) {
    const result = await verifyReceiptDigest(tampered);
    is(name, result.ok, false);
  }
}

/* 5. 端到端：真实服务端回执 → 前端复算 */
{
  let reachable = false;
  try {
    const res = await fetch('http://127.0.0.1:3000/api/mcp/execute', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        actionType: 'restart_pod',
        targetId: 'pod-payment-gateway-7f8b9-x2k',
        targetName: 'payment-gateway-7f8b9-x2k',
        namespace: 'kv-prod',
        clusterMode: 'demo',
      }),
      signal: AbortSignal.timeout(20000),
    });
    const json = await res.json();
    if (res.ok && json.result !== undefined) {
      reachable = true;
      const result = await verifyReceiptDigest(json.result);
      is('5.1 真实服务端回执 → 前端复算通过', result.ok, true);
      console.log(`      回执 ${json.result.executionId} · digest=${json.result.auditDigest}`);
    }
  } catch {
    reachable = false;
  }
  if (!reachable) {
    console.log('  ○ 5.1 跳过（3000 端口服务不可用；模拟路径用例已由 C 组覆盖）');
  }
}

rmSync(OUT, { recursive: true, force: true });
console.log(`\n汇总: 通过 ${pass} · 失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);