'use client';

/**
 * KubeVision AI — Esc 分级退出栈（useEscapeStack）
 *
 * 【为什么需要它】
 * 自愈前每个弹层各自在 window 上挂 keydown 监听：
 *   RagKnowledgeModal / PostMortemModal / ChaosControlModal 各挂一个，
 *   page.tsx 又挂一个"逐级退出"链（关命令面板 → 关混沌弹窗 → 关 HUD → 清选中）。
 *
 * 一次 Esc 会**同时**触发所有监听器：
 *   - 多个弹层一起关闭（用户只想退最上层，却一次退三层）；
 *   - 弹窗关闭的同时把 3D 选中也清掉（"关弹窗顺带丢了视角"）。
 * 事件并没有形成"栈"，只是若干互不知情的监听器在抢同一个键。
 *
 * 【本模块的模型】
 * - 弹层打开时 `useEscapeLayer` 注册 { id, priority, onEscape }；
 * - 全局只有 `useEscapeDispatcher`（仅 page.tsx 调用）安装一个 keydown；
 * - 按下 Esc 时：取**优先级最高**的已启用层，只调用它一个，然后停止；
 * - 输入框/文本域/contentEditable 内的 Esc 默认让位（不关闭任何层），
 *   交给输入控件自己处理（IME 取消、清空等）；仅 consumeInEditable 层
 *   （命令面板）例外——它的搜索框即主体，Esc 语义就是关面板；
 * - IME 组合期（isComposing / keyCode 229）的 Esc 一律让位给输入法。
 *
 * 【优先级约定】数值越大越靠上层：
 *   命令面板 100 > 混沌弹窗 90 > RAG 知识库 80 > 复盘弹窗 70 > 页面兜底 0。
 * 同一时刻只有最高优先级层响应，因此"一次 Esc 只退一层"是结构性保证，
 * 而不是靠调用顺序碰巧成立。
 */

import { useEffect, useState } from 'react';

import { isEditableTarget } from '@/utils/keyboardTargets';

/** 一个可被 Esc 关闭的层 */
export interface EscapeLayer {
  /** 唯一标识（调试与断言用） */
  readonly id: string;
  /** 优先级，数值越大越先响应 */
  readonly priority: number;
  /** 关闭回调（只应关闭自己这一层） */
  readonly onEscape: () => void;
  /** 人类可读层名（Q3：底部 chip 提示用，如 '混沌演练控制台'） */
  readonly label: string;
  /**
   * 焦点在输入框内时是否仍消费 Esc（默认 false 让位）。
   * 命令面板这类「搜索框即主体」的层置 true：用户按 Esc 的意图是关面板，
   * 而不是在输入框里清空内容；普通弹窗（RAG/混沌）保持 false，
   * 输入框内的 Esc 留给 IME 取消候选/清空输入。
   */
  readonly consumeInEditable?: boolean;
}

/** 注册表（模块级单例；组件挂载注册、卸载注销） */
const layers: EscapeLayer[] = [];

/**
 * registerEscapeLayer —— 注册一个 Esc 层。
 *
 * @param layer 层定义
 * @returns 注销函数
 */
export function registerEscapeLayer(layer: EscapeLayer): () => void {
  layers.push(layer);
  notifyEscapeLayersChanged();
  return (): void => {
    const index = layers.findIndex((candidate): boolean => candidate === layer);
    if (index >= 0) {
      layers.splice(index, 1);
      notifyEscapeLayersChanged();
    }
  };
}

/**
 * dispatchEscape —— 执行一次 Esc 分级退出（纯函数，便于单测）。
 *
 * 【让位规则】先取最上层，再判输入框：默认输入框内 Esc 让位（IME 取消候选/
 * 清空输入优先）；仅当最上层显式声明 consumeInEditable（命令面板）时才消费。
 * 让位判断必须挂在「最上层」而非全局——否则命令面板会被其他层的输入框误让位。
 *
 * @param target 事件目标（用于输入框让位判断）
 * @returns 是否消费了本次 Esc
 */
