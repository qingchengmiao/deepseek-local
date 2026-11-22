# DeepSeek Local v1.0.1

发布日期：2026-11-22

把官方 App 的体验接到你自己的 DeepSeek API 上：界面照官方做，每一句话都由你自己的 Key 发出，对话记录只落在这台机器上。

## 下载

| 文件 | 体积 | SHA256 |
| --- | --- | --- |
| `DeepSeekLocal-Setup-1.0.1.exe` | 105.11 MB（110,219,147 字节） | `748532ee0c80055edbf9e37220372a0c5f8a59dac0fc457ce90e19e114bca73f` |
| `DeepSeek-Local-1.0.1-source.zip` | 4.40 MB（4,615,824 字节） | `d5b1bb5485d8d4daaddf3f1c7b3fa1c7f0f4a5f31c4ba7d7d011adbc1fe81f45` |

Windows 10/11 x64。安装包按当前用户安装（`%LOCALAPPDATA%\Programs\DeepSeekLocal`），不需要管理员权限；桌面与开始菜单快捷方式指向原生启动器 `DeepSeekLauncher.exe`。

## 这一版改了什么

**1. 拖入文件自识别 + 导入独立页**

- 底栏新增「导入」整页：文件拖进来先**辨认**（DeepSeek 官方导出包 / 对话 JSON 整包 / 任意资料压缩包 / 单个文本），告诉你属于哪一类、准备生成几个会话，你点「开始导入」才落库。
- 对话页拖入 = 加到这条消息（图片、PDF、Word、文本、音视频），不再误触发导入；拖 `.zip` 会提示并转到导入页。
- 限制：单包 ≤ 200 MB、文本类最多 60 个文件、单文件取前 6000 字、单会话累计 4 万字；二进制不会硬塞给模型。

**2. 摘要模型自动拉取（国内镜像优先）**

- 本机 ollama 在线但没有可用小模型时自动拉：先试官方源 `qwen2.5:1.5b-instruct`（失败退 `0.5b`），不行依次换魔搭 ModelScope、hf-mirror.com 下 GGUF → 生成 Modelfile → `ollama create`。
- 进度、来源、日志在设置页与 `GET /api/context/model-pull` 可见；同一模型只拉一次；全部失败会明确报错并退回 API，不阻塞对话。

**3. 演示沙盒**

- `启动演示.cmd` 起一个**独立实例**（`demo-data\` + 端口 8899）：不读你的 Key、没有真实对话，内含三条演示会话，可重复生成不翻倍。`停止演示.cmd` 收掉。

**4. 交互细节**

- 悬停提示改为自绘圆角气泡（不再有系统直角方块，300ms 延迟，深浅色各一套）。
- 输入框内部蓝色焦点框隐形，只保留整块输入区的一层淡光晕。
- 选中正文自动浮出「复制」小条；右键菜单换成中文「剪切 / 复制 / 粘贴 / 全选」，按可用状态灰显——都不需要按 Ctrl+C/V。
- 二维码卡片会说这张码多旧；「重启 NapCat 出新码」可真正逼出新码。
- QQ 通道可选「回话用哪个会话」，换绑即接着该会话的历史继续说。
- 混合模式（Flash 出大纲 → Pro 写正文）修复了 `latest_reminder` 两条上游约束导致的 400。

**5. 稳定性**

- Electron 侧四处自愈：启动失败退避重试、失败页自带重试并每 3 秒自动重试、渲染进程崩溃自动重载、5 秒探活看门狗在服务恢复后自动恢复界面。
- 启动器修复「服务已在跑却不把窗口拉出来」；端口被占时自动顺延扫描。

**6. 文档**

- `README.md` 增「下载与安装」「演示沙盒」「摘要模型自动拉取」等节。
- `docs/DeepSeek-Local-功能介绍.pdf`（11 页）与 `docs/DeepSeek-Local-功能演示.pdf`。

## 发布前自测（隔离实例，无真实 Key）

| 套件 | 结果 |
| --- | --- |
| smoke | 51 / 0 |
| integration | 54 / 0 |
| context-test | 96 / 1 |
| dom-check | 114 / 0 |
| dom-chat | 30 / 0 |
| test-md | 39 / 0 |
| calendar-test | 48 / 0 |
| media-smoke | 23 / 0 |
| qq-test / qq-bind-test | 35 / 0、15 / 0 |
| model-fallback-test / model-pull-test | 15 / 0、13 / 0 |
| zip-import-test / import-preview-test / import-page-test | 24 / 0、27 / 0、15 / 0 |
| selection-copy-test / hover-tip-test | 12 / 0、13 / 0 |
| napcat-restart-test / qr-refresh-test | 全部通过 |
| lint-frontend / check-assets | 通过 |

`context-test` 的 1 项失败是**测试自身的路径假设**：它在脚本里写死了仓库 `data/` 去读归档 JSON，而本次跑的是隔离实例（`data\\_relchk`），归档写在别处——同一段其余断言（条数、分段、引擎、时间）全绿，产品侧无异常。

## 已知限制

- **QQ 的真扫码登录没在我这端到端验过**：需要你先启动 NapCat 并扫码。接口、二维码刷新、重启出新码都已实现并单测过。
- 联网搜索与读链接依赖 DeepSeek 官方工具与你的额度；关掉联网就是纯本地推理。
- 本地压缩摘要优先用本机 Ollama，没装/失败会自动回落到 API。
- 演示沙盒里不配 Key，只演示界面与本地能力，不发真实请求。
- 镜像下载地址取决于当天网络与仓库结构；拉不到会明确报 `官方源和国内镜像都没拉成（检查网络或手动 ollama pull）`。

## 数据在哪

`%LOCALAPPDATA%\DeepSeekLocal\data\`：`conversations/*.json`（会话）、`archive/`（压缩前原文）、`media/`（图片与导入附件）、`settings.json`（Key 与偏好）。升级/重装不覆盖，卸载不删；想彻底清空就退出应用后删掉这个目录。
