# R2 · 样式契约闸门「能红能绿」演示（真实执行记录）

> 目的：证明 `check-style-contract.mjs` 不是"常绿摆设"——注入违约即红（exit 1，阻断 verify），
> 恢复即绿（exit 0）。两类闸门各演示一次。所有输出为真实命令结果。

## 演示 A · 坏 CSS 变量闸门（var(--)）

**步骤**：把 `.kv-panel` 的 `backdrop-filter: blur(var(--kv-blur-panel))` 改回 `blur(var(--))`。

RED（注入后）：
```text
$ node scripts/check-style-contract.mjs
  ✗ globals.css 无坏变量/空选择器  (--:×0 var(--)×1 空选择器×0)
  ✗ 1 项违约
exit code: 1
```

GREEN（恢复后）：
```text
$ node scripts/check-style-contract.mjs
  ✓ 透明度类全量生成比对  (源码 218 类 / 已生成 218 / 缺失 0)
  ✓ 样式契约全部通过
exit code: 0
```

## 演示 B · 缺失类闸门（全量透明度比对，无白名单）

**步骤**：在 `DemoDebugPanel` 根 className 注入 `bg-notacolor-500/50`
（`/50` 是合法刻度 → 静态检查不报；但 `notacolor` 不是真实颜色 → Tailwind 不生成）。
重新 `pnpm build` 后比对。

RED（注入 + 重新构建后）：
```text
$ node scripts/check-style-contract.mjs
  ✓ 无非刻度裸透明度  (0 处)              ← 静态检查通过（/50 合法）
  ✗ 透明度类全量生成比对  (源码 219 类 / 已生成 218 / 缺失 1: bg-notacolor-500/50)
  缺失清单:
    ✗ bg-notacolor-500/50
  ✗ 1 项违约
exit code: 1
```

GREEN（移除 + 重新构建后）：
```text
$ node scripts/check-style-contract.mjs
  ✓ 透明度类全量生成比对  (源码 218 类 / 已生成 218 / 缺失 0)
  ✓ 样式契约全部通过
exit code: 0
```

**结论**：缺失类闸门能抓到"静态检查放行、但生产 CSS 未生成"的静默失效类，
且缺失即 exit 1 阻断 verify；没有任何白名单掩盖。

## 缺失类清单前后对比

| 阶段 | 源码类总数 | 已生成 | 缺失 | exit |
|---|---:|---:|---|---:|
| 基线（R2 完成） | 218 | 218 | 0 | 0 |
| 注入 `bg-notacolor-500/50` | 219 | 218 | 1（bg-notacolor-500/50） | 1 |
| 移除后 | 218 | 218 | 0 | 0 |

> 注：演示用的临时注入均已还原，`src/` 与 HEAD 内容一致（`git diff src/` 为空）。