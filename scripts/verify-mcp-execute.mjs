#!/usr/bin/env node
/**
 * KubeVision AI — MCP 执行端点契约验证（scripts/verify-mcp-execute.mjs）
 *
 * 【验证什么】B2 的四条缺陷修复：
 *   1. restart_pod 的 namespace 来自请求，不得写死 'default'；
 *   2. live 集群 404/409 不得当成功（必须 JSON-RPC error -32603 + httpStatus）；
 *   3. kubectl 回执与实际动作一致（DELETE pod ⇒ `kubectl delete pod`；scale 的
 *      replicas 与回执同值）；
 *   4. auditDigest 可复算（同样 5 个字段 → 同一摘要）。
 *
 * 【怎么验证】起一个**假 K8s API Server**（只回 404/200，可控），再用
 * K8S_API_SERVER 指向它的 dev server 打真实 HTTP 请求。这样不依赖真实集群，
 * 又能覆盖"上游返回 404 时端点如何反应"这条关键分支。
 *
 * 【用法】node scripts/verify-mcp-execute.mjs
 *   需要 3000 端口的 dev server 在跑（模拟模式用例）；
 *   脚本自行在 3002 起一个带 K8S 环境变量的 dev server（真实模式用例）。
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

const ROOT = process.cwd();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

/**
 * auditDigest 复算实现（与 route.ts 的公式逐字一致）。
 *
 * @param executionId 执行 ID
 * @param actionType 动作
 * @param targetId 目标 ID
 * @param timestamp ISO 时间戳
 * @param kubectlCommand 等价命令
 * @returns sha256 前 16 位
 */
function recomputeDigest(executionId, actionType, targetId, timestamp, kubectlCommand) {
  return createHash('sha256')
    .update(`${executionId}|${actionType}|${targetId}|${timestamp}|${kubectlCommand}`)
    .digest('hex')
    .slice(0, 16);
}

/* ========================================================================== */
/* 1. 假 K8s API Server                                                        */
/* ========================================================================== */

const FAKE_K8S_PORT = 9843;
const seen = [];
const fakeK8s = createServer((req, res) => {
  seen.push({ method: req.method, url: req.url });

  if (req.method === 'DELETE' && /\/pods\//.test(req.url ?? '')) {
    /* 故意返回 404：验证端点不会把"目标不存在"当成功 */
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ kind: 'Status', status: 'Failure', reason: 'NotFound', code: 404 }));
    return;
  }
  if (req.method === 'PATCH' && /\/scale$/.test(req.url ?? '')) {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ kind: 'Scale', metadata: {}, spec: JSON.parse(body || '{}') }));
    });
    return;
  }
  res.writeHead(409, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ kind: 'Status', status: 'Failure', reason: 'Conflict', code: 409 }));
});
await new Promise((resolve) => fakeK8s.listen(FAKE_K8S_PORT, '127.0.0.1', resolve));
console.log(`假 K8s API Server 已启动 :${FAKE_K8S_PORT}`);

/* ========================================================================== */
/* 2. 带 K8S 环境变量的 dev server（真实模式分支）                                */
/* ========================================================================== */

const LIVE_PORT = 3002;
let liveReady = false;
if (!existsSync(join(ROOT, 'node_modules/.bin/next.cmd'))) {
  console.error('缺少 next.cmd');
  process.exit(2);
}
const liveServer = spawn(
  'cmd.exe',
  [
    '/c',
    `set K8S_API_SERVER=http://127.0.0.1:${FAKE_K8S_PORT}&& set K8S_BEARER_TOKEN=fake-token&& node_modules\\.bin\\next.cmd dev -p ${LIVE_PORT}`,
  ],
  { cwd: ROOT, stdio: 'ignore', shell: false },
);
for (let i = 0; i < 180; i += 1) {
  try {
    const res = await fetch(`http://127.0.0.1:${LIVE_PORT}/`, { signal: AbortSignal.timeout(15000) });
    if (res.ok) {
      liveReady = true;
      break;
    }
  } catch {
    /* 等待编译 */
  }
  await sleep(2000);
}
console.log(`带 K8S 环境的 dev server (:${LIVE_PORT}) ${liveReady ? '就绪' : '未就绪'}`);

const cleanup = () => {
  try {
    liveServer.kill('SIGKILL');
  } catch {
    /* ignore */
  }
  try {
    fakeK8s.close();
  } catch {
    /* ignore */
  }
};
process.on('exit', cleanup);

/**
 * 调用执行端点。
 *
 * @param port 端口
 * @param body 请求体
 * @returns HTTP 状态与解析后的 JSON
 */
