#!/usr/bin/env node
/**
 * KubeVision AI — 脱敏器单元测试（scripts/verify-sanitizer.mjs）
 *
 * 【为什么单独建一个脚本】脱敏是安全关键路径，但它的缺陷不会让页面白屏，
 * 只会静默漏掉一个凭证——因此必须用"断言"而不是"看起来没问题"来守护。
 *
 * 【本轮新增的 20 条用例】覆盖四类缺陷模式：
 *   1. URL 内嵌凭证中密码含未转义 '@'（贪婪匹配到最后一个 @）；
 *   2. 幂等性：对已脱敏文本再次脱敏，文本不变且 maskedCount 不虚增；
 *   3. Unicode / 超长输入；
 *   4. 分类计数（maskedByRule）与批量累计（sanitizeBatch）一致性。
 *
 * 【用法】node scripts/verify-sanitizer.mjs
 */

import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const ROOT = dirname(fileURLToPath(new URL('.', import.meta.url)));
const OUT = join(ROOT, 'tmp-sanitizer');
process.on('exit', () => {
  try { rmSync(OUT, { recursive: true, force: true }); } catch { /* ignore */ }
});

if (existsSync(OUT)) rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
{
  const source = readFileSync(join(ROOT, 'src/utils/logSanitizer.ts'), 'utf8');
  const result = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    fileName: 'logSanitizer.ts',
  });
  writeFileSync(join(OUT, 'logSanitizer.cjs'), result.outputText, 'utf8');
}
const { sanitizeRawLog, sanitizeBatch, hasSensitiveData } = require(join(OUT, 'logSanitizer.cjs'));

let pass = 0;
let fail = 0;
/**
 * 断言工具。
 *
 * @param name 用例名
 * @param actual 实际值
 * @param expected 期望值
 */
function is(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    pass += 1;
    console.log(`  ✓ ${name}${expected === undefined ? '' : `  ::  ${JSON.stringify(expected)}`}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${name}\n      期望=${JSON.stringify(expected)}\n      实际=${JSON.stringify(actual)}`);
  }
}

console.log('KubeVision AI — 脱敏器单元测试（20 条）\n');
console.log('▸ 1. URL 内嵌凭证');

/* 1. 基础形态 */
{
  const r = sanitizeRawLog('connect postgres://admin:S3cr3t!@db.internal:5432/payments failed');
  is('1.1 基础 URL 凭证被替换', r.sanitized.includes('postgres://[REDACTED_CREDENTIAL]@db.internal'), true);
  is('1.2 基础 URL 凭证计数为 1', r.maskedCount >= 1, true);
}

/* 2. 密码含未转义 '@'（本轮修复点：必须贪婪匹配到最后一个 @） */
{
  const r = sanitizeRawLog('dsn=postgres://svc:p@ssw0rd@db.internal:5432/app');
  is('2.1 含 @ 的密码整体被替换', r.sanitized, 'dsn=postgres://[REDACTED_CREDENTIAL]@db.internal:5432/app');
  is('2.2 不残留密码片段', /ssw0rd/.test(r.sanitized), false);
}

/* 3. 密码含多个 '@' + 端口 + 路径 */
{
  const r = sanitizeRawLog('redis://u:p@ss@word@cache.prod:6379/0');
  is('3.1 多 @ 密码整体被替换', /REDACTED_CREDENTIAL/.test(r.sanitized) && !/ss@word|p@ss/.test(r.sanitized), true);
  is('3.2 保留 scheme 与 host 结构', r.sanitized.startsWith('redis://[REDACTED_CREDENTIAL]@'), true);
}

/* 4. 幂等：对已脱敏文本再脱敏 */
{
  const once = sanitizeRawLog('postgres://admin:S3cr3t!@db.internal:5432/payments');
  const twice = sanitizeRawLog(once.sanitized);
  is('4.1 URL 凭证二次脱敏文本不变', twice.sanitized, once.sanitized);
  is('4.2 URL 凭证二次脱敏计数为 0', twice.maskedCount, 0);
}

console.log('▸ 2. 密码字段');

/* 5. 裸密码字段 */
{
  const r = sanitizeRawLog('db_password=hunter2 connecting to primary');
  is('5.1 密码字段被替换且保留键名', r.sanitized, 'db_password=[REDACTED_PASSWORD] connecting to primary');
}

/* 6. 密码字段幂等（本轮修复点：占位符不得再次命中） */
{
  const once = sanitizeRawLog('db_password=hunter2 connecting');
  const twice = sanitizeRawLog(once.sanitized);
  is('6.1 密码字段二次脱敏文本不变', twice.sanitized, once.sanitized);
  is('6.2 密码字段二次脱敏计数为 0', twice.maskedCount, 0);
}

/* 7. 带引号的密码 */
{
  const r = sanitizeRawLog('config: {"password": "hunter2!"}');
  is('7.1 JSON 引号密码被替换', /REDACTED_PASSWORD/.test(r.sanitized), true);
}

