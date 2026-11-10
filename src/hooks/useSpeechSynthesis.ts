'use client';

/**
 * KubeVision AI — 中文神经网络语音播报 Hook（useSpeechSynthesis）
 *
 * 【这个 Hook 解决什么】
 * 改造前的播报有三个真实缺陷，且它们互相叠加，导致「点了喇叭不响」：
 *
 * 1. **没有选音色**：`new SpeechSynthesisUtterance(...)` 不指定 voice，
 *    浏览器会用它自己的默认音色。在国内环境里，默认音色经常是英文音色
 *    （如 Microsoft David），念中文时要么静音、要么发出怪异音节。
 *    更糟的是 `getVoices()` 首次调用常常返回空数组（语音包是异步加载的），
 *    必须先等 `onvoiceschanged` 再选，否则永远选不到。
 *
 * 2. **只播报根因卡**：旧逻辑把播报绑在 `renderRootCauseAnalysis` 工具上，
 *    于是「普通回答」「巡检结论」「寒暄」全都没声音。用户点了喇叭，
 *    问一句"集群怎么样"，AI 回了三屏文字，却一声不吭——这在他看来
 *    就是"喇叭坏了"。
 *
 * 3. **文本没清洗**：直接把 Markdown 原文丢给 TTS，会念出
 *    "井号 井号 根因分析"、"竖线 表格" 这类噪音。
 *
 * 【本 Hook 的三条核心策略】
 * - 音色优选：`selectBestChineseVoice` 按四档优先级匹配中文音色
 *   （微软自然神经网络 → 任意 Natural 中文 → 任意中文 → 兜底）；
 * - 文本净化：`sanitizeForSpeech` 剥离 Markdown 语法，只留可朗读的句子；
 * - 状态可见：把 playbackState 暴露给界面，"正在准备/正在朗读/不支持"
 *   分别有不同提示，而不是让用户对着静音猜。
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import type { TtsPlaybackState, VoiceSelectResult } from '@/types/ai';

/* ========================================================================== */
/* 常量                                                                       */
/* ========================================================================== */

/** 播报文本上限：超过这个长度只念开头，避免用户排队等它念完整篇报告 */
export const SPEECH_TEXT_LIMIT = 180;

/** 语速：1.05 略快于默认，符合运维场景的"快速交代结论"语气 */
const SPEECH_RATE = 1.05;

/** 音调：保持中性，不做过度的拟人化 */
const SPEECH_PITCH = 1;

/**
 * 语音列表等待上限（毫秒）。
 *
 * 【为何需要上限】Chrome 的 getVoices() 首次返回空数组，
 * 要等 onvoiceschanged 才有数据。但某些环境（无语音包的 Linux、
 * 权限受限的容器）**永远不会**触发该事件。若无限等待，
 * 用户点喇叭后毫无反应也没任何提示——这正是"点了不响"的典型场景。
 * 350ms 足够覆盖正常的语音包加载，超时后走兜底音色并如实标注。
 */
const VOICE_LOAD_TIMEOUT_MS = 350;

/* ========================================================================== */
/* 纯函数：文本净化                                                            */
/* ========================================================================== */

/**
 * sanitizeForSpeech —— 把 Markdown 正文净化成适合朗读的纯文本。
 *
 * 【为何必须净化】TTS 引擎会把符号逐个念出来：
 * - `## 根因分析` → "井号井号 根因分析"
 * - `| Pod | CPU |` → "竖线 Pod 竖线 CPU 竖线"
 * - `[MCP Verification]` → "左方括号 MCP..."
 * 用户听到的是一堆噪音而非结论，这比不播报更糟糕。
 *
 * 【处理顺序很关键】代码块必须最先剥离：若先把 `#` 换成空，
 * 代码里的注释符号会先被破坏，之后就无法正确识别围栏。
 *
 * @param markdown 原始 Markdown 文本
 * @param limit    截断上限（字符数）
 * @returns 可朗读的纯文本
 */
