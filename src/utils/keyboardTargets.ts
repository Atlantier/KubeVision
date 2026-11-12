/**
 * KubeVision AI — 全局快捷键目标判定（keyboardTargets · 纯函数）
 *
 * 【设计意图】
 * 全局快捷键（Space/1/2/F/?/Shift+P）与 Esc 分级栈都需要回答同一个问题：
 * 「这次按键的焦点目标，是不是一个正在与用户交互的控件？」
 * 旧实现只判 input/textarea/contentEditable，漏掉了 button/a/select 等——
 * 焦点停在按钮上按空格，原生激活被 preventDefault 劫持，按钮永远按不动。
 *
 * 【输入输出】
 * - readKeyboardTargetFacts：DOM EventTarget → 结构化事实（tagName/可编辑/role），
 *   非 HTMLElement（window/document/body 之外的文本节点等）一律返回 null；
 * - isEditableFacts / isInteractiveFacts：事实 → 布尔，纯函数、零 DOM 依赖，
 *   Node 单测可直接构造事实对象覆盖全部分支（tests/keyboardTargets.test.mjs）；
 * - isEditableTarget / isInteractiveTarget：DOM 适配器，供事件监听器一行调用。
 *
 * 【为何拆「事实」与「判定」两层】instanceof HTMLElement 在 Node 里不存在，
 * 直接对 DOM 节点写判定无法脱离浏览器单测。事实层把 DOM 读取收敛到一处，
 * 判定层成为可在任何运行时验证的纯逻辑——这也是 R3「判断抽成有类型纯函数」的落点。
 */

/* ========================================================================== */
/* 事实层                                                                     */
/* ========================================================================== */

/** 按键目标的结构化事实（与 DOM 解耦；role 已归一化为小写单值） */
export interface KeyboardTargetFacts {
  /** 大写标签名（HTMLElement.tagName 天然大写） */
  readonly tagName: string;
  /** 是否 contentEditable（含宿主元素自身可编辑的情形） */
  readonly isContentEditable: boolean;
  /** role 属性（无则为 null；已 trim + 小写） */
  readonly role: string | null;
}

/**
 * readKeyboardTargetFacts —— 从事件目标提取判定事实（唯一的 DOM 读取点）。
 *
 * @param target 事件目标（window/document/HTMLElement/null 皆可能）
 * @returns 结构化事实；目标不是 HTMLElement 时返回 null（视为非交互背景）
 */
export function readKeyboardTargetFacts(target: EventTarget | null): KeyboardTargetFacts | null {
  if (target === null || !(target instanceof HTMLElement)) return null;
  const role = target.getAttribute('role');
  return {
    tagName: target.tagName,
    isContentEditable: target.isContentEditable,
    role: role === null ? null : role.trim().toLowerCase(),
  };
}

/* ========================================================================== */
/* 判定层（纯函数）                                                            */
/* ========================================================================== */

/** 文本可编辑标签：Esc/输入类快捷键必须让位（IME 取消候选、清空输入等语义） */
const EDITABLE_TAGS: ReadonlySet<string> = new Set(['INPUT', 'TEXTAREA']);

/**
 * 交互元素标签（R3 契约全集）：全局快捷键不得劫持这些元素上的按键。
 * - BUTTON/A：Space/Enter 是原生激活键，preventDefault 会让按钮永远按不动；
 * - SELECT/SUMMARY：Space 展开下拉/折叠面板是原生行为；
 * - AUDIO/VIDEO：Space 是原生播放/暂停。
 */
const INTERACTIVE_TAGS: ReadonlySet<string> = new Set([
  'INPUT',
  'TEXTAREA',
  'BUTTON',
  'A',
  'SELECT',
  'SUMMARY',
  'AUDIO',
  'VIDEO',
]);

/** 交互 ARIA role：div/span 自定义控件只要声明了这些 role 就同样让位 */
const INTERACTIVE_ROLES: ReadonlySet<string> = new Set([
  'button',
  'tab',
  'menuitem',
  'radio',
  'checkbox',
]);

/**
 * isEditableFacts —— 目标是否文本可编辑（Esc 让位判据）。
 *
 * @param facts 结构化事实（null 表示非元素背景）
 * @returns 可编辑返回 true
 */
export function isEditableFacts(facts: KeyboardTargetFacts | null): boolean {
  if (facts === null) return false;
  return EDITABLE_TAGS.has(facts.tagName) || facts.isContentEditable;
}

/**
 * isInteractiveFacts —— 目标是否交互元素（全局快捷键让位判据，比可编辑更宽）。
 *
 * @param facts 结构化事实（null 表示非元素背景，快捷键可生效）
 * @returns 交互元素返回 true
 */
export function isInteractiveFacts(facts: KeyboardTargetFacts | null): boolean {
  if (facts === null) return false;
  if (facts.isContentEditable) return true;
  if (INTERACTIVE_TAGS.has(facts.tagName)) return true;
  return facts.role !== null && INTERACTIVE_ROLES.has(facts.role);
}

/* ========================================================================== */
/* DOM 适配器（事件监听器入口）                                                 */
/* ========================================================================== */

/**
 * isEditableTarget —— 事件目标是否文本可编辑（Esc 分级栈让位用）。
 *
 * @param target 事件目标
 * @returns 可编辑返回 true
 */
export function isEditableTarget(target: EventTarget | null): boolean {
  return isEditableFacts(readKeyboardTargetFacts(target));
}

/**
 * isInteractiveTarget —— 事件目标是否交互元素（全局快捷键让位用）。
 *
 * @param target 事件目标
 * @returns 交互元素返回 true
 */
export function isInteractiveTarget(target: EventTarget | null): boolean {
  return isInteractiveFacts(readKeyboardTargetFacts(target));
}

/* ========================================================================== */
/* IME 组合判定                                                               */
/* ========================================================================== */

/** IME 判定所需的最小事件事实（React 合成事件与原生 KeyboardEvent 均满足） */
export interface ImeKeyEventFacts {
  /** 是否处于输入法组合中（compositionstart ~ compositionend） */
  readonly isComposing: boolean;
  /** 旧浏览器/旧 IME 在组合期上报 229（isComposing 可能缺失，双判兜底） */
  readonly keyCode: number;
}

/**
 * isImeComposing —— 按键是否处于 IME 组合期（Enter 只上屏候选、不执行命令）。
 *
 * 【为何双判】现代浏览器组合期 isComposing=true；但部分旧 IME/WebView 在
 * 「确认候选」的那次 Enter 上 isComposing 已置 false 而 keyCode 仍为 229，
 * 单判 isComposing 会漏掉这一帧，导致中文选字误触发命令/发送。
 *
 * @param event 事件事实（isComposing + keyCode）
 * @returns 组合期返回 true（调用方应直接 return，把按键让给输入法）
 */
export function isImeComposing(event: ImeKeyEventFacts): boolean {
  return event.isComposing || event.keyCode === 229;
}