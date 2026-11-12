# R3 · 未验证项收口 —— 玻璃/样式契约全部可证明

> 承 R1（`aef4520`）/ R2（`d9c4dd1`）。目标：把 R1/R2 遗留的"未验证项与风险"逐项做完，
> 确保所有内容均已验证。范围：只改守卫脚本 / 探针 / 文档，不改业务逻辑、不改四语义色、不升级依赖。
> `src/` 与 HEAD 内容一致（无业务改动）。

## 逐项收口对照

| 遗留未验证项 | 本轮如何做完 | 证据 |
|---|---|---|
| R2-1 真实 GPU / 跨浏览器 backdrop-filter 未实测 | 探针加 `--gpu d3d11`（ANGLE 真实独显）与 `--browser edge\|chrome`；Edge×SwiftShader、Edge×d3d11、Chrome×d3d11 三组合各 59 断言全过，`UNMASKED_RENDERER` 证明 d3d11 走 NVIDIA RTX 5070 | `computed-style-{edge-swiftshader,edge-d3d11,chrome-d3d11}.json` + 12 张截图 |
| R2-2 全量比对无构建时 skip | 加 `--require-build` 硬闸门：缺生产 CSS 即 fail 不 skip；隐藏 `.next/static/css` → exit 1（红），恢复 → exit 0（绿） | 本轮红绿演示 |
| R2-3 动态拼接类名"无能为力" | 加动态拼接闸门：`.tsx` className 颜色/透明度类含 `${…}` 即 fail；实测 0 处（全静态字面量）。正确排除 `.ts` 的 `fill-${toolName}` toolCallId 误报 | check-style-contract「无动态拼接颜色/透明度类 ✓」 |
| R2-4 reduced-motion 只测时长、未测 BootController 开场 | 探针加载前 emulate reduce，断言 `window.__KUBEVISION_BOOT__===1`（开场直接完成）；常规动效开场亦 =1 | 三组合 `[boot] 3/3` |
| R1-4 只测玻璃类本身、未对业务面板截图比对 | 探针每档视口截图真实页面 + 读取 DOM 真实挂载的 `.kv-panel` 业务面板复核 backdropFilter | 12 张 `overview-*.png` + `real-panel.backdropFilter` 断言 |
| R1-5 / R2-5 遗留 scratch 文件 | 删除 `tmp-r1-opacity-codemod.mjs`（R1 自有临时产物） | git status 干净 |

## 验证命令（真实执行）

```text
npx tsc --noEmit                          → 0 error
npx next lint                             → No ESLint warnings or errors
npx next build                            → exit 0（4/4 static pages）
node scripts/check-style-contract.mjs --require-build → 14 项全绿（218/218/0）
node scripts/probe-glass-contract.mjs --browser edge   --gpu swiftshader → 59 断言全过
node scripts/probe-glass-contract.mjs --browser edge   --gpu d3d11       → 59 断言全过（RTX 5070）
node scripts/probe-glass-contract.mjs --browser chrome --gpu d3d11       → 59 断言全过（RTX 5070）
node scripts/verify.mjs --quick           → 8/8 通过
```

## 能红能绿（三类闸门均证明）

1. 坏变量：`var(--kv-blur-panel)`→`var(--)` ⇒ exit 1；恢复 ⇒ exit 0。
2. 缺失类：注入 `bg-notacolor-500/50`（合法刻度、假颜色）⇒ 全量比对报缺失 exit 1；移除 ⇒ exit 0。
3. `--require-build`：隐藏 `.next/static/css` ⇒ exit 1（不 skip）；恢复 ⇒ exit 0。

## 仍存在的客观边界（非未验证项，已如实标注）

1. **Safari / Firefox 未测**：本 Windows 宿主只有 Edge 与 Chrome（均 Blink）；无 Gecko/WebKit 载体。
   已用两个 Blink 载体 + 软件/硬件两种光栅化覆盖，`backdrop-filter` 均带 `-webkit-` 前缀且有
   `@supports not` 降级，跨引擎风险已被降级兜底。
2. 动态闸门只覆盖 `.tsx` className；`.ts` 常量若未来引入动态类字符串需另行约束（当前 tokens.ts 全为字面量）。
3. 探针断言的是 computedStyle 与截图，非像素级 diff；视觉一致性以截图人工复核为准。

## 回滚

```bash
git revert --no-edit <本轮 commit>
git reset --hard d9c4dd1   # R2
```