# 源码包与提交规范（SUBMISSION PACKAGE）

> 命名规则（大赛提交要求）：**学校 + 队名 + 队长联系方式**。
> 示例：`XX大学_星火队_队长13800000000_源码包.zip`（**提交前替换真实信息，当前模板不伪造**）。

## 1. 包内容清单

| 类型 | 必须包含 | 说明 |
|---|---|---|
| 源码 | `src/`、`public/`（含 ONNX 权重）、配置文件、`package.json`、`pnpm-lock.yaml` | 生产构建与离线运行都需要 |
| 文档 | `README.md`、`启动说明.md`、`docs/COMPETITION_TECHNICAL_WHITEPAPER.md`、`docs/COMPETITION_TECHNICAL_WHITEPAPER.pdf`、`docs/KubeVision_PITCH.pdf`、`docs/EVIDENCE.md`、`THIRD_PARTY_NOTICES.md`、`LICENSE` | 评审材料 |
| 证据 | `docs/evidence/`（图/日志，约数 MB） | 若平台限制大小，可只保留索引与关键图 |
| 规则 | `.gitignore`、`.dockerignore`、`Dockerfile`、`docs/DEPLOYMENT.md` | 部署与复现 |

## 2. 排除清单（必须排除）

```
node_modules/     依赖目录（体积大、平台相关）
.next/            构建产物（可选保留离线包另发）
.git/             版本库
release/          离线 zip（体积大，单独提交）
recording/        录屏 mp4（单独提交/云盘）
.env.local        含 Key/网关配置（绝不能提交）
tmp-*.log / *.tsbuildinfo / .DS_Store
```

## 3. 生成源码包（Windows PowerShell，仓库根目录执行）

```powershell
# 1) 用 git 导出已提交文件（自动排除 .gitignore 的 node_modules/.next/.env.local）
git archive --format=zip -o "..\KubeVision_src.zip" HEAD

# 2) 检查大小与内容（应无 node_modules/.next/.env.local）
Get-Item "..\KubeVision_src.zip" | Select-Object Name, @{n='MB';e={[math]::Round($_.Length/1MB,1)}}
tar -tf "..\KubeVision_src.zip" | Select-String -Pattern 'node_modules|^\.next/|\.env\.local' | Select-Object -First 5

# 3) 重命名为大赛命名（替换占位）
Rename-Item "..\KubeVision_src.zip" "XX大学_星火队_队长13800000000_源码包.zip"

# 4) 记录校验和
Get-FileHash "..\XX大学_星火队_队长13800000000_源码包.zip" -Algorithm SHA256
```

## 4. 提交前检查

- [ ] 包内**不含** `.env.local`、真实 Key、K8s Token；
- [ ] 包内**不含** `node_modules/`、`.next/`、`.git/`（除非另行提供离线包）；
- [ ] 解压后按 `启动说明.md` 能 `pnpm install --frozen-lockfile && pnpm build && pnpm start`；
- [ ] 命名含学校 + 队名 + 队长联系方式（真实信息，提交前替换）；
- [ ] SHA256 与文件大小已记录；
- [ ] README/白皮书/PPT 数字一致（`node scripts/check-docs-consistency.mjs` 通过）。

## 5. 附件（单独提交，不打进源码包）

| 附件 | 命名 | 备注 |
|---|---|---|
| 离线演示包 | `kubevision-demo-<commit>-<time>.zip` | `pnpm package:demo` 生成，含 `.next` |
| **官网提交主视频（5–8 分钟）** | `KubeVision_6min_FINAL_1080p30.mp4` | **5–8 分钟（建议 6:00），≥1080p30 MP4，普通话讲解（含背景+功能+AI亮点）** |
| 现场答辩快闪视频（辅助） | `KubeVision_3min_FINAL_1080p30.mp4` | ≤3:00，1080p30 |
| 60s 无旁白预览版（辅助） | `KubeVision_60s_silent_1080p30.mp4` | 60±2s |
| 白皮书 PDF | `KubeVision_Technical_Whitepaper.pdf` | 由脚本重导，≤30 页 |
| PPT PDF | `KubeVision_Pitch.pdf` | 10–12 页 |