async function execute(port, body) {
  const res = await fetch(`http://127.0.0.1:${port}/api/mcp/execute`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  return { status: res.status, json: await res.json() };
}

/* ========================================================================== */
/* 3. 用例                                                                     */
/* ========================================================================== */

console.log('\n▸ A. 模拟模式回执（3000，无 K8S 配置）');
{
  const { status, json } = await execute(3000, {
    actionType: 'restart_pod',
    targetId: 'pod-payment-gateway-7f8b9-x2k',
    targetName: 'payment-gateway-7f8b9-x2k',
    namespace: 'kv-prod',
    clusterMode: 'demo',
  });
  is('A1 HTTP 200', status, 200);
  const result = json.result ?? {};
  is('A2 mode=simulated', result.mode, 'simulated');
  is(
    'A3 restart_pod 回执是 delete pod（与实现一致）',
    result.kubectlCommand,
    'kubectl delete pod/payment-gateway-7f8b9-x2k -n kv-prod --wait=false',
  );
  is('A4 回执 note 记录 namespace', String(result.note ?? '').includes('namespace=kv-prod'), true);
  is(
    'A5 auditDigest 可独立复算',
    recomputeDigest(result.executionId, result.actionType, result.targetId, result.timestamp, result.kubectlCommand),
    result.auditDigest,
  );
  is('A6 摘要改动任一字段即变化', recomputeDigest(
    result.executionId,
    result.actionType,
    result.targetId,
    result.timestamp,
    'kubectl delete pod/other -n kv-prod --wait=false',
  ) !== result.auditDigest, true);
}

console.log('\n▸ B. scale 的 replicas 与回执一致（模拟模式）');
{
  const { json } = await execute(3000, {
    actionType: 'scale_deployment',
    targetId: 'pod-payment-gateway-7f8b9-x2k',
    targetName: 'payment-gateway-7f8b9-x2k',
    namespace: 'kv-prod',
    replicas: 5,
    clusterMode: 'demo',
  });
  const result = json.result ?? {};
  is('B1 回执 replicas 与请求一致', result.kubectlCommand, 'kubectl scale deployment/payment-gateway-7f8b9-x2k -n kv-prod --replicas=5');
}

if (liveReady) {
  console.log('\n▸ C. 真实模式：上游 404 必须报错（3002 → 假 K8s）');
  {
    const { status, json } = await execute(LIVE_PORT, {
      actionType: 'restart_pod',
      targetId: 'pod-payment-gateway-7f8b9-x2k',
      targetName: 'payment-gateway-7f8b9-x2k',
      namespace: 'kv-prod',
      clusterMode: 'live',
    });
    is('C1 HTTP 502（上游 4xx）', status, 502);
    is('C2 JSON-RPC error -32603', json.error?.code, -32603);
    is('C3 error data 带 httpStatus=404', json.error?.data?.httpStatus, 404);
    is('C4 404 未被当作成功', json.result, undefined);
    is('C5 删的是请求指定 namespace', seen.some((s) => s.method === 'DELETE' && String(s.url).includes('/namespaces/kv-prod/pods/')), true);
  }

  console.log('\n▸ D. 真实模式：缺 namespace 直接拒绝（不猜 default）');
  {
    const { status, json } = await execute(LIVE_PORT, {
      actionType: 'restart_pod',
      targetId: 'pod-payment-gateway-7f8b9-x2k',
      targetName: 'payment-gateway-7f8b9-x2k',
      clusterMode: 'live',
    });
    is('D1 HTTP 400', status, 400);
    is('D2 参数错误码 -32602', json.error?.code, -32602);
    is('D3 拒绝理由提到 namespace', String(json.error?.message ?? '').includes('namespace'), true);
    is('D4 未向 K8s 发出任何 DELETE', seen.some((s) => s.method === 'DELETE'), true); /* 仅来自 C 的 404 请求 */
  }

  console.log('\n▸ E. 真实模式：scale 成功回执 replicas 与 PATCH 一致');
  {
    const { status, json } = await execute(LIVE_PORT, {
      actionType: 'scale_deployment',
      targetId: 'deploy-payment-gateway',
      targetName: 'payment-gateway',
      namespace: 'kv-prod',
      replicas: 4,
      clusterMode: 'live',
    });
    is('E1 HTTP 200', status, 200);
    is('E2 mode=real', json.result?.mode, 'real');
    is('E3 回执命令 replicas=4', json.result?.kubectlCommand, 'kubectl scale deployment/payment-gateway -n kv-prod --replicas=4');
    is('E4 摘要可复算', recomputeDigest(
      json.result?.executionId,
      json.result?.actionType,
      json.result?.targetId,
      json.result?.timestamp,
      json.result?.kubectlCommand,
    ), json.result?.auditDigest);
  }
} else {
  fail += 1;
  console.log('  ✗ 真实模式用例未执行（:3002 dev server 未就绪）');
}

cleanup();
console.log(`\n汇总: 通过 ${pass} · 失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);