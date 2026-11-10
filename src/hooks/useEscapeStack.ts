'use client';

/**
 * KubeVision AI — Esc 分级退出栈（useEscapeStack）
 *
 * 【为什么需要它】
 * 修复前每个弹层各自在 window 上挂 keydown 监听：
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
 * - 输入框/文本域/contentEditable 内的 Esc 直接让位（不关闭任何层），
 *   交给输入控件自己处理（IME 取消、清空等）。
 *
 * 【优先级约定】数值越大越靠上层：
 *   命令面板 100 > 混沌弹窗 90 > RAG 知识库 80 > 复盘弹窗 70 > 页面兜底 0。
 * 同一时刻只有最高优先级层响应，因此"一次 Esc 只退一层"是结构性保证，
 * 而不是靠调用顺序碰巧成立。
 */

import { useEffect } from 'react';

/** 一个可被 Esc 关闭的层 */
export interface EscapeLayer {
  /** 唯一标识（调试与断言用） */
  readonly id: string;
  /** 优先级，数值越大越先响应 */
  readonly priority: number;
  /** 关闭回调（只应关闭自己这一层） */
  readonly onEscape: () => void;
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
  return (): void => {
    const index = layers.findIndex((candidate): boolean => candidate === layer);
    if (index >= 0) layers.splice(index, 1);
  };
}

/**
 * isEditableTarget —— 判断事件目标是否是可编辑控件。
 *
 * 【为何让位】输入框里的 Esc 常用于：
 * - 取消输入法候选（中文输入中按 Esc 是"取消候选"而非"关闭弹窗"）；
 * - 清空/回滚当前输入。
 * 若全局栈抢先关闭弹窗，用户会丢失正在输入的内容——所以输入框内一律让位。
 *
 * @param target 事件目标
 * @returns 是否可编辑
 */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (target === null || !(target instanceof HTMLElement)) return false;
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return true;
  return target.isContentEditable;
}

/**
 * dispatchEscape —— 执行一次 Esc 分级退出（纯函数，便于单测）。
 *
 * @param target 事件目标（用于输入框让位判断）
 * @returns 是否消费了本次 Esc
 */
export function dispatchEscape(target: EventTarget | null): boolean {
  if (isEditableTarget(target)) return false;
  if (layers.length === 0) return false;

  let top: EscapeLayer | null = null;
  for (const layer of layers) {
    if (top === null || layer.priority > top.priority) top = layer;
  }
  if (top === null) return false;

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

  useEffect((): (() => void) | undefined => {
    if (id === null || onEscape === undefined) return undefined;
    return registerEscapeLayer({ id, priority, onEscape });
  }, [id, priority, onEscape]);
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