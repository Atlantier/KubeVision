'use client';

/**
 * KubeVision AI — 语音打断检测（useVoiceActivity）
 *
 * 【解决什么】
 * 播报进行中用户开口说话，应当立刻打断 TTS 并让麦克风接管——这是语音助手
 * 最基本的"可打断"语义。没有它，用户必须等一整段播报念完，或者手忙脚乱
 * 去点停止按钮，体验上等同于"机器在自说自话"。
 *
 * 【如何判定"开口"】不依赖语音识别（识别在断网/隐私模式下不可用），
 * 只用 WebAudio 的 AnalyserNode 计算时域 RMS 能量：
 *   - 连续 N 帧（默认 3 帧，约 50ms）超过阈值才判定为语音，避免咳嗽/键盘声误触；
 *   - 触发一次后立即停止监听并释放麦克风，避免与拾音管线抢占设备。
 *
 * 【与 useSpeechInput 的关系】两者互斥使用：本 Hook 仅负责"检测到开口"这一件事，
 * 触发后由调用方停止播报、再调用 useSpeechInput.start() 进入正式拾音。
 *
 * 【失败静默】无麦克风权限/不支持 getUserMedia 时**不报错、不弹窗**——
 * 打断能力是增强项，缺失时退回"手动停止"，不能因此打断整个对话流。
 */

import { useEffect, useRef } from 'react';

/** 触发阈值（RMS 能量，0~1；正常室内说话约 0.05~0.2） */
const VOICE_RMS_THRESHOLD = 0.05;

/** 连续超过阈值的帧数（约 50ms @60fps），抑制瞬时噪声 */
const CONSECUTIVE_FRAMES = 3;

/**
 * useVoiceActivity —— 在 enabled 期间监听麦克风能量，检测到开口时回调一次。
 *
 * @param enabled 是否启用（通常在"正在播报"时为 true）
 * @param onVoice 检测到开口的回调（只会被调用一次，直到 enabled 翻转重置）
 */
export function useVoiceActivity(enabled: boolean, onVoice: () => void): void {
  const onVoiceRef = useRef<() => void>(onVoice);
  onVoiceRef.current = onVoice;

  useEffect((): (() => void) | undefined => {
    if (!enabled || typeof window === 'undefined') return undefined;
    if (navigator.mediaDevices?.getUserMedia === undefined) return undefined;

    let disposed = false;
    let stream: MediaStream | null = null;
    let context: AudioContext | null = null;
    let rafId: number | null = null;
    let overFrames = 0;
    let triggered = false;

    const cleanup = (): void => {
      disposed = true;
      if (rafId !== null) {
        window.cancelAnimationFrame(rafId);
        rafId = null;
      }
      if (stream !== null) {
        for (const track of stream.getTracks()) track.stop();
        stream = null;
      }
      if (context !== null) {
        void context.close().catch((): void => {
          /* 已关闭 */
        });
        context = null;
      }
    };

    const start = async (): Promise<void> => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        if (disposed) {
          for (const track of stream.getTracks()) track.stop();
          return;
        }
        context = new AudioContext();
        const analyser = context.createAnalyser();
        analyser.fftSize = 1024;
        const source = context.createMediaStreamSource(stream);
        source.connect(analyser);
        const buffer = new Float32Array(analyser.fftSize);

        const tick = (): void => {
          if (disposed || triggered) return;
          analyser.getFloatTimeDomainData(buffer);
          let sum = 0;
          for (let i = 0; i < buffer.length; i += 1) sum += buffer[i] * buffer[i];
          const rms = Math.sqrt(sum / buffer.length);
          if (rms > VOICE_RMS_THRESHOLD) {
            overFrames += 1;
            if (overFrames >= CONSECUTIVE_FRAMES) {
              triggered = true;
              onVoiceRef.current();
              cleanup();
              return;
            }
          } else {
            overFrames = 0;
          }
          rafId = window.requestAnimationFrame(tick);
        };
        rafId = window.requestAnimationFrame(tick);
      } catch {
        /* 静默降级：无权限/无设备时打断不可用，仍可手动停止播报 */
        cleanup();
      }
    };

    void start();
    return cleanup;
  }, [enabled]);
}