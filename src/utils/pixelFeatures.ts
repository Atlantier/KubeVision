'use client';

/**
 * KubeVision AI — 端侧像素特征（R46 · 任务 B）
 *
 * 【解决什么】没有多模态 Key 时，引擎 B 只能看到"有没有截图"，说不出画面里
 * 发生了什么。本模块在**发送前**用 canvas 对截图做一次轻量统计，得到颜色占比、
 * 红色质心、红色连通块数量与"是否集中在中央带"等特征，随请求发送。
 * 引擎 B 据此生成真实观察（例：画面里有 3 个红色热区，集中在右前机架）。
 *
 * 【为什么在端侧算】零服务端图像依赖、零新库；上传的仍是 dataURL 原图，
 * 特征是附加信息，不改变隐私边界（图像仍然只在本次请求内使用）。
 *
 * 【边界的边界】"机架投影区"没有相机投影矩阵可用于精确求交，这里用屏幕中央
 * 40% 横向带作为**近似代理**，文档与字段命名都标注为近似。
 */

import type { PixelFeatures } from '@/types/ai';

/** 分析用的缩略尺寸（足够统计，且不对大图逐像素） */
const SAMPLE_WIDTH = 320;
const SAMPLE_HEIGHT = 180;
/** 连通块网格 */
const GRID_COLS = 24;
const GRID_ROWS = 14;

/** RGB → HSV 的色相（度） */
function hueOf(r: number, g: number, b: number): number {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  if (delta === 0) return 0;
  let hue: number;
  if (max === r) hue = ((g - b) / delta) % 6;
  else if (max === g) hue = (b - r) / delta + 2;
  else hue = (r - g) / delta + 4;
  return (hue * 60 + 360) % 360;
}

/**
 * computeViewportPixelFeatures —— 从 dataURL 截图计算像素特征。
 *
 * @param dataUrl 3D 视口截图（data:image/...）
 * @returns 特征；解码失败返回 null
 */
export async function computeViewportPixelFeatures(dataUrl: string): Promise<PixelFeatures | null> {
  if (typeof document === 'undefined') return null;
  try {
    const image = new Image();
    image.src = dataUrl;
    await image.decode();

    const canvas = document.createElement('canvas');
    canvas.width = SAMPLE_WIDTH;
    canvas.height = SAMPLE_HEIGHT;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (context === null) return null;
    context.drawImage(image, 0, 0, SAMPLE_WIDTH, SAMPLE_HEIGHT);
    const { data } = context.getImageData(0, 0, SAMPLE_WIDTH, SAMPLE_HEIGHT);

    let cyan = 0;
    let green = 0;
    let amber = 0;
    let red = 0;
    let redWeightedX = 0;
    let redWeightedY = 0;
    let redPixels = 0;
    let redCenterBand = 0;
    const grid = new Uint8Array(GRID_COLS * GRID_ROWS);
    const total = SAMPLE_WIDTH * SAMPLE_HEIGHT;

    for (let index = 0; index < data.length; index += 4) {
      const r = data[index] as number;
      const g = data[index + 1] as number;
      const b = data[index + 2] as number;
      const max = Math.max(r, g, b) / 255;
      const min = Math.min(r, g, b) / 255;
      const saturation = max === 0 ? 0 : (max - min) / max;
      /* 只统计足够亮且饱和的像素：暗色背景与灰面不参与分类 */
      if (max < 0.28 || saturation < 0.42) continue;
      const hue = hueOf(r, g, b);
      const pixelIndex = index / 4;
      const x = pixelIndex % SAMPLE_WIDTH;
      const y = Math.floor(pixelIndex / SAMPLE_WIDTH);

      if (hue >= 168 && hue <= 200) cyan += 1;
      else if (hue >= 90 && hue < 168) green += 1;
      else if (hue >= 20 && hue < 90) amber += 1;
      else if (hue < 18 || hue > 340) {
        red += 1;
        redPixels += 1;
        redWeightedX += x;
        redWeightedY += y;
        const relativeX = x / SAMPLE_WIDTH;
        if (relativeX >= 0.3 && relativeX <= 0.7) redCenterBand += 1;
        const gx = Math.min(GRID_COLS - 1, Math.floor((x / SAMPLE_WIDTH) * GRID_COLS));
        const gy = Math.min(GRID_ROWS - 1, Math.floor((y / SAMPLE_HEIGHT) * GRID_ROWS));
        grid[gy * GRID_COLS + gx] = 1;
      }
    }

    /* 红色连通块（4 邻域 BFS） */
    let clusters = 0;
    const visited = new Uint8Array(grid.length);
    for (let cell = 0; cell < grid.length; cell += 1) {
      if (grid[cell] !== 1 || visited[cell] === 1) continue;
      clusters += 1;
      const queue: number[] = [cell];
      visited[cell] = 1;
      while (queue.length > 0) {
        const current = queue.pop() as number;
        const cx = current % GRID_COLS;
        const cy = Math.floor(current / GRID_COLS);
        const neighbours = [
          cx > 0 ? current - 1 : -1,
          cx < GRID_COLS - 1 ? current + 1 : -1,
          cy > 0 ? current - GRID_COLS : -1,
          cy < GRID_ROWS - 1 ? current + GRID_COLS : -1,
        ];
        for (const next of neighbours) {
          if (next >= 0 && grid[next] === 1 && visited[next] === 0) {
            visited[next] = 1;
            queue.push(next);
          }
        }
      }
    }

    const centroidX = redPixels > 0 ? redWeightedX / redPixels / SAMPLE_WIDTH : 0;
    const centroidY = redPixels > 0 ? redWeightedY / redPixels / SAMPLE_HEIGHT : 0;
    const region: PixelFeatures['redRegion'] =
      redPixels === 0 ? 'none' : centroidX < 0.34 ? 'left' : centroidX > 0.66 ? 'right' : 'center';

    const ratio = (count: number): number => Math.round((count / total) * 10000) / 10000;
    return {
      redRatio: ratio(red),
      amberRatio: ratio(amber),
      greenRatio: ratio(green),
      cyanRatio: ratio(cyan),
      redCentroidX: Math.round(centroidX * 1000) / 1000,
      redCentroidY: Math.round(centroidY * 1000) / 1000,
      redClusters: clusters,
      redRegion: region,
      redCenterBandRatio: redPixels === 0 ? 0 : Math.round((redCenterBand / redPixels) * 1000) / 1000,
    };
  } catch {
    return null;
  }
}