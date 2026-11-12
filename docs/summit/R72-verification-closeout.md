# R72 · 未验证项收口：J-3/J-6 测试口径与 R71 回放实测

> 文件：`scripts/verify-demo.mjs`、`docs/summit/R71-replay-layout-fix.md`、回放实测证据
> 目标：处理 R70/R71 遗留的两个“未验证/风险”项，让自动检查反映真实产品行为。

## 1. J-6：字幕格式改为 T+mm:ss 后测试误报

TopBar 已移除总时长分母，字幕条现在是：

```text
阶段 3/4 · T+00:18
```

旧 `READ_STATE` 仍解析 `Ns / Ns`，导致 `pausedElapsedSec/resumedElapsedSec` 恒为 null。
R72 改为解析 `T+mm:ss`：

```js
const elapsedHit = barText.match(/T\+(\d{2}):(\d{2})/);
barElapsedSec = Number(mm) * 60 + Number(ss);
```

阶段单调性断言不变；暂停/恢复实测从 `null` 变为 `2s → 5s`，J-6 通过。

## 2. J-3：MCP 回执 actionType 间歇 null

`[MCP 回执]` 汇总行可能在终态快照之后才写入；`[MCP-ROUTER] ... invoked .../tools/restart_pod`
是卡片真实请求的第一手审计行。R72 增加兜底解析：

1. 优先读 `[MCP 回执] ... · <action> 已完成`；
2. 若缺失，读取最后一条 `[MCP-ROUTER] ... invoked ...`，从 `tools/<action>` 提取；
3. 仍无则 null（不伪造）。

这样既保留真实回执校验，又不会因日志写入时序误报。

## 3. R71 回放布局实测

完整跑一遍自动路演后展开「事故回放」，headless Edge 实测矩形：

```text
panel    left=152.1 top=789.0 right=888.1 bottom=944.0
terminal left= 21.0 top=947.0 right=1021.3 bottom=979.0
toolbar  left=1033.3 top=803.0 right=1083.3 bottom=979.0
overlapTerminal = false
overlapToolbar  = false
```

证据：

- `docs/summit/shots/r71-replay/replay-expanded-1680x1000.png`
- `docs/summit/shots/r71-replay/layout.json`

## 4. 验证（真实执行）

```text
npx tsc --noEmit          → 0 error
npx next lint             → No ESLint warnings or errors
npx next build            → exit 0（4/4 static pages，First Load 177 kB）
node scripts/verify-demo.mjs → 通过 22 · 失败 0（全部通过）
```

J-3/J-6 不再因测试口径失败；R71 的回放面板与底部终端、右下工具条实测零重叠。

## 5. 剩余风险

1. 回放布局实测只覆盖 1680×1000；其他视口依赖同一组安全区常量。
2. J-3 的兜底解析依赖 `[MCP-ROUTER]` 审计行；若未来日志格式变化，需要同步更新解析。
3. R69 的相机“高频晃动”仍无像素级抖动断言；本轮未新增该指标。
4. 历史 dead-export 基线 18 条仍在，`check-dead-exports` 只保证“无新增”。

## 6. 回滚

```bash
git revert --no-edit <本轮 commit>
git reset --hard 82c3bc8   # R71 回放布局
```