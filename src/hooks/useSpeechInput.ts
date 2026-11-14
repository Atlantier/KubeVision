'use client';

/**
 * KubeVision AI — 语音输入 Hook（useSpeechInput）
 *
 * 【这个 Hook 要解决的真实问题】
 * 国内网络下 Chrome 的 `webkitSpeechRecognition` 依赖 Google 服务器，
 * 点击麦克风后几乎必然走到 `event.error === 'network'`。旧实现在这里
 * 直接 `setSpeechError('语音识别出错：network')` 并停止录音，结果是：
 * - 界面上弹出一句用户看不懂的英文错误；
 * - 录音立即中断，想说第二句都没机会；
 * - 演示现场一旦用 Chrome，语音功能等于完全不可用。
 *
 * 更隐蔽的问题：旧实现虽然"在录音"，但**没有任何麦克风可视化**。
 * 用户对着屏幕说话时看不到任何反馈——不知道麦克风是否真的在工作、
 * 声音是否被采集到。这种"无反馈的录音"体验上等同于坏了。
 *
 * 【本 Hook 的三层设计】
 * 1. **真实麦克风频谱**：始终通过 getUserMedia 拿到真实音频流，
 *    用 AnalyserNode 做 FFT，输出 12 频段能量供界面渲染频谱柱。
 *    这一层**不依赖任何网络**，因此永远可用。
 * 2. **云端识别优先**：环境支持时用 SpeechRecognition 做实时转写
 *    （interimResults = true，边说边出字）。可选配置 NEXT_PUBLIC_ASR_API_URL。
 * 3. **声学兜底**：一旦识别器报 network / service-not-allowed，
 *    **不中断录音**，只把 mode 切到 'acoustic'。麦克风频谱继续跳动，
 *    用户说完后由 `stop()` 结合真实拾音时长与集群上下文
 *    生成一条合理的 SRE 诊断指令。界面如实标注当前处于端侧模式。
 *
 * 【为何"声学兜底"也能产出有用的话术】
 * 它并不假装识别了语音——那是欺骗。它做的是：基于**用户确实开口说了话**
 * 这一事实（由 activeVoiceFrames 证实）以及当前集群状态，
 * 提供一条最可能的诊断指令供用户确认/编辑。这比报错中断有用得多，
 * 且界面明确标注"端侧模式"，用户知道这不是转写结果。
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import type {
  AsrFallbackMode,
  SpeechInputController,
  SpeechInputSnapshot,
  SpeechRecognitionLike,
  SpeechRecognitionWindow,
} from '@/types/ai';

/* ========================================================================== */
/* 常量                                                                       */
/* ========================================================================== */

/** 频谱频段数（与界面渲染的柱子数量一致） */
const BAND_COUNT = 12;

/** FFT 窗口大小：64 点对应 32 个频段，足够覆盖人声主要能量区且开销极低 */
const FFT_SIZE = 64;

/**
 * 有效发声阈值（归一化能量 0~1）。
 *
 * 【取值依据】环境底噪通常低于 0.05；正常说话会稳定超过 0.08。
 * 取 0.06 是两者的分界，既能过滤底噪，又不会漏掉轻声说话。
 */
const VOICE_ENERGY_THRESHOLD = 0.06;

/** 判定"用户说过话"所需的最少有效发声帧数（约 0.2 秒 @ 60fps） */
const MIN_ACTIVE_FRAMES = 12;

/**
 * 静音自动收尾时长（毫秒）。
 *
 * 【作用】声学模式下，用户说完后往往不会主动点"完成录音"。
 * 检测到连续 1.8 秒无有效发声即自动收尾，体验上更自然。
 * 云端模式也有同样需求（部分环境下识别器不会自己 end）。
 */
const SILENCE_AUTO_STOP_MS = 1800;

/** 最短拾音时长：低于此值视为误触，不产出任何文本 */
const MIN_RECORD_MS = 400;

/* ========================================================================== */
/* 纯函数：频谱计算                                                            */
/* ========================================================================== */

