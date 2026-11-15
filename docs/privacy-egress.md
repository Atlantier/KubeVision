# 原始凭证零出域证明（Privacy Egress Report）

> 本报告记录 `2026-11-11T06:46:52.888Z` 的 CDP 出站金丝雀审计快照（历史一次性抓包脚本未保留在精简提交仓；当前脱敏规则回归请运行 `pnpm verify:sanitizer`）。
> 目标：http://127.0.0.1:3000。

## 方法

1. 用 CDP `Network` 域抓取页面全部出站请求（URL / headers / postData，postData 上限 10MB）；
2. 向端侧审计面板注入一条包含 5 类凭证金丝雀的原始日志；
3. 执行端侧脱敏 + 语义分类（全程本地）；
4. 抓取一批集群日志生成审计记录，点击「移交 Copilot」——这是整个流程中唯一可能外发数据的路径；
5. 对全部抓包做金丝雀字符串扫描。

## 金丝雀清单

| # | 金丝雀 | 类型 |
|---|---|---|
| 1 | `AKIAIOSFODNN7EXAMPLE` | AWS AccessKey |
| 2 | `S3cr3t!` | URL 内嵌密码 |
| 3 | `postgres://admin:` | URL 用户名 |
| 4 | `oncall@kubevision.io` | 邮箱 PII |
| 5 | `10.244.3.17` | 内网 IP |
| 6 | `canary-token-9f3a` | Bearer Token |
| 7 | `db.internal` | 内部主机名 |

## 结果

| 指标 | 值 |
|---|---|
| 抓包总数 | 30 |
| /api 请求数 | 3 |
| /api/chat 请求数 | 1 |
| POST 请求数 | 1 |
| 本地审计阶段 /api/chat | 0 |
| 金丝雀命中数 | 0 |

**结论：未观察到任何原始凭证进入出站请求。**

## 外发请求清单（/api/**）

| 方法 | URL | 请求体大小 |
|---|---|---|
| GET | `/api/telemetry?mode=demo&chaos=NONE&since=1793865600000` | — |
| GET | `/api/telemetry?mode=demo&chaos=POD_OOM_SWARM&since=1794379587865` | — |
| POST | `/api/chat` | 1728 B |

## 边界与诚实声明

- 本报告只证明**本次观测到的请求**不含金丝雀；它不能证明未来代码变更不会引入外泄，因此该脚本应进入回归集；
- Header 抓包是请求头快照（CDP 提供），浏览器自动附加的 `cookie` 等头也在扫描范围内；
- 端侧分类若走 WebGPU，模型权重来自远程下载（一次性、非凭证数据），不在本次金丝雀范围内。