export function sanitizeForSpeech(markdown: string, limit: number = SPEECH_TEXT_LIMIT): string {
  let text = markdown;

  /* ---- 1. 剥离围栏代码块（含内容），必须是第一步 ---- */
  text = text.replace(/```[\s\S]*?```/g, ' ');
  text = text.replace(/~~~[\s\S]*?~~~/g, ' ');

  /* ---- 2. 剥离行内代码的反引号，但保留内容（常常是关键词） ---- */
  text = text.replace(/`([^`]+)`/g, '$1');

  /* ---- 3. 剥离表格：整行都是 | 分隔的行直接丢弃 ---- */
  text = text
    .split('\n')
    .filter((line): boolean => !/^\s*\|/.test(line))
    .join('\n');

  /* ---- 4. 剥离标题井号、引用符号、列表符号 ---- */
  text = text.replace(/^\s{0,3}#{1,6}\s+/gm, '');
  text = text.replace(/^\s{0,3}>\s?/gm, '');
  text = text.replace(/^\s{0,3}[-*+]\s+/gm, '');
  text = text.replace(/^\s{0,3}\d+\.\s+/gm, '');

  /* ---- 5. 剥离强调与链接语法：保留可读文字 ---- */
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
  text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  text = text.replace(/\*\*([^*]+)\*\*/g, '$1');
  text = text.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '$1');
  text = text.replace(/__([^_]+)__/g, '$1');
  text = text.replace(/~~([^~]+)~~/g, '$1');

  /* ---- 6. 剥离分隔线与残留的方括号标记（如 [MCP-ROUTER]） ---- */
  text = text.replace(/^\s*[-*_]{3,}\s*$/gm, ' ');
  text = text.replace(/\[[A-Z][A-Z0-9-\s]{2,}\]/g, ' ');

  /* ---- 7. 空白归一：连续空白合并为单个空格，便于截断在词边界 ---- */
  text = text.replace(/\s+/g, ' ').trim();

  /* ---- 8. 截断：优先在句末标点或空格处断开，避免念到半个词 ---- */
  if (text.length <= limit) return text;

  const slice = text.slice(0, limit);
  const lastBreak = Math.max(
    slice.lastIndexOf('。'),
    slice.lastIndexOf('！'),
    slice.lastIndexOf('？'),
    slice.lastIndexOf('；'),
    slice.lastIndexOf(' '),
  );
  /* 断点过于靠前（不足长度一半）时宁可硬截，避免只念出几个字 */
  return lastBreak > limit * 0.5 ? slice.slice(0, lastBreak + 1) : slice;
}

/* ========================================================================== */
/* 纯函数：中文音色优选                                                        */
/* ========================================================================== */

/**
 * selectBestChineseVoice —— 从系统语音列表中挑选最适合朗读中文的音色。
 *
 * 【四档优先级及理由】
 * 1. **微软自然神经网络音色**（`Microsoft Xiaoxiao` / `Microsoft Yunxi`）
 *    Windows 10/11 与 Edge 内置，音质接近真人，且完全离线、零成本。
 *    这是国内环境下的最优解：不依赖任何云服务，也就没有网络失败的可能。
 * 2. **含 Natural 的 zh-CN 音色**：覆盖其他厂商的神经网络音色
 *    （如 Google 自然语音、macOS 的 Premium 音色）。
 * 3. **任意 zh-CN / zh-TW 音色**：普通话优先，台湾腔次之（都是中文，能听懂）。
 *    注意 zh-HK 刻意排除——粤语音色念普通话文本的可懂度很低。
 * 4. **兜底**：返回 null，由调用方如实标注"未安装中文音色"。
 *
 * 【为何不用 lang 属性单独决定】只设 `utter.lang = 'zh-CN'` 而不指定 voice，
 * 浏览器会自行挑选——但它挑的可能是不匹配的音色，最终表现是
 * 中文文本用英文音素引擎朗读，听起来像乱码或干脆静音。
 * 显式指定 voice 才能真正控制发声。
 *
 * @param voices 系统可用语音列表（可能为空）
 * @returns 选中音色 + 音质档位 + 命中的规则说明
 */
export function selectBestChineseVoice(voices: readonly SpeechSynthesisVoice[]): VoiceSelectResult {
  if (voices.length === 0) {
    return { voice: null, quality: 'none', source: '系统语音列表为空' };
  }

  /**
   * 微软自然音色白名单。
   * 这些名字是 Windows/Edge 上 zh-CN 自然语音的实际标识，
   * 用 includes 而非全等匹配，因为完整 voiceURI 可能带平台前缀。
   */
  const MS_NATURAL_PREFERRED = ['Xiaoxiao', 'Yunxi', 'Yunyang', 'Xiaoyi', 'Yunjian'];

  /* ---- 第 1 档：微软自然神经网络音色 ---- */
  for (const preferred of MS_NATURAL_PREFERRED) {
    const hit = voices.find(
      (voice): boolean =>
        voice.name.includes(preferred) && /^zh/i.test(voice.lang),
    );
    if (hit !== undefined) {
      return { voice: hit, quality: 'natural', source: `微软自然音色 ${preferred}` };
    }
  }

  /* ---- 第 2 档：其他标了 Natural 的中文音色 ---- */
  const naturalZh = voices.find(
    (voice): boolean => /Natural/i.test(voice.name) && /^zh/i.test(voice.lang),
  );
  if (naturalZh !== undefined) {
    return { voice: naturalZh, quality: 'natural', source: `神经网络音色 ${naturalZh.name}` };
  }

  /* ---- 第 3 档：任意中文音色（zh-CN 优先于 zh-TW） ---- */
  const zhCn = voices.find((voice): boolean => /^zh[-_]CN/i.test(voice.lang));
  if (zhCn !== undefined) {
    return { voice: zhCn, quality: 'standard', source: `中文音色 ${zhCn.name}` };
  }
  const zhTw = voices.find((voice): boolean => /^zh[-_]TW/i.test(voice.lang));
  if (zhTw !== undefined) {
    return { voice: zhTw, quality: 'standard', source: `繁体中文音色 ${zhTw.name}` };
  }
  /* 放宽到任意 zh-* （排除粤语 zh-HK：念普通话文本可懂度太低） */
  const anyZh = voices.find(
    (voice): boolean => /^zh/i.test(voice.lang) && !/^zh[-_]HK/i.test(voice.lang),
  );
  if (anyZh !== undefined) {
    return { voice: anyZh, quality: 'standard', source: `中文音色 ${anyZh.name}` };
  }

  return { voice: null, quality: 'none', source: '未安装中文音色' };
}

/* ========================================================================== */
/* Hook                                                                       */
/* ========================================================================== */

/* ========================================================================== */
/* 用户偏好持久化（C4：播放速度 / 音色）                                        */
/* ========================================================================== */

/** localStorage 键名（加版本前缀，未来结构变更时不误读旧值） */
const STORAGE_RATE_KEY = 'kv-tts-rate-v1';
const STORAGE_VOICE_KEY = 'kv-tts-voice-v1';

/** 速度合法区间（SpeechSynthesisUtterance.rate 实际有效范围） */
const MIN_RATE = 0.5;
const MAX_RATE = 2;

/**
 * readStoredRate —— 读取持久化速度（SSR 安全）。
 *
 * @param fallback 缺省速度
 * @returns 合法区间内的速度
 */
function readStoredRate(fallback: number): number {
  if (typeof window === 'undefined') return fallback;
  try {
    const raw = window.localStorage.getItem(STORAGE_RATE_KEY);
    if (raw === null) return fallback;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(MAX_RATE, Math.max(MIN_RATE, parsed));
  } catch {
    return fallback;
  }
}

/**
 * readStoredVoiceUri —— 读取持久化音色 URI（SSR 安全）。
 *
 * @returns 音色 URI；无记录返回 null
 */
function readStoredVoiceUri(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_VOICE_KEY);
    return raw !== null && raw.length > 0 ? raw : null;
  } catch {
    return null;
  }
}

/** useSpeechSynthesis 的返回值契约 */
export interface UseSpeechSynthesisResult {
  /** 播放状态机当前态 */
  readonly playbackState: TtsPlaybackState;
  /** 当前选中的音色信息（用于界面诚实标注） */
  readonly voiceInfo: VoiceSelectResult;
  /** 正在朗读的消息 ID（null 表示未在朗读） */
  readonly speakingMessageId: string | null;
  /** 当前环境是否支持语音合成 */
  readonly isSupported: boolean;
  /**
   * 朗读一段文本。
   * @param text  原始 Markdown 文本（内部会自动净化）
   * @param messageId 关联的消息 ID（用于在气泡上高亮"正在朗读"）
   * @param onEnd 朗读结束/被打断时的回调（用于清空 speakingMessageId）
   */
  readonly speak: (text: string, messageId: string, onEnd?: () => void) => void;
  /** 立即停止朗读 */
  readonly stop: () => void;
  /** 播放速度（0.5~2，持久化） */
  readonly rate: number;
  /** 修改播放速度（自动持久化） */
  readonly setRate: (rate: number) => void;
  /** 当前选择的音色 URI（null = 自动优选中文音色） */
  readonly voiceUri: string | null;
  /** 修改音色（自动持久化） */
  readonly setVoiceUri: (uri: string | null) => void;
  /** 系统可用音色列表（用于 UI 选择，简化字段避免跨端类型差异） */
  readonly voices: readonly { readonly uri: string; readonly name: string; readonly lang: string }[];
  /** 自动播放被浏览器策略拦截时的提示（null = 无） */
  readonly blockedNotice: string | null;
}

/**
 * useSpeechSynthesis —— 中文语音播报控制器。
 *
 * 【为何把状态收进 Hook 而非留在组件】播报涉及三类异步事件
 * （voiceschanged、utterance.onend、utterance.onerror）与一个全局单例
 * （window.speechSynthesis 是**整个页面共享**的，多个组件各自播报会互相打断）。
 * 集中到一个 Hook 里，才能保证"任意时刻只有一个播报在跑"这个不变式。
 *
 * @returns 播报状态、音色信息与播报控制方法
 */
export function useSpeechSynthesis(): UseSpeechSynthesisResult {
  const [playbackState, setPlaybackState] = useState<TtsPlaybackState>('idle');
  const [speakingMessageId, setSpeakingMessageId] = useState<string | null>(null);
  const [voiceInfo, setVoiceInfo] = useState<VoiceSelectResult>({
    voice: null,
    quality: 'none',
    source: '尚未加载语音列表',
  });
  const [isSupported, setIsSupported] = useState<boolean>(false);
  /** C4：播放速度（懒初始化读 localStorage，SSR 期回退默认值） */
  const [rate, setRateState] = useState<number>(() => readStoredRate(SPEECH_RATE));
  /** C4：指定音色 URI（null = 自动优选） */
  const [voiceUri, setVoiceUriState] = useState<string | null>(() => readStoredVoiceUri());
  /** 系统可用音色（供 UI 下拉） */
  const [voices, setVoices] = useState<
    readonly { readonly uri: string; readonly name: string; readonly lang: string }[]
  >([]);
  /** blocked 态的用户可操作提示 */
  const [blockedNotice, setBlockedNotice] = useState<string | null>(null);
  /** 音色对象缓存：speak 时按 voiceUri 精确解析 */
  const voiceListRef = useRef<readonly SpeechSynthesisVoice[]>([]);

  /** 当前 utterance 引用：用于在停止时精确取消并解绑回调 */
  const utteranceRef = useRef<SpeechSynthesisUtterance | null>(null);
  /** 结束回调：utterance.onend 里触发，供调用方清理 UI 态 */
  const onEndRef = useRef<(() => void) | null>(null);
  /** 是否已卸载：阻止卸载后 setState */
  const mountedRef = useRef<boolean>(true);

  /* ---------------------------------------------------------------------- */
  /* 环境探测 + 音色加载                                                     */
  /* ---------------------------------------------------------------------- */

  useEffect(() => {
    mountedRef.current = true;

    if (typeof window === 'undefined' || !('speechSynthesis' in window)) {
      setIsSupported(false);
      setPlaybackState('unsupported');
      return (): void => {
        mountedRef.current = false;
      };
    }

    setIsSupported(true);

    /**
     * 更新音色列表。
     *
     * 【为何要反复调用】Chrome 的 getVoices() 首次几乎总是返回空数组，
     * 语音包加载完成后才通过 onvoiceschanged 通知。这里既在挂载时试一次
     * （可能已加载），也订阅事件（可能稍后加载）。
     */
    const refreshVoices = (): void => {
      if (!mountedRef.current) return;
      const available = window.speechSynthesis.getVoices();
      voiceListRef.current = available;
      const selected = selectBestChineseVoice(available);
      setVoiceInfo(selected);
      setVoices(
        available.map((voice) => ({ uri: voice.voiceURI, name: voice.name, lang: voice.lang })),
      );
    };

    refreshVoices();
    window.speechSynthesis.addEventListener('voiceschanged', refreshVoices);

    /**
     * 【超时兜底】若超时后仍无中文音色，把状态标为 unsupported，
     * 让界面显示"未检测到中文语音包"而不是让用户对着静音猜。
     * 这不是失败退出——若之后 voiceschanged 到达，refreshVoices
     * 仍会把 voiceInfo 更新为可用，界面自动恢复。
     */
    const timer = window.setTimeout((): void => {
      if (!mountedRef.current) return;
      const voices = window.speechSynthesis.getVoices();
      if (voices.length === 0) {
        setVoiceInfo({ voice: null, quality: 'none', source: '语音包加载超时' });
      }
    }, VOICE_LOAD_TIMEOUT_MS);

    return (): void => {
      mountedRef.current = false;
      window.clearTimeout(timer);
      window.speechSynthesis.removeEventListener('voiceschanged', refreshVoices);
    };
  }, []);

  /* ---------------------------------------------------------------------- */
  /* stop                                                                    */
  /* ---------------------------------------------------------------------- */

  /**
   * stop —— 立即停止当前播报并复位状态。
   *
   * 【为何要手动解绑回调】speechSynthesis.cancel() 会触发当前 utterance 的
   * onerror（error = 'interrupted'）或 onend。若不解绑，
   * 那次残留回调会在下一次播报开始后才执行，把新播报的 UI 态误清掉。
   */
  const stop = useCallback((): void => {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;

    const utter = utteranceRef.current;
    if (utter !== null) {
      utter.onend = null;
      utter.onerror = null;
      utteranceRef.current = null;
    }
    onEndRef.current = null;

    window.speechSynthesis.cancel();
    if (mountedRef.current) {
      setSpeakingMessageId(null);
      setPlaybackState('idle');
    }
  }, []);

  /* ---------------------------------------------------------------------- */
  /* speak                                                                   */
  /* ---------------------------------------------------------------------- */

  const speak = useCallback(
    (text: string, messageId: string, onEnd?: () => void): void => {
      if (typeof window === 'undefined' || !('speechSynthesis' in window)) {
        setPlaybackState('unsupported');
        return;
      }

      const spoken = sanitizeForSpeech(text);
      if (spoken.length === 0) {
        /* 净化后为空（例如整条回复都是代码块）：不播报，也不报错 */
        setPlaybackState('idle');
        return;
      }

      /* ---- 1. 先取消上一个播报（全局单例，不能并存） ---- */
      const previous = utteranceRef.current;
      if (previous !== null) {
        previous.onend = null;
        previous.onerror = null;
        utteranceRef.current = null;
      }
      window.speechSynthesis.cancel();

      /* ---- 2. 构造 utterance 并绑定音色 ---- */
      const utter = new SpeechSynthesisUtterance(spoken);
      const selected = selectBestChineseVoice(window.speechSynthesis.getVoices());
      if (selected.voice !== null) {
        /* C4：用户指定了音色则精确匹配，否则用自动优选结果 */
      const preferredVoice =
        voiceUri === null ? undefined : voiceListRef.current.find((voice) => voice.voiceURI === voiceUri);
      utter.voice = preferredVoice ?? selected.voice;
      utter.rate = rate;
      }
      /* 即使没选到具体音色也设 lang：部分浏览器会据此挑选匹配引擎 */
      utter.lang = 'zh-CN';

      utter.pitch = SPEECH_PITCH;
      utter.volume = 1;

      onEndRef.current = onEnd ?? null;

      /* ---- 3. 事件回调：每次都清理引用，保证回调只生效一次 ---- */
      utter.onstart = (): void => {
        if (!mountedRef.current) return;
        setPlaybackState('speaking');
      };

      utter.onend = (): void => {
        utteranceRef.current = null;
        if (mountedRef.current) {
          setSpeakingMessageId(null);
          setPlaybackState('idle');
        }
        const cb = onEndRef.current;
        onEndRef.current = null;
        cb?.();
      };

      utter.onerror = (event): void => {
        utteranceRef.current = null;
        if (mountedRef.current) {
          setSpeakingMessageId(null);
          /**
           * 【区分错误类型】'interrupted' / 'canceled' 是我们主动 cancel 的
           * 正常结果，不算失败；'not-allowed' 表示自动播放策略拦截，
           * 需要用户在页面上做过交互才能发声——这类要如实告知，
           * 否则用户只会觉得"喇叭没反应"。
           */
          const err = (event as SpeechSynthesisErrorEvent).error;
          setPlaybackState(err === 'not-allowed' ? 'blocked' : 'idle');
        }
        const cb = onEndRef.current;
        onEndRef.current = null;
        cb?.();
      };

      utteranceRef.current = utter;
      setSpeakingMessageId(messageId);
      /* 进入 preparing：Chrome 从调用 speak 到真正出声有约 100-300ms 延迟，
         这段时间界面应显示"正在准备"而不是假装已开始朗读 */
      setPlaybackState('preparing');

      /**
       * ---- 4. 真正发声 ----
       *
       * 【为何包 try/catch】部分浏览器在音频设备被独占时 speak() 会同步抛错。
       * 捕获后标记为 idle，不让一个音频异常炸掉整个对话界面。
       */
      try {
        window.speechSynthesis.speak(utter);
      } catch {
        utteranceRef.current = null;
        setSpeakingMessageId(null);
        setPlaybackState('idle');
        const cb = onEndRef.current;
        onEndRef.current = null;
        cb?.();
      }
    },
    [rate, voiceUri],
  );

  /* ---------------------------------------------------------------------- */
  /* C4：偏好持久化                                                           */
  /* ---------------------------------------------------------------------- */

  useEffect((): void => {
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(STORAGE_RATE_KEY, String(rate));
    } catch {
      /* 隐私模式/配额耗尽：持久化失败不影响播报本身 */
    }
  }, [rate]);

  useEffect((): void => {
    if (typeof window === 'undefined') return;
    try {
      if (voiceUri === null) {
        window.localStorage.removeItem(STORAGE_VOICE_KEY);
      } else {
        window.localStorage.setItem(STORAGE_VOICE_KEY, voiceUri);
      }
    } catch {
      /* 同上 */
    }
  }, [voiceUri]);

  /**
   * C4：blocked 态必须能在用户交互后复位。
   *
   * 【修复的缺陷】旧实现把 not-allowed 写成 blocked 后**永不复位**：
   * 用户明明已经点过页面、浏览器也允许了，界面仍显示"被拦截"，
   * 再点朗读也没有任何反应。现在监听一次用户手势（pointerdown/keydown），
   * 一旦发生就复位为 idle 并给出可操作提示。
   */
  useEffect((): (() => void) | undefined => {
    if (playbackState !== 'blocked') return undefined;
    setBlockedNotice('浏览器拦截了自动播放：已完成一次交互，请再次点击朗读');
    const reset = (): void => {
      setPlaybackState('idle');
      setBlockedNotice(null);
    };
    window.addEventListener('pointerdown', reset, { once: true });
    window.addEventListener('keydown', reset, { once: true });
    return (): void => {
      window.removeEventListener('pointerdown', reset);
      window.removeEventListener('keydown', reset);
    };
  }, [playbackState]);

  /**
   * setRate —— 夹取到合法区间后写入（避免 UI 传入 0 或 5 导致不可读）。
   *
   * @param next 目标速度
   */
  const setRate = useCallback((next: number): void => {
    setRateState(Math.min(MAX_RATE, Math.max(MIN_RATE, Math.round(next * 100) / 100)));
  }, []);

  const setVoiceUri = useCallback((uri: string | null): void => {
    setVoiceUriState(uri !== null && uri.length > 0 ? uri : null);
  }, []);

  /* ---------------------------------------------------------------------- */
  /* 卸载清理                                                                */
  /* ---------------------------------------------------------------------- */

  useEffect(() => {
    return (): void => {
      /* 组件卸载时停止播报，避免离开页面后声音继续 */
      if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
        window.speechSynthesis.cancel();
      }
    };
  }, []);

  return {
    playbackState,
    voiceInfo,
    speakingMessageId,
    isSupported,
    speak,
    stop,
    rate,
    setRate,
    voiceUri,
    setVoiceUri,
    voices,
    blockedNotice,
  };
}