/**
 * computeBands —— 从频域数据计算 12 个频段的归一化能量。
 *
 * 【为何要分组而非直接取前 12 个 bin】FFT 输出的 bin 频率是线性的，
 * 而人声能量集中在低频区（85Hz~255Hz 基频 + 谐波）。若直接取前 12 个 bin，
 * 得到的全是极低频，高亢的语音几乎不会反映在柱子上——看起来就是"死板"。
 *
 * 正确做法是**对数分组**：把 32 个 bin 按频率对数分布映射到 12 个频段，
 * 让低频占用较少 bin、高频占用较多，符合人耳听觉特性，柱状图才有层次。
 *
 * @param frequencyData Uint8Array 频域幅度（0~255）
 * @returns 12 个归一化到 0~1 的能量值
 */
export function computeBands(frequencyData: Uint8Array): number[] {
  const bands: number[] = [];
  const usableBins = Math.min(frequencyData.length, FFT_SIZE / 2);

  for (let band = 0; band < BAND_COUNT; band += 1) {
    /**
     * 对数分组边界：band 0 覆盖最小的 bin 范围，band 11 覆盖最大的。
     * 用指数曲线让低频段窄、高频段宽。
     */
    const startRatio = Math.pow(band / BAND_COUNT, 1.6);
    const endRatio = Math.pow((band + 1) / BAND_COUNT, 1.6);
    const startBin = Math.floor(startRatio * usableBins);
    const endBin = Math.max(startBin + 1, Math.floor(endRatio * usableBins));

    let sum = 0;
    let count = 0;
    for (let bin = startBin; bin < endBin && bin < usableBins; bin += 1) {
      sum += frequencyData[bin];
      count += 1;
    }

    /* 归一化到 0~1；空组（高频静默）返回 0 */
    bands.push(count > 0 ? Math.min(1, sum / count / 255) : 0);
  }

  return bands;
}

/* ========================================================================== */
/* 纯函数：声学兜底指令生成                                                     */
/* ========================================================================== */

/**
 * buildAcousticFallbackPrompt —— 端侧模式下的指令推断。
 *
 * 【诚实性声明】这不是语音识别。它只做一件事：基于"用户确实说了话"
 * 这个确证事实（有效发声帧数达标），结合当前集群状态，给出一条
 * **最可能符合意图**的诊断指令，让用户直接发送或修改后发送。
 *
 * 相比弹一个"识别失败"的错误框，这个策略的价值在于：
 * 演示不中断、用户仍能继续、且界面明确标注了这是推断而非转写。
 *
 * 【为何要结合集群上下文】故障态下问的几乎必然是故障诊断；
 * 健康集群下问的往往是巡检。用上下文把候选收敛，命中率显著高于
 * 一条与场景无关的通用话术。
 *
 * @param hasSpoken     用户是否真的说过话（由发声帧数判定）
 * @param elapsedSec    实际拾音时长（秒）
 * @param faultyCount   当前异常 Pod 数
 * @param selectedName  当前选中的实体名（可能为 null）
 * @param chaos         当前演练场景
 * @returns 待填入输入框的指令文本；未说话时返回空串
 */
export function buildAcousticFallbackPrompt(
  hasSpoken: boolean,
  elapsedSec: number,
  faultyCount: number,
  selectedName: string | null,
  chaos: string,
): string {
  /* 用户没真的开口（只是点了麦克风就点了完成）→ 不产出任何文本 */
  if (!hasSpoken) return '';

  /* 说了很久（>6s）：大概率在描述较复杂的现象，给出综合诊断指令 */
  const longSpeech = elapsedSec > 6;

  if (selectedName !== null) {
    return longSpeech
      ? `请结合 3D 视口快照，详细分析 ${selectedName} 当前的运行状态、指标异常与关联告警，并给出根因与处置建议`
      : `分析 ${selectedName} 当前的运行状态与指标异常`;
  }

  if (chaos !== 'NONE') {
    return `集群当前处于 ${chaos} 演练态，请定位受影响的 Pod、分析根因并给出自愈方案`;
  }

  if (faultyCount > 0) {
    return longSpeech
      ? `集群中有 ${faultyCount} 个异常 Pod，请全面排查其根因、影响范围与依赖链路，并给出分级处置建议`
      : `请诊断集群中 ${faultyCount} 个异常 Pod 的根因并给出自愈方案`;
  }

  return longSpeech
    ? '请全面巡检当前集群健康状态，重点关注节点水位均衡度、QoS 裕量与潜在风险'
    : '全面巡检当前集群健康状态';
}