console.log('▸ 3. IP / JWT / 云密钥 / 邮箱');

/* 8. IP */
{
  const r = sanitizeRawLog('dial tcp 10.244.3.17:6443: connect: connection refused');
  is('8.1 IP 被替换', r.sanitized.includes('[REDACTED_IP]'), true);
  is('8.2 IP 计数', r.maskedCount >= 1, true);
}

/* 9. IP 幂等 */
{
  const once = sanitizeRawLog('peer 10.244.3.17:6443 unreachable');
  const twice = sanitizeRawLog(once.sanitized);
  is('9.1 IP 二次脱敏文本不变', twice.sanitized, once.sanitized);
  is('9.2 IP 二次脱敏计数为 0', twice.maskedCount, 0);
}

/* 10. JWT */
{
  const jwt =
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
  const r = sanitizeRawLog(`Authorization: Bearer ${jwt}`);
  is('10.1 JWT 被替换', r.sanitized.includes('[MASKED_TOKEN]'), true);
}

/* 11. JWT 幂等 */
{
  const r = sanitizeRawLog('token=[MASKED_TOKEN] reused');
  is('11.1 已脱敏 JWT 不再计数', r.maskedCount, 0);
}

/* 12. 云厂商 AccessKey */
{
  const r = sanitizeRawLog('aws_access_key_id=AKIAIOSFODNN7EXAMPLE');
  is('12.1 AWS AK 被替换', r.sanitized.includes('[MASKED_KEY]'), true);
}

/* 13. 云密钥幂等 */
{
  const r = sanitizeRawLog('key=[MASKED_KEY] already redacted');
  is('13.1 已脱敏密钥不再计数', r.maskedCount, 0);
}

/* 14. 邮箱 */
{
  const r = sanitizeRawLog('notify oncall@kubevision.io about the alert');
  is('14.1 邮箱被替换', r.sanitized.includes('[REDACTED_EMAIL]'), true);
}

/* 15. 邮箱幂等 */
{
  const r = sanitizeRawLog('notify [REDACTED_EMAIL] about it');
  is('15.1 已脱敏邮箱不再计数', r.maskedCount, 0);
}

console.log('▸ 4. Unicode / 超长 / 批量');

/* 16. Unicode 密码 */
{
  const r = sanitizeRawLog('mysql://root:密码@2024@db.internal:3306/app');
  is('16.1 Unicode 密码整体被替换', r.sanitized.startsWith('mysql://[REDACTED_CREDENTIAL]@'), true);
  is('16.2 不残留 Unicode 密码', /密码/.test(r.sanitized), false);
}

/* 17. Unicode 正文不影响判定 */
{
  const r = sanitizeRawLog('【告警】连接 10.1.2.3:3306 失败，已重试 3 次');
  is('17.1 中文正文中的 IP 被替换', r.sanitized.includes('[REDACTED_IP]'), true);
  is('17.2 中文正文保留', r.sanitized.includes('【告警】'), true);
}

/* 18. 超长输入（10 万字符） */
{
  const line = 'connect 10.9.8.7:5432 failed; ';
  const raw = line.repeat(4000); /* ~ 112000 字符 */
  const started = process.hrtime.bigint();
  const r = sanitizeRawLog(raw);
  const costMs = Number(process.hrtime.bigint() - started) / 1e6;
  is('18.1 超长输入全部脱敏', r.maskedCount, 4000);
  is('18.2 超长输入无残留 IP', /10\.9\.8\.7/.test(r.sanitized), false);
  console.log(`      耗时 ${costMs.toFixed(2)}ms（10 万字符，同步）`);
}

/* 19. 批量累计一致性 */
{
  const batch = sanitizeBatch([
    'peer 10.0.0.1:80 refused',
    'db_password=hunter2',
    'user oncall@kubevision.io',
  ]);
  const sum = batch.results.reduce((acc, r) => acc + r.maskedCount, 0);
  is('19.1 批量累计等于逐条之和', batch.totalMasked, sum);
  is('19.2 三条均命中', batch.results.every((r) => r.maskedCount > 0), true);
}

/* 20. 探测函数与脱敏口径一致 */
{
  const samples = [
    'peer 10.0.0.1:80 refused',
    'db_password=hunter2',
    'nothing sensitive here',
    'oncall@kubevision.io',
  ];
  const consistent = samples.every((s) => hasSensitiveData(s) === (sanitizeRawLog(s).maskedCount > 0));
  is('20.1 hasSensitiveData 与 sanitizeRawLog 口径一致', consistent, true);
}


/* ========================================================================== */
/* 5. Q6 · 可配置规则 + ReDoS 防护                                               */
/* ========================================================================== */

const { createSanitizerEngine } = require(join(OUT, 'logSanitizer.cjs'));

