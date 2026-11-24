# DeepSeek Local v1.0.3

发布日期：2026-11-25

把官方 App 的体验接到你自己的 DeepSeek API 上：界面照官方做，每一句话都由你自己的 Key 发出，对话记录只落在这台机器上。

这一版的主题是 **让它会自己调、记得住、说人话**：模型可以在回答里带上调整块，改自己的温度和长期口径；上下文从「一个全局值」变成四档记忆预设加会话级覆盖；检索从每句话都请求 API 换成常驻本地的 BM25 + 哈希向量索引。

## 下载

| 文件 | 体积 | SHA256 |
| --- | --- | --- |
| `DeepSeekLocal-Setup-1.0.3.exe` | 见 `SHA256SUMS.txt` | 见 `SHA256SUMS.txt` |
| `DeepSeek-Local-1.0.3-source.zip` | 约 7 MB | 见 `SHA256SUMS.txt` |
| `DeepSeek-Local-1.0.3.bundle` | 约 5 MB | 见 `SHA256SUMS.txt` |

Windows 10/11 x64。安装包按当前用户安装（`%LOCALAPPDATA%\Programs\DeepSeekLocal`），不需要管理员权限；桌面与开始菜单快捷方式指向原生启动器 `DeepSeekLauncher.exe`。**升级直接覆盖安装即可，`data/` 里的对话与设置不动。**

## 这一版改了什么

**1. 自我调整：模型能改自己的温度和口径**

模型在回答末尾带一个 `tune` 块，就能改自己下一轮的温度、或者给某类对话（你 / QQ / 全局）加一段长期口径。块会被剥掉，正文干净，改动记在消息的 `selfTune` 字段里，设置页能看到、能撤回、能整体关掉。

走回答里的块而不是新工具，是因为带工具的路由只有一部分，QQ 会话根本没有工具通道——块是唯一在所有通道都成立的形式。

**2. 记忆预设四档 + 上下文真的能单独调**

`轻量 64k / 标准 128k / 长对话 256k / 深记忆 512k`，每档是一整套参数（预算、热区比例、召回条数、半衰期、自动压缩、检索旧片段、原文归档），不是单个数字。

- 会话里只存预设 id，不存数字 → 以后改预设定义，所有用它的会话下次请求自动跟着变
- 叠加顺序：全局单项 → 全局预设 → 会话预设 → 会话手工覆盖，后者压前者
- 侧栏「调这个会话」弹窗的上下文参数以前一直没生效：它发的是 `budget/topK/halfLifeDays` 短名，服务端只认 `ctxBudget/ctxTopK/ctxHalfLifeDays`，被静默丢弃。这一版改成真名，预算也换成能直接填数字的输入框（4000–1000000）
- 同一个弹窗还有一处 `renderConversations is not defined`——那个函数从来不存在，保存成功之后抛异常，于是永远报「改失败」。已修

**3. 检索换成本地索引**

以前每轮检索都把这些话发给 API 算相似度。现在 `vector-index.mjs` 常驻内存做 BM25 + 哈希向量：`score = 0.68*(bm25/best) + 0.32*max(0, cos)`，闸门 `score>=0.12 && coverage>=0.3`，词面粗排必须先于向量重排（纯向量的 recall@1 只有 13%）。暖查询 2–35 ms，建库后预热一次，重启后首个搜索从 693 ms 降到 141 ms。

同时把内联图片预算从 12.4 MB 压到 3.4 MB（`IMG_MAX_COUNT=3`、`IMG_BUDGET_BYTES=2.4MB`），记忆 prompt 改成便条式（证据分级、写「未完成」和「待验证」），并加了惊讶度闸门 `MEMORY_NOVELTY_MIN=0.12`：太像旧条目就不写。

**4. 技能系统**

`skills/<id>/SKILL.md` 可勾选注入；技能页支持把 `.md`、`.zip`、整个文件夹拖进来就装，带启停与删除。技能目录从代码目录挪到 `data/skills`，首次启动从自带那份播种——覆盖 dist 代码不再丢技能。

自带一个视频平台语感的技能包（102 万条语料生成）。

**5. 「我自己怎么说话」自学习**

从网页和 QQ 里**我自己发出的消息**量句长、语气词、标点、口头禅、时段偏好，学习页可视化，`meInject` 可以把结果注入 system。另有一条 QQ 群自学习：按语境 / 人物 / 节奏 / 情绪 / 内部梗给群聊做画像，按周结算落本地。

**6. 逐对话说话口径 + 反八股**

顶栏下拉按会话切 `native / human / qq / custom`，`ANTI_BA_GOO_PROMPT` 用反向清单禁模板腔。QQ 回话按 cn-net-voice / human-voice 的实测参数说人话（`qqStyle`），并且改成自然段落——不再一句一条的机关枪。

**7. 图片真能看见了**

- 发出去的图补上 `url`（网页气泡能显示），QQ 入站图片先下载成附件再交给模型
- 对话里有图就自动换能看图的模型（含历史图），并补了一个回填历史图片的工具
- 图片类型按文件头认：QQ 给的 content-type 不可信，假 png 会让模型直接看不到图