/* ========================================================================== */
/* Hook                                                                       */
/* ========================================================================== */

/** useSpeechInput 的可选参数 */
export interface UseSpeechInputOptions {
  /** 生成兜底指令时所需的上下文快照（每次 stop 时读取最新值） */
  readonly getContext: () => {
    readonly faultyCount: number;
    readonly selectedName: string | null;
    readonly chaos: string;
  };
}

/**
 * useSpeechInput —— 语音输入控制器（真实麦克风频谱 + 断网兜底）。
 *
 * @param options 上下文读取器
 * @returns 拾音控制与实时可视化数据
 */
export function useSpeechInput(options: UseSpeechInputOptions): SpeechInputController {
  const { getContext } = options;

  const [isListening, setIsListening] = useState<boolean>(false);
  const [mode, setMode] = useState<AsrFallbackMode>('cloud');
  const [notice, setNotice] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<SpeechInputSnapshot>({
    bands: new Array<number>(BAND_COUNT).fill(0),
    elapsedSec: 0,
    interimText: '',
    activeVoiceFrames: 0,
    mode: 'cloud',
  });

  /* ---- 音频资源 ---- */
  const streamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const rafRef = useRef<number | null>(null);

  /* ---- 识别器 ---- */
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  /** 云端识别累计到的最终文本 */
  const transcriptRef = useRef<string>('');
  /** 云端识别的中间结果（实时上屏用） */
  const interimRef = useRef<string>('');

  /* ---- 计时与发声统计 ---- */
  const startedAtRef = useRef<number>(0);
  const activeFramesRef = useRef<number>(0);
  const lastVoiceAtRef = useRef<number>(0);
  /** Q2：结构化错误原因（权限 / 不支持 / 网络），供 UI 给出具体提示与重试 */
  const [errorKind, setErrorKind] = useState<'permission' | 'unsupported' | 'network' | null>(null);
  /** Q1：最近一次 stop 产出的最终文本（供调用方自动发送） */
  const [finalText, setFinalText] = useState<string | null>(null);
  /** 与 finalText 同步的瞬时引用，保证 React 18 并发渲染下 consumeFinalText 的原子消费 */
  const finalTextRef = useRef<string | null>(null);
  /** C3：上一次向 React 发布频谱的时间戳（限制 ≤8Hz，避免整树 60FPS 重渲染） */
  const lastPublishAtRef = useRef<number>(0);
  /** Q2：CSS 变量 --kv-mic-level 的节流写入时间（零重渲染驱动图标电平） */
  const lastCssVarAtRef = useRef<number>(0);
  /** C3：静音自动收尾是否已触发（保证只触发一次） */
  const silenceStopRequestedRef = useRef<boolean>(false);
  /** C3：stop 的最新引用，供静音收尾调用 */
  const stopFnRef = useRef<(() => void) | null>(null);
  /** C3：start 并发互斥锁（防止连点开两条麦克风管线） */
  const startingRef = useRef<boolean>(false);
  /** 是否已进入声学兜底模式（判定后不再尝试云端） */
  const acousticModeRef = useRef<boolean>(false);
  /** 组件是否已卸载 */
  const mountedRef = useRef<boolean>(true);
  /** 固定长度复用缓冲，避免每帧分配（60FPS 红线） */
  const freqBufferRef = useRef<Uint8Array | null>(null);

  /* ---------------------------------------------------------------------- */
  /* 资源清理                                                                */
  /* ---------------------------------------------------------------------- */

  /**
   * releaseAudio —— 释放麦克风与音频上下文。
   *
   * 【为何必须停掉所有 track】getUserMedia 拿到的 MediaStream 会持续占用
   * 麦克风设备，浏览器地址栏的"正在录音"指示器会一直亮着。
   * 必须显式 stop 每条 track，否则用户会以为被偷偷监听。
   */
  const releaseAudio = useCallback((): void => {
    if (rafRef.current !== null) {
      window.cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (analyserRef.current !== null) {
      analyserRef.current.disconnect();
      analyserRef.current = null;
    }
    if (audioCtxRef.current !== null) {
      void audioCtxRef.current.close().catch((): void => {
        /* 已关闭或环境不支持：忽略 */
      });
      audioCtxRef.current = null;
    }
    if (streamRef.current !== null) {
      for (const track of streamRef.current.getTracks()) {
        track.stop();
      }
      streamRef.current = null;
    }
  }, []);

  /* ---------------------------------------------------------------------- */
  /* 启动麦克风 + 频谱循环                                                    */
  /* ---------------------------------------------------------------------- */

  /**
   * startAudioMeter —— 打开真实麦克风并启动频谱采样循环。
   *
   * @returns 是否成功拿到音频流
   */
  const startAudioMeter = useCallback(async (): Promise<boolean> => {
    if (typeof navigator === 'undefined' || navigator.mediaDevices === undefined) {
      return false;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          /* 关闭自动增益与降噪会让人声更"真实"，但也更容易触发误判，
             这里保留浏览器默认处理，只显式关闭回声消除以保证频谱反映真实音量 */
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      });
      if (!mountedRef.current) {
        for (const track of stream.getTracks()) track.stop();
        return false;
      }
      streamRef.current = stream;

      /**
       * AudioContext 构造需要处理 webkit 前缀：
       * 部分旧版 Safari/Chrome 仍只暴露 webkitAudioContext。
       */
      const AudioCtor: typeof AudioContext =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const ctx = new AudioCtor();
      audioCtxRef.current = ctx;

      /* 部分浏览器在无用户手势时创建 context 会处于 suspended，需显式唤醒 */
      if (ctx.state === 'suspended') {
        await ctx.resume();
      }

      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = FFT_SIZE;
      analyser.smoothingTimeConstant = 0.75;
      source.connect(analyser);
      analyserRef.current = analyser;

      freqBufferRef.current = new Uint8Array(analyser.frequencyBinCount);

      return true;
    } catch (error) {
      /* Q2：把异常翻译成用户能操作的错误类型 */
      const name = error instanceof DOMException ? error.name : '';
      setErrorKind(
        name === 'NotAllowedError' || name === 'SecurityError'
          ? 'permission'
          : name === 'NotFoundError' || name === 'NotSupportedError'
            ? 'unsupported'
            : 'network',
      );
      /**
       * 【异常路径也必须释放资源】
       *
       * 这个 catch 覆盖的范围比"权限被拒绝"更广：
       * - getUserMedia 抛错 → 此时还没有资源，releaseAudio 是空操作；
       * - AudioContext 构造失败 → 但 stream 已经拿到了！若不 stop，
       *   麦克风会一直占用，地址栏录音指示灯常亮；
       * - createMediaStreamSource / createAnalyser 失败 → 同上；
       * - ctx.resume() 拒绝 → 同上。
       *
       * 旧实现直接 `return false` 什么都不清，属于**真实泄漏路径**：
       * 一条已激活的音频轨道会一直挂在那里，直到页面关闭。
       * 实测中没复现是因为权限拒绝发生在 getUserMedia 阶段（尚无资源），
       * 但换一个失败点（如 AudioContext 达到设备上限）就会泄漏。
       */
      releaseAudio();
      return false;
    }
  }, [releaseAudio]);

  /**
   * runSpectrumLoop —— rAF 驱动的频谱采样循环。
   *
   * 【为何用 rAF 而非 setInterval】rAF 与浏览器渲染节奏同步，
   * 页面不可见时会自动暂停（省电且避免后台无意义计算）；
   * setInterval 则会在后台持续跑并可能堆积。
   */
  const runSpectrumLoop = useCallback((): void => {
    const tick = (): void => {
      if (!mountedRef.current) return;

      const analyser = analyserRef.current;
      const buffer = freqBufferRef.current;
      if (analyser === null || buffer === null) return;

      /* 读取频域幅度并计算 12 频段 */
      analyser.getByteFrequencyData(buffer);
      const bands = computeBands(buffer);

      /* 有效发声判定：用中低频段的平均值代表整体人声能量 */
      const voiceEnergy = bands.slice(0, 7).reduce((a, b): number => a + b, 0) / 7;
      const now = Date.now();

      /*
       * Q2：把电平写进 CSS 变量（每 125ms 一次，零 React 重渲染）。
       * 麦克风图标的发光/脉冲由 CSS 读 var(--kv-mic-level) 驱动，
       * 这样频谱变化不会触发任何组件 setState。
       */
      if (now - lastCssVarAtRef.current >= 125 && typeof document !== 'undefined') {
        lastCssVarAtRef.current = now;
        /* computeBands 已完成 /255 归一化（voiceEnergy ∈ [0, 1]），此处施加适度视觉增益 */
        const level = Math.min(1, Math.max(0, voiceEnergy * 2.2));
        document.documentElement.style.setProperty('--kv-mic-level', level.toFixed(3));
      }
      if (voiceEnergy > VOICE_ENERGY_THRESHOLD) {
        activeFramesRef.current += 1;
        lastVoiceAtRef.current = now;
      }

      const elapsedSec = (now - startedAtRef.current) / 1000;

      /*
       * 【C3 自愈：rAF 每帧 setState → ≤8Hz 低频发布】
       *
       * 旧实现每帧都 setSnapshot：60FPS × 每次 setState 触发 CopilotDrawer
       * 整树协调——语音输入期间整个对话界面被拖进无意义的重渲染。
       * 现在每帧只更新 ref（零重渲染），最多每 125ms 发布一次视图快照（8Hz），
       * 频谱动画的观感由 CSS/低频数据足以表达。
       */
      if (now - lastPublishAtRef.current >= 125) {
        lastPublishAtRef.current = now;
        setSnapshot({
          bands,
          elapsedSec,
          interimText:
            acousticModeRef.current
              ? activeFramesRef.current >= MIN_ACTIVE_FRAMES
                ? '已捕获语音能量 · 端侧模式将在完成时生成指令'
                : '正在拾音… 请开始说话'
              : interimRef.current,
          activeVoiceFrames: activeFramesRef.current,
          mode: acousticModeRef.current ? 'acoustic' : 'cloud',
        });
      }

      /**
       * 【C3 自愈：静音 1.8s 自动收尾】
       * 旧实现只改一句提示文案"可点击完成录音"，从不真正结束——
       * 用户讲完话后麦克风一直亮着、识别继续跑。
       * 现在静音达标即调用 stop()，并保证只触发一次。
       */
      if (
        activeFramesRef.current >= MIN_ACTIVE_FRAMES &&
        now - lastVoiceAtRef.current > SILENCE_AUTO_STOP_MS &&
        !silenceStopRequestedRef.current
      ) {
        silenceStopRequestedRef.current = true;
        setNotice('检测到 1.8 秒静音，已自动结束拾音');
        stopFnRef.current?.();
      }

      rafRef.current = window.requestAnimationFrame(tick);
    };

    rafRef.current = window.requestAnimationFrame(tick);
  }, []);

  /* ---------------------------------------------------------------------- */
  /* 启动云端识别（可能失败 → 切声学模式）                                     */
  /* ---------------------------------------------------------------------- */

  /**
   * startCloudRecognition —— 尝试启动浏览器原生语音识别。
   *
   * 【关键设计：错误不中断录音】onerror 里遇到 network / service-not-allowed /
   * not-allowed 时，**不停止麦克风、不清空状态**，只把模式切到 acoustic。
   * 这是整个模块最重要的防翻车点：录音与识别被解耦，
   * 识别失败不影响"麦克风仍在工作"这一事实。
   */
  const startCloudRecognition = useCallback((): void => {
    const w = window as unknown as SpeechRecognitionWindow;
    const Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition;

    if (Ctor === undefined) {
      /* 浏览器完全不支持原生识别 → 直接走声学模式 */
      acousticModeRef.current = true;
      setMode('acoustic');
      setNotice('当前浏览器不支持云端语音识别，已启用端侧声学模式');
      return;
    }

    try {
      const recognition = new Ctor();
      recognition.lang = 'zh-CN';
      /**
       * 【interimResults = true 的意义】边说边出字。
       * 旧实现设为 false，用户说完才看到文字，中间毫无反馈，
       * 很容易以为自己没被听到而重复说话。
       */
      recognition.continuous = true;
      recognition.interimResults = true;

      recognition.onresult = (event): void => {
        let finalText = '';
        let interimText = '';
        for (let i = event.resultIndex; i < event.results.length; i += 1) {
          const result = event.results[i];
          const piece = result[0].transcript;
          if (result.isFinal) {
            finalText += piece;
          } else {
            interimText += piece;
          }
        }
        if (finalText.length > 0) {
          transcriptRef.current += finalText;
        }
        interimRef.current = interimText;
      };

      recognition.onerror = (event): void => {
        /**
         * ============ 核心防翻车机制 ============
         *
         * 国内网络下 Chrome 的识别器几乎必然报 'network'
         * （它要连 Google 的语音服务，被墙后直接失败）。
         * 旧实现在这里弹错误并停止录音 —— 演示当场失败。
         *
         * 现在的处理：
         * - network / service-not-allowed：静默切换到端侧声学模式，
         *   麦克风继续工作、频谱继续跳，用户完全无感；
         * - not-allowed（麦克风权限被拒）：这是真正的权限问题，
         *   无法绕过，如实提示但**仍然保持**已建立的音频流（若有）。
         */
        const err = event.error;
        if (err === 'network' || err === 'service-not-allowed') {
          acousticModeRef.current = true;
          setMode('acoustic');
          setNotice('云端识别不可用（国内网络限制），已无缝切换端侧声学模式');
          /* 刻意不 stop 录音、不清空已累计文本 */
          return;
        }
        if (err === 'not-allowed') {
          setNotice('麦克风权限被拒绝，请在浏览器地址栏允许后重试');
          return;
        }
        /* 其他错误（no-speech / aborted）：同样不中断，静默继续 */
      };

      recognition.onend = (): void => {
        /**
         * 识别器可能自行结束（静音超时）。若仍在录音且非声学模式，
         * 重启一次以维持连续识别；声学模式下无需重启。
         */
        if (!mountedRef.current) return;
        if (acousticModeRef.current) return;
        const stillListening = recognitionRef.current !== null;
        if (stillListening) {
          try {
            recognition.start();
          } catch {
            /* 已在运行 / 无法重启：交给声学模式兜底 */
            acousticModeRef.current = true;
            setMode('acoustic');
          }
        }
      };

      recognitionRef.current = recognition;
      recognition.start();
    } catch {
      /* 构造或启动失败 → 直接声学模式，绝不让用户卡住 */
      acousticModeRef.current = true;
      setMode('acoustic');
      setNotice('语音识别启动失败，已启用端侧声学模式');
    }
  }, []);

  /* ---------------------------------------------------------------------- */
  /* start                                                                   */
  /* ---------------------------------------------------------------------- */

  const start = useCallback(async (): Promise<void> => {
    /* Q2：媒体能力缺失时给出"不支持"而非笼统失败 */
    if (typeof navigator === 'undefined' || navigator.mediaDevices === undefined) {
      setErrorKind('unsupported');
      setNotice('当前浏览器不支持麦克风采集：请改用 Chrome / Edge，或直接键盘输入');
      startingRef.current = false;
      return;
    }
    setErrorKind(null);

    /*
     * 【C3：并发互斥】连点两次"开始"会开两条 getUserMedia 管线，
     * 第二条的 setState/stop 会把第一条的状态覆盖掉（幽灵麦克风）。
     * 用 startingRef 保证同一时刻只有一个启动流程。
     */
    if (startingRef.current || isListening) return;
    startingRef.current = true;
    silenceStopRequestedRef.current = false;

    /* 重置全部状态 */
    transcriptRef.current = '';
    interimRef.current = '';
    finalTextRef.current = null;
    setFinalText(null);
    activeFramesRef.current = 0;
    startedAtRef.current = Date.now();
    lastVoiceAtRef.current = Date.now();
    acousticModeRef.current = false;
    setMode('cloud');
    setNotice(null);

    /* 先启动真实麦克风：这是所有模式的基础 */
    const audioOk = await startAudioMeter();
    if (!mountedRef.current) {
      startingRef.current = false;
      return;
    }

    if (!audioOk) {
      startingRef.current = false;
      setNotice('无法访问麦克风，请检查浏览器权限或设备连接');
      setIsListening(false);
      return;
    }

    setIsListening(true);
    runSpectrumLoop();

    /**
     * 若配置了云端 ASR 端点，理论上应优先走它。
     *
     * 【本轮边界】NEXT_PUBLIC_ASR_API_URL 已作为可选配置读取，
     * 但当前没有配套的云端转写服务实现，因此实际仍走浏览器原生识别 +
     * 声学兜底。这里如实标注，不假装支持了一个并不存在的后端。
     */
    setErrorKind(null);
    const asrEndpoint = process.env.NEXT_PUBLIC_ASR_API_URL;
    if (asrEndpoint !== undefined && asrEndpoint.length > 0) {
      setNotice('已检测到云端 ASR 配置，但该后端尚未实现，当前使用浏览器原生识别');
    }

    startCloudRecognition();
    startingRef.current = false;
  }, [isListening, runSpectrumLoop, startAudioMeter, startCloudRecognition]);

  /* ---------------------------------------------------------------------- */
  /* stop                                                                    */
  /* ---------------------------------------------------------------------- */

  const stop = useCallback(async (): Promise<string> => {
    const elapsedMs = Date.now() - startedAtRef.current;
    const elapsedSec = elapsedMs / 1000;
    const hasSpoken = activeFramesRef.current >= MIN_ACTIVE_FRAMES;

    /* 停止识别器 */
    const recognition = recognitionRef.current;
    if (recognition !== null) {
      recognitionRef.current = null;
      try {
        recognition.stop();
      } catch {
        /* 已停止 */
      }
    }

    releaseAudio();
    if (typeof document !== 'undefined') {
      document.documentElement.style.setProperty('--kv-mic-level', '0');
    }
    if (mountedRef.current) {
      setIsListening(false);
      setSnapshot((prev) => ({ ...prev, bands: new Array<number>(BAND_COUNT).fill(0), interimText: '' }));
    }

    /* 太短的点击视为误触，不产出文本 */
    if (elapsedMs < MIN_RECORD_MS) {
      return '';
    }

    /* ---- 云端模式：用识别到的文本 ---- */
    const cloudText = `${transcriptRef.current}${interimRef.current}`.trim();
    if (!acousticModeRef.current && cloudText.length > 0) {
      finalTextRef.current = cloudText;
      setFinalText(cloudText);
      return cloudText;
    }

    /*
     * ---- 声学模式（或云端没识别到）：结合上下文推断指令 ----
     *
     * 【C3 自愈：必须标注 [声学推断]】声学兜底是根据能量与上下文"猜"出的
     * 指令，不是语音识别结果。旧实现把它当普通文本返回，输入框里看起来
     * 就像用户真的说了这句话——这是对识别能力的虚假陈述。
     */
    const ctx = getContext();
    const inferred = buildAcousticFallbackPrompt(
      hasSpoken,
      elapsedSec,
      ctx.faultyCount,
      ctx.selectedName,
      ctx.chaos,
    );
    if (inferred.trim().length === 0) {
      return '';
    }
    const inferredText = `[声学推断] ${inferred}`;
    finalTextRef.current = inferredText;
    setFinalText(inferredText);
    return inferredText;
  }, [getContext, releaseAudio]);

  /* 供静音自动收尾调用最新 stop（stop 定义在前，此赋值在每次渲染时刷新） */
  stopFnRef.current = (): void => {
    void stop();
  };

  /* ---------------------------------------------------------------------- */
  /* abort                                                                   */
  /* ---------------------------------------------------------------------- */

  const abort = useCallback((): void => {
    const recognition = recognitionRef.current;
    if (recognition !== null) {
      recognitionRef.current = null;
      try {
        recognition.abort();
      } catch {
        /* 已停止 */
      }
    }
    releaseAudio();
    if (mountedRef.current) {
      setIsListening(false);
    }
  }, [releaseAudio]);

  /* ---------------------------------------------------------------------- */
  /* 卸载清理                                                                */
  /* ---------------------------------------------------------------------- */

  useEffect(() => {
    mountedRef.current = true;
    return (): void => {
      mountedRef.current = false;
      abort();
    };
  }, [abort]);

  /**
   * consumeFinalText —— 取走并清空最终文本（Q1 自动发送的一次性消费）。
   *
   * 【设计】读写通过 finalTextRef 同步完成，避免在 setState 更新函数内部
   * 产生外部变量副作用，确保 React 18 并发/严格模式下消费行为幂等且无丢失。
   *
   * @returns 上一次 stop 的文本；无则 null
   */
  const consumeFinalText = useCallback((): string | null => {
    const taken = finalTextRef.current;
    if (taken === null) return null;
    finalTextRef.current = null;
    setFinalText(null);
    return taken;
  }, []);

  return {
    isListening,
    snapshot,
    mode,
    notice,
    errorKind,
    finalText,
    consumeFinalText,
    start,
    stop,
    abort,
  };
}