export function dispatchEscape(target: EventTarget | null): boolean {
  if (layers.length === 0) return false;

  let top: EscapeLayer | null = null;
  for (const layer of layers) {
    if (top === null || layer.priority > top.priority) top = layer;
  }
  if (top === null) return false;

  if (isEditableTarget(target) && top.consumeInEditable !== true) return false;

  /*
   * 【只退一层】调用后立即返回 true。
   * 不遍历其它层、不模糊匹配——这是"一次 Esc 只退一层"的实现支点。
   */
  top.onEscape();
  return true;
}

/** 读取当前注册层（仅用于测试/探针，返回快照副本） */
export function getRegisteredEscapeLayers(): readonly EscapeLayer[] {
  return layers.map((layer): EscapeLayer => ({ ...layer }));
}

/**
 * useEscapeLayer —— 在组件内注册一个 Esc 层（open 为 false 时不注册）。
 *
 * @param layer 层定义；layer 为 null 表示当前不打开
 */
export function useEscapeLayer(layer: EscapeLayer | null): void {
  const id = layer?.id ?? null;
  const priority = layer?.priority ?? 0;
  const onEscape = layer?.onEscape;
  const label = layer?.label ?? '';
  const consumeInEditable = layer?.consumeInEditable ?? false;

  useEffect((): (() => void) | undefined => {
    if (id === null || onEscape === undefined) return undefined;
    return registerEscapeLayer({ id, priority, onEscape, label, consumeInEditable });
  }, [id, priority, onEscape, label, consumeInEditable]);
}

/* ========================================================================== */
/* 可视化提示（Q3）：当前最上层 Esc 目标                                         */
/* ========================================================================== */

/** 层变化订阅者集合 */
const hintListeners = new Set<() => void>();

/**
 * subscribeEscapeLayers —— 订阅注册表变化（供底部提示 chip 使用）。
 *
 * @param listener 变化回调
 * @returns 取消订阅函数
 */
export function subscribeEscapeLayers(listener: () => void): () => void {
  hintListeners.add(listener);
  return (): void => {
    hintListeners.delete(listener);
  };
}

/** 通知订阅者：注册表变化（弹层开关会改变"当前最上层"） */
function notifyEscapeLayersChanged(): void {
  for (const listener of hintListeners) listener();
}

/**
 * getTopEscapeLabel —— 当前最上层弹层的可读名（无弹层返回 null）。
 *
 * 【Q3 用途】底部 chip 显示"Esc 关闭：<名字>"，让评委一眼知道
 * 此刻按 Esc 会发生什么——键盘行为不再是隐藏知识。
 *
 * @returns 最上层标签；没有可关闭层时返回 null
 */
export function getTopEscapeLabel(): string | null {
  let top: EscapeLayer | null = null;
  for (const layer of layers) {
    if (layer.priority <= 0) continue;
    if (top === null || layer.priority > top.priority) top = layer;
  }
  return top?.label ?? null;
}
/**
 * useEscapeHint —— 订阅"当前最上层 Esc 目标"的可读名（Q3）。
 *
 * 【为什么要订阅而不是每次渲染现算】注册表是模块级可变表，
 * React 不知道它何时变化；用 useSyncExternalStore 语义的订阅，
 * 弹层开关时 chip 才会重建文本。
 *
 * @returns 顶层名；没有可关闭弹层时返回 null
 */
export function useEscapeHint(): string | null {
  const [label, setLabel] = useState<string | null>(() => getTopEscapeLabel());
  useEffect((): (() => void) => {
    setLabel(getTopEscapeLabel());
    return subscribeEscapeLayers((): void => {
      setLabel(getTopEscapeLabel());
    });
  }, []);
  return label;
}

/**
 * useEscapeDispatcher —— 安装**唯一**的全局 Esc 监听（只应在 page.tsx 调用）。
 *
 * @param enabled 是否启用（默认 true）
 */
export function useEscapeDispatcher(enabled = true): void {
  useEffect((): (() => void) | undefined => {
    if (!enabled) return undefined;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      /* IME 组合期的 Esc 是「取消候选」而非「关闭弹层」，让位给输入法
         （keyCode 229 兜底旧 IME：组合确认帧 isComposing 可能已置 false） */
      if (event.isComposing || event.keyCode === 229) return;
      const consumed = dispatchEscape(event.target);
      if (consumed) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return (): void => window.removeEventListener('keydown', onKeyDown);
  }, [enabled]);
}