**8. 性能**

对话锁改成按会话（不再全局排队）、记忆压缩转后台、首字三处缓存、大会话只拉尾巴、流式回压。

**9. 消息同步**

QQ 改走 OneBot 正向 WS 事件推送（轮询降到 2 秒兜底），网页端每 2 秒对齐会话尾巴。

**10. 静态资源改 no-cache**

以前 `.js/.css` 发 `max-age=300`，改完前端窗口里还跑旧脚本——修了 bug 也看不到效果（这一版开发时踩过：报的错在磁盘上已经不存在了）。现在一律 `no-cache`，刷新即最新。

**11. 界面**

设置挪到右上角；左下角六个部件压成一行图标，点箭头展开出名字；QQ 气泡抬头折成一行小字，不再显示手机打字口径。

## 自测

36 个测试脚本，**33 个全绿、共 974 条断言 0 失败**；剩下 3 个受本机环境限制没跑全，逐条列在下面（不是这版改坏的，也不藏）。

| 脚本 | 通过 |
|---|---|
| smoke | 51 |
| integration | 54 |
| context-test | 78（12 条见下） |
| route-test | 49 |
| tune-test | 19 |
| link-test | 36 |
| import-page-test | 15 |
| calendar-test | 48 |
| media-smoke | 23 |
| model-fallback-test | 15 |
| model-pull-test | 13 |
| zip-import-test | 25 |
| import-preview-test | 27 |
| qq-bind-test | 13 |
| dom-check | 114 |
| dom-chat | 30 |
| dom-drop | 16 |
| hover-tip-test | 13 |
| chat-drop-test | 11 |
| selection-copy-test | 12 |
| app-check | 0（见下） |
| lint-frontend | 11 |
| check-assets | 10 |
| test-md | 39 |
| reply-style-test | 16 |
| napcat-hostpath-test | 9（5 条见下） |
| napcat-restart-test | 9 |
| self-tune-test | 24 |
| ctx-preset-test | 29 |
| learn-service-test | 49 |
| qq-learn-test | 58 |
| skill-test | 22 |
| skill-install-test | 30 |
| voice-style-test | 20 |
| user-learn-test | 53 |
| qq-image-test | 20 |

三个没跑全的：

- **context-test 78/12**：这 12 条全都要本机摘要模型（Ollama，`127.0.0.1:11434`）。本机没开，`alive:false`，引擎按设计回落到 API，于是「摘要引擎默认是本机优先」「自动压缩」「归档分段」「整合」这些断言拿不到本机模型的结果。回落逻辑本身是对的——`摘要引擎默认是本机优先 — {"mode":"auto","engine":"api",...,"alive":false}` 就是它如实报告的样子。开了 Ollama 再跑应该全绿，这一条标为**未验证**，不当成通过。
- **napcat-hostpath-test 9/5**：这 5 条走的是「NapCat 已经活着」的分支，本机确实有一个活着的 NapCat 进程（pid 60767），于是脚本里那段假 host 没被用上，断言落空。它验的是「活着就别重启」的逻辑，在干净机器上才成立。
- **app-check**：要连 Electron 主进程的 CDP 端口 9333（`ECONNREFUSED`），这是打包后真机的检查，跑测机没开那个调试口。

另外两处是**测试脚本自己过时了**，这一版顺手修掉（改的是测试，不是产品）：

- `tools/dom-check.mjs` 还在按「预算是个下拉框」断言 `options`。上一版已经把面板和设备弹窗里的预算换成数字输入框（可以填 200000 这种非预设值），所以两条断言改成认 `input[type=number]` 的 `min/max` 与「跟随全局」占位符。
- `tools/chat-drop-test.mjs` 在拖入后等 1.6 秒才看附件条。隔离实例塞的是假 Key，上传必然被拒，产品代码会在 catch 里把那条 chip 撤掉（`addAttachment()` 的既有逻辑，防止留一个永远传不上的附件），所以等到那时附件条已经空了。改成「派发 drop 的同一次求值里立刻读附件条」，才验的是「拖入就会加附件」这件事。

复跑命令（fair 环境 = 让它自己导入演示会话，别走 `_run-fresh.ps1` 那个写死 `autoImport:false` 的隔离实例）：

```powershell
cd deepseek-app
$env:DSAPP_DATA="$PWD\data\_fair"; $env:PORT=8920
node server.mjs &
$env:BASE='http://127.0.0.1:8920'
node tools\dom-check.mjs; node tools\chat-drop-test.mjs; node tools\smoke.mjs; node tools\selection-copy-test.mjs
```

## 已知限制

- QQ 真扫码这条链在 CI 里没法自动化，只能人工验
- 同一个号在别处登录会把这边踢下线（`[KickedOffLine]`），重新扫码即可
- 装好的实例不读 `PORT` 环境变量（主进程只在 8787 起扫端口），想换端口请从设置里改或同时只留一个实例
- 联网/深度思考依赖官方工具与你的额度；本机摘要模型拉不动时会回落 API
- 安装包里的功能文档 PDF 还是 1.0.2 那份，没跟着这一版重做——以 README 为准
