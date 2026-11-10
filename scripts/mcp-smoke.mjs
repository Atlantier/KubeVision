#!/usr/bin/env node
/**
 * KubeVision AI — MCP 冒烟测试（R38 · 追问 1）
 *
 * 等价于 MCP Inspector 的最小流程：initialize → tools/list → tools/call → ping，
 * 不依赖任何外部工具（只用 Node 18+ 原生 fetch），断言 JSON-RPC 2.0 结构合法。
 *
 * 用法：node scripts/mcp-smoke.mjs（需先 pnpm dev）
 * 退出码：0 = 全部通过；1 = 有断言失败。
 */

const BASE = process.env.KV_MCP_URL ?? 'http://127.0.0.1:3000/api/mcp';

let pass = 0;
let fail = 0;
const ok = (name, detail) => {
  pass += 1;
  console.log(`  ✓ ${name}${detail === undefined ? '' : `  ::  ${detail}`}`);
};
const bad = (name, detail) => {
  fail += 1;
  console.log(`  ✗ ${name}  ::  ${JSON.stringify(detail)}`);
};

/**
 * rpc —— 发一条 JSON-RPC 请求。
 *
 * @param body 请求体
 * @returns HTTP 状态与原始文本
 */
async function rpc(body) {
  const response = await fetch(BASE, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, text: await response.text() };
}

console.log('KubeVision AI — MCP 冒烟测试');
console.log(`  端点: ${BASE}\n`);

/* ---- 1. initialize ---- */
const init = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize' });
let initJson = null;
try {
  initJson = JSON.parse(init.text);
} catch {
  initJson = null;
}
if (init.status === 200 && initJson?.result?.protocolVersion === '2024-11-05') {
  ok('initialize', `protocolVersion=${initJson.result.protocolVersion}`);
} else {
  bad('initialize', { status: init.status, text: init.text.slice(0, 200) });
}
if (initJson?.result?.capabilities?.tools?.listChanged === false) {
  ok('initialize.capabilities.tools.listChanged=false');
} else {
  bad('initialize.capabilities', initJson?.result?.capabilities);
}
if (initJson?.result?.serverInfo?.name === 'kubevision-mcp' && initJson?.result?.serverInfo?.version === '1.0.0') {
  ok('initialize.serverInfo', JSON.stringify(initJson.result.serverInfo));
} else {
  bad('initialize.serverInfo', initJson?.result?.serverInfo);
}

/* ---- 2. tools/list ---- */
const list = await rpc({ jsonrpc: '2.0', id: 'smoke-list', method: 'tools/list' });
const listJson = (() => {
  try {
    return JSON.parse(list.text);
  } catch {
    return null;
  }
})();
const tools = listJson?.result?.tools;
const EXPECTED = ['restart_pod', 'scale_deployment', 'drain_node'];
if (Array.isArray(tools) && EXPECTED.every((name) => tools.some((tool) => tool.name === name))) {
  ok('tools/list 包含 3 个执行工具', tools.map((tool) => tool.name).join(', '));
} else {
  bad('tools/list', tools);
}
const schemasValid = Array.isArray(tools)
  ? tools.every(
      (tool) =>
        tool.inputSchema !== null &&
        typeof tool.inputSchema === 'object' &&
        tool.inputSchema.type === 'object' &&
        tool.inputSchema.properties !== null &&
        typeof tool.inputSchema.properties === 'object',
    )
  : false;
if (schemasValid) {
  ok('tools/list 每个工具都有 object 型 inputSchema');
} else {
  bad('tools/list inputSchema', tools);
}

/* ---- 3. tools/call（simulated 模式，断言审计字段） ---- */
const call = await rpc({
  jsonrpc: '2.0',
  id: 3,
  method: 'tools/call',
  params: {
    name: 'restart_pod',
    arguments: { targetName: 'worker-beta-6f9c', namespace: 'default', clusterMode: 'demo' },
  },
});
const callJson = (() => {
  try {
    return JSON.parse(call.text);
  } catch {
    return null;
  }
})();
const content = callJson?.result?.content;
const isError = callJson?.result?.isError;
const receipt = (() => {
  try {
    return JSON.parse(content[0].text);
  } catch {
    return null;
  }
})();
if (Array.isArray(content) && content[0]?.type === 'text' && isError === false && receipt !== null) {
  ok('tools/call 返回 content[] + isError:false');
} else {
  bad('tools/call 结构', { status: call.status, text: call.text.slice(0, 300) });
}
const receiptResult = receipt?.result;
if (
  receiptResult !== undefined &&
  typeof receiptResult.executionId === 'string' &&
  typeof receiptResult.kubectlCommand === 'string' &&
  typeof receiptResult.auditDigest === 'string' &&
  (receiptResult.mode === 'simulated' || receiptResult.mode === 'real')
) {
  ok('tools/call 回执含 executionId/kubectlCommand/auditDigest/mode', `mode=${receiptResult.mode}`);
} else {
  bad('tools/call 回执字段', receiptResult);
}

/* ---- 4. ping ---- */
const ping = await rpc({ jsonrpc: '2.0', id: 4, method: 'ping' });
const pingJson = (() => {
  try {
    return JSON.parse(ping.text);
  } catch {
    return null;
  }
})();
if (pingJson?.result !== undefined && JSON.stringify(pingJson.result) === '{}') {
  ok('ping 返回空对象');
} else {
  bad('ping', { status: ping.status, text: ping.text.slice(0, 200) });
}

/* ---- 5. 错误路径（结构合法性） ---- */
const notFound = await rpc({ jsonrpc: '2.0', id: 5, method: 'no-such-method' });
const notFoundJson = (() => {
  try {
    return JSON.parse(notFound.text);
  } catch {
    return null;
  }
})();
if (notFoundJson?.error?.code === -32601) {
  ok('未知方法返回 -32601');
} else {
  bad('未知方法错误码', notFoundJson?.error);
}

const notif = await rpc({ jsonrpc: '2.0', method: 'initialize' });
if (notif.status === 202) {
  ok('通知（无 id）返回 202');
} else {
  bad('通知状态码', notif.status);
}

console.log(`\n汇总: 通过 ${pass} · 失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);