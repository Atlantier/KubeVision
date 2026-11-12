/**
 * KubeVision AI — 全局快捷键目标判定单测（R3）
 *
 * 【守护的不变量】
 *  1. 交互元素（button/a/select/summary/audio/video/role=button|tab|menuitem|radio|checkbox）
 *     必须让位——空格原生激活不可被全局快捷键劫持；
 *  2. 文本可编辑（input/textarea/contentEditable）是 Esc 让位判据，比交互集合更窄；
 *  3. 非元素背景（window/document → null）不算交互，全局快捷键可生效；
 *  4. IME 双判：isComposing 或 keyCode 229 任一成立即组合期（Enter 只上屏候选）。
 *
 * 【运行】pnpm test:keyboard → node --test tests/keyboardTargets.test.mjs
 * Node 24 原生类型剥离可直接 import .ts（keyboardTargets.ts 零运行时依赖）。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isEditableFacts,
  isInteractiveFacts,
  isImeComposing,
} from '../src/utils/keyboardTargets.ts';

/** 事实工厂：默认一个普通 div */
function facts(overrides = {}) {
  return { tagName: 'DIV', isContentEditable: false, role: null, ...overrides };
}

/* ---- 可编辑判定（Esc 让位） ---- */

test('input/textarea 可编辑', () => {
  assert.equal(isEditableFacts(facts({ tagName: 'INPUT' })), true);
  assert.equal(isEditableFacts(facts({ tagName: 'TEXTAREA' })), true);
});

test('contentEditable 的 div 可编辑', () => {
  assert.equal(isEditableFacts(facts({ isContentEditable: true })), true);
});

test('button/select/普通 div 不可编辑（Esc 不应让位给它们）', () => {
  assert.equal(isEditableFacts(facts({ tagName: 'BUTTON' })), false);
  assert.equal(isEditableFacts(facts({ tagName: 'SELECT' })), false);
  assert.equal(isEditableFacts(facts()), false);
});

test('null（window/document 背景）不可编辑', () => {
  assert.equal(isEditableFacts(null), false);
});

/* ---- 交互判定（全局快捷键让位） ---- */

test('契约全集 8 类标签均为交互元素', () => {
  for (const tagName of ['INPUT', 'TEXTAREA', 'BUTTON', 'A', 'SELECT', 'SUMMARY', 'AUDIO', 'VIDEO']) {
    assert.equal(isInteractiveFacts(facts({ tagName })), true, `${tagName} 必须让位`);
  }
});

test('契约全集 5 类 ARIA role 均为交互元素', () => {
  for (const role of ['button', 'tab', 'menuitem', 'radio', 'checkbox']) {
    assert.equal(isInteractiveFacts(facts({ role })), true, `role=${role} 必须让位`);
  }
});

test('contentEditable 的 div 是交互元素', () => {
  assert.equal(isInteractiveFacts(facts({ isContentEditable: true })), true);
});

test('非交互背景：div/span/canvas/body 不拦快捷键', () => {
  for (const tagName of ['DIV', 'SPAN', 'CANVAS', 'BODY', 'SECTION']) {
    assert.equal(isInteractiveFacts(facts({ tagName })), false, `${tagName} 不应让位`);
  }
});

test('无关 role（dialog/presentation）不拦快捷键', () => {
  assert.equal(isInteractiveFacts(facts({ role: 'dialog' })), false);
  assert.equal(isInteractiveFacts(facts({ role: 'presentation' })), false);
});

test('null（window/document 背景）不拦快捷键', () => {
  assert.equal(isInteractiveFacts(null), false);
});

test('可编辑 ⊂ 交互：凡可编辑必交互', () => {
  const editableSamples = [
    facts({ tagName: 'INPUT' }),
    facts({ tagName: 'TEXTAREA' }),
    facts({ isContentEditable: true }),
  ];
  for (const sample of editableSamples) {
    assert.equal(isEditableFacts(sample), true);
    assert.equal(isInteractiveFacts(sample), true);
  }
});

/* ---- IME 双判 ---- */

test('isComposing=true → 组合期（Enter 不执行命令）', () => {
  assert.equal(isImeComposing({ isComposing: true, keyCode: 13 }), true);
});

test('keyCode=229 兜底 → 组合期（旧 IME 确认帧 isComposing 已 false）', () => {
  assert.equal(isImeComposing({ isComposing: false, keyCode: 229 }), true);
});

test('普通 Enter（13）/方向键（40）非组合期', () => {
  assert.equal(isImeComposing({ isComposing: false, keyCode: 13 }), false);
  assert.equal(isImeComposing({ isComposing: false, keyCode: 40 }), false);
});

test('中文输入全流程模拟：组合期按键让位、确认后 Enter 执行', () => {
  /* 拼音「zhong」逐键：组合期全部让位 */
  for (const keyCode of [90, 72, 79, 78, 71]) {
    assert.equal(isImeComposing({ isComposing: true, keyCode }), true);
  }
  /* 旧 IME 确认帧：isComposing 已 false 但 keyCode 229 */
  assert.equal(isImeComposing({ isComposing: false, keyCode: 229 }), true);
  /* 上屏后的下一次 Enter：正常执行 */
  assert.equal(isImeComposing({ isComposing: false, keyCode: 13 }), false);
});