console.log('\n▸ 5. 可配置规则（自定义正则 + ReDoS 防护）');

/* 5.1 自定义规则生效并计数 */
{
  const engine = createSanitizerEngine({
    customRules: [{ name: 'ticket-id', pattern: 'TICKET-\\d{6}', placeholder: '[REDACTED_TICKET]' }],
  });
  const r = engine.sanitize('incident TICKET-123456 opened by peer 10.0.0.9');
  is('5.1 自定义规则命中并替换', r.sanitized.includes('[REDACTED_TICKET]'), true);
  is('5.1b 自定义规则计入分类计数', r.maskedByRule['ticket-id'], 1);
  is('5.1c 内置 IP 规则同时生效', r.sanitized.includes('[REDACTED_IP]'), true);
}

/* 5.2 自定义规则幂等（占位符不重复计数） */
{
  const engine = createSanitizerEngine({
    customRules: [{ name: 'ticket-id', pattern: 'TICKET-\\d{6}', placeholder: '[REDACTED_TICKET]' }],
  });
  const once = engine.sanitize('incident TICKET-123456');
  const twice = engine.sanitize(once.sanitized);
  is('5.2 自定义规则二次脱敏文本不变', twice.sanitized, once.sanitized);
  is('5.2b 自定义规则二次脱敏计数为 0', twice.maskedCount, 0);
}

/* 5.3 嵌套量词 ReDoS 被拒绝 */
{
  const engine = createSanitizerEngine({
    customRules: [{ name: 'evil', pattern: '(a+)+$', placeholder: '[X]' }],
  });
  const violations = engine.violations.filter((v) => v.rule === 'evil');
  is('5.3 嵌套量词被拒绝', violations.map((v) => v.kind), ['redos-suspect']);
  is('5.3b 被拒绝规则未进入生效列表', engine.rules.some((r) => r.name === 'evil'), false);
}

/* 5.4 歧义交替 ReDoS 被拒绝 */
{
  const engine = createSanitizerEngine({
    customRules: [{ name: 'evil2', pattern: '(a|aa)+$', placeholder: '[X]' }],
  });
  is('5.4 歧义交替被拒绝', engine.violations.some((v) => v.rule === 'evil2' && v.kind === 'redos-suspect'), true);
}

/* 5.5 非法正则被拒绝且不抛错 */
{
  const engine = createSanitizerEngine({
    customRules: [{ name: 'bad', pattern: '[', placeholder: '[X]' }],
  });
  is('5.5 非法正则被拒绝', engine.violations.some((v) => v.rule === 'bad' && v.kind === 'invalid-pattern'), true);
  const r = engine.sanitize('peer 10.0.0.1 down');
  is('5.5b 引擎仍可正常脱敏', r.sanitized.includes('[REDACTED_IP]'), true);
}

/* 5.6 规则条数上限 */
{
  const rules = Array.from({ length: 12 }, (_, i) => ({
    name: 'rule-' + i,
    pattern: 'R' + i + '-\\d+',
    placeholder: '[R' + i + ']',
  }));
  const engine = createSanitizerEngine({ customRules: rules });
  is('5.6 超出条数上限被记录', engine.violations.some((v) => v.kind === 'too-many-rules'), true);
  is('5.6b 仅前 10 条生效', engine.rules.filter((r) => r.name.startsWith('rule-')).length, 10);
}

/* 5.7 正则长度上限 */
{
  const engine = createSanitizerEngine({
    customRules: [{ name: 'long', pattern: 'a'.repeat(600), placeholder: '[X]' }],
  });
  is('5.7 超长正则被拒绝', engine.violations.some((v) => v.rule === 'long' && v.kind === 'pattern-too-long'), true);
}

/* 5.8 输入长度上限（截断并记录） */
{
  const engine = createSanitizerEngine({ maxInputChars: 1000 });
  const head = 'peer 10.0.0.1 failed. '.repeat(200);
  const tail = 'TAIL-CANARY-SHOULD-NOT-BE-PROCESSED';
  const r = engine.sanitize(head + tail);
  is('5.8 超长输入被截断（尾部标记未进入结果）', r.sanitized.includes('TAIL-CANARY'), false);
  is('5.8b 截断被记录为违规', engine.violations.some((v) => v.kind === 'input-truncated'), true);
}

/* 5.9 内置规则优先于自定义规则 */
{
  const engine = createSanitizerEngine({
    customRules: [{ name: 'catch-all', pattern: '10\\.0\\.0\\.1', placeholder: '[CUSTOM_CATCH]' }],
  });
  const r = engine.sanitize('peer 10.0.0.1 failed');
  is('5.9 内置 IP 规则先执行（自定义规则不再命中）', r.sanitized.includes('[REDACTED_IP]'), true);
}
rmSync(OUT, { recursive: true, force: true });
console.log(`\n汇总: 通过 ${pass} · 失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);