/**
 * KubeVision AI — Emoji / "AI 味符号" 静态检查（R33 · A）
 *
 * 扫描 src 下全部 ts/tsx/css/md 文件，命中 Extended_Pictographic 即 exit 1。
 * 同时提示禁止的 AI 味渐变（紫粉）与 Sparkles 图标。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const files = [];
function walk(dir) { for (const e of readdirSync(dir, { withFileTypes: true })) { const p = join(dir, e.name); if (e.isDirectory()) walk(p); else if (/\.(ts|tsx|css|md)$/.test(e.name)) files.push(p); } }
walk(join(process.cwd(), 'src'));

const emojiRe = /\p{Extended_Pictographic}/gu;
const forbidden = [
  { id: 'emoji', re: emojiRe },
  { id: 'purple-pink-gradient', re: /(from|via|to)-(purple|pink|fuchsia)-\d/g },
  { id: 'human-avatar', re: /智能助手|拟人化头像|assistant-avatar/g },
];
const hits = [];
for (const file of files) {
  const source = readFileSync(file, 'utf8');
  const lucideImport = /import\s*\{([\s\S]*?)\}\s*from\s*'lucide-react'/.exec(source);
  const importsSparkles = lucideImport !== null && /\bSparkles\b/.test(lucideImport[1]);
  if (importsSparkles) {
    source.split('\n').forEach((line, index) => {
      if (/<Sparkles\b/.test(line)) {
        hits.push({ rule: 'sparkles-icon', file: file.replace(process.cwd() + '\\', ''), line: index + 1, detail: '<Sparkles lucide 图标' });
      }
    });
  }
  source.split('\n').forEach((line, index) => {
    for (const rule of forbidden) {
      const matches = [...line.matchAll(rule.re)];
      for (const match of matches) {
        hits.push({ rule: rule.id, file: file.replace(process.cwd() + '\\', ''), line: index + 1, detail: String(match[0]) });
      }
    }
  });
}
console.log('KubeVision AI — Emoji / AI 味符号检查');
console.log(`  扫描文件: ${files.length} 个 · 命中: ${hits.length}`);
for (const hit of hits.slice(0, 30)) console.log(`    [${hit.rule}] ${hit.file}:L${hit.line}  ${hit.detail}`);
process.exit(hits.length === 0 ? 0 : 1);
