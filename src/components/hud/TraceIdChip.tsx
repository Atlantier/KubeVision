'use client';

/**
 * KubeVision AI — 可复制的 traceId 徽标（R43 · traceId 贯穿）
 *
 * 【用途】错误卡片、复盘报告、MCP 回执等位置统一展示同一条 traceId，
 * 点击即复制，便于把"用户看到的报错"与"服务端 span 时间线"对上号。
 * 数据来自 useAgentTraceStore（trace-summary 事件写入），无 trace 时返回 null。
 */

import { useState } from 'react';
import { copyText, useAgentTraceStore } from '@/store/useAgentTraceStore';

/** TraceIdChip 无 props（可选 id 覆盖，用于明确展示某个历史 trace） */
export default function TraceIdChip({ id }: { readonly id?: string }): React.ReactElement | null {
  const storeTraceId = useAgentTraceStore((s): string | null => s.traceId);
  const traceId = id ?? storeTraceId;
  const [copied, setCopied] = useState<boolean>(false);

  if (traceId === null) return null;

  return (
    <button
      type="button"
      onClick={(): void => {
        void copyText(traceId);
        setCopied(true);
        window.setTimeout((): void => setCopied(false), 1200);
      }}
      aria-label={`复制 traceId ${traceId}`}
      title="点击复制 traceId"
      className="rounded border border-white/[0.075] px-1 py-0.5 font-mono text-[10px] tabular-nums text-cyan-300/90 transition-colors hover:text-cyan-200 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-cyan-400/60"
    >
      {copied ? '已复制' : `trace ${traceId.slice(0, 12)}`}
    </button>
  );
}