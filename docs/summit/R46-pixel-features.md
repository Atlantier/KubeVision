# R46 · 端侧像素特征（无 Key 也能"真看图"）

> 任务 B 完成：客户端在发送前对 3D 视口截图做颜色统计，特征随请求发送；
> 引擎 B 据此生成**真实**空间观察（实测已出现"3 个连通块、质心右前 worker-gamma"）。
> 多步只读工具（C）与 grounding（D）本轮未做。

---

## 1. 端侧特征提取（`src/utils/pixelFeatures.ts`）

canvas 缩略到 320×180 后逐像素分类（不新增依赖）：

| 字段 | 含义 |
|---|---|
| `redRatio / amberRatio / greenRatio / cyanRatio` | 高饱和像素的颜色占比（HSV 分类） |
| `redCentroidX / redCentroidY` | 红色像素加权质心（归一化 0~1） |
| `redClusters` | 24×14 网格上红色连通块数量（4 邻域 BFS） |
| `redRegion` | left / center / right（按质心 x 三分） |
| `redCenterBandRatio` | 红色像素落在屏幕中央 40% 横向带的比例 |

**诚实边界**：没有相机投影矩阵可用于精确求"机架投影区"交叠，中央带是**近似代理**，
字段命名与文档都标注为近似。

## 2. 随请求发送

- `CopilotDrawer.sendMessage`：有截图时 `await computeViewportPixelFeatures(viewportForSend)`，
  非 null 则加入请求体 `pixelFeatures`；
- 类型：`ChatRequestBody.pixelFeatures?: PixelFeatures`（`src/types/ai.ts`）；
- `/api/chat` 解析时逐字段 clamp 到 [0,1] / 0~64 整数，`redRegion` 只接受枚举，非法值归 'none'。

## 3. 引擎 B 真实观察（实测）

`streamWithSimulator` 在报告末尾追加 `renderPixelObservation`：

```
### 画面空间观察（端侧像素统计，非多模态模型）

- 红色热区：3 个连通块，质心位于右前（近似 worker-gamma 机架方向）（x=0.71, y=0.46）
- 颜色占比：红 4.2% · 琥珀 1.8% · 绿 11.0% · 青 7.0%
- 中央带占比（机架投影近似）：12.0%

> 以上为端侧 canvas 颜色统计的近似观察，用于无 Key 场景的快速空间定位，不替代多模态模型。
```

实测请求（engine 回落 simulator）在 25s 打字过程中出现上述段落，数字与传入特征一致。

## 4. 验收

```
tsc 0 · next lint 干净
POST /api/chat（带 pixelFeatures）           → HTTP 200
stream 文本含「画面空间观察」              → 是
红色热区块数/区域/质心与请求特征一致       → 是（3 块 / 右前 / x=0.71）
```

## 5. 未完成与风险

1. **有 Key 时仍优先多模态**：pixelFeatures 只用于引擎 B；引擎 A 的 prompt 未注入像素特征
   （需求允许"有 Key 时优先多模态"）。
2. **机架方向映射是启发式**：左/中/右三分 → worker-alpha/beta/gamma 只是近似，
   相机旋转/预设切换后不一定成立；文案已写"近似"。
3. **连通块阈值未调参**：24×14 网格粒度较粗，密集小热区可能合并。
4. 像素特征未参与审计摘要/trace，属纯提示增强。
5. 多步只读工具（C）与 grounding（D）未实现。

## 6. 回滚

```bash
git revert --no-edit <本轮 commit>
git reset --hard 78d6ca2     # 回到 r45
git reset --hard v12-baseline
```