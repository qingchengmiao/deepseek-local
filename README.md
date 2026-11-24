# DeepSeek 对话（本地版）

把 DeepSeek 手机 App 的用法搬到你自己的电脑上，后端接的是 **DeepSeek 官方 API**（你自己的 Key），还能把 App 里导出的历史对话直接导进来接着聊。

服务端零依赖（只用 Node 自带模块），界面是原生 HTML/CSS/JS；桌面壳用 Electron 打包成 `DeepSeek.exe`，数据全在本机。

---

## 下载与安装（发布版 v1.0.2）

不想自己编译的话，直接用安装包：

| 文件 | 说明 |
| --- | --- |
| `DeepSeekLocal-Setup-1.0.2.exe` | 安装包（约 105 MB，Windows 10/11 x64，中文向导，按当前用户装、不需要管理员） |
| `DeepSeek-Local-1.0.2-source.zip` | 源码包（不含 `data/`、`dist/`、`node_modules/`，可自行构建） |
| `DeepSeek-Local-功能介绍.pdf` / `DeepSeek-Local-功能演示.pdf` | 图文说明（功能介绍、演示沙盒、摘要模型自动拉取） |

安装：双击 `DeepSeekLocal-Setup-1.0.2.exe` → 一路「下一步」。默认装到 `%LOCALAPPDATA%\Programs\DeepSeekLocal`，桌面和开始菜单生成 **DeepSeek** 快捷方式，指向原生启动器 `DeepSeekLauncher.exe`（托盘、单实例、自动拉起本地服务、内存回收）。

- 用户数据独立放在 `%LOCALAPPDATA%\DeepSeekLocal\data`（`--data-dir` 可改），升级/重装**不会覆盖**你的对话；卸载也不会删数据。
- 第一次打开要做两件事：左下角「设置」填 DeepSeek API Key（只存本机 `data/settings.json`）；需要联网/深度思考就在输入框下面的胶囊里打开。
- 校验值见仓库 Releases 页面或 `RELEASE_NOTES.md`（SHA256）。

自己构建：`npm i` 装 Electron → 见下面「打包成安装包」一节（Electron packager + Inno Setup）。

---

## 怎么跑

### 装好就直接用（双击）

桌面和开始菜单各有一个 **DeepSeek** 快捷方式，双击就开——它指向打包好的 `dist\DeepSeek-win32-x64\DeepSeek.exe`：

- 窗口是自己的（Electron），不是浏览器标签页：有任务栏图标、单实例（再双击只把已有窗口提到前面）
- 本地服务跑在应用进程里，不用另外开终端；关窗口 = 服务一起关
- 数据在 `dist\DeepSeek-win32-x64\data`（这里做成了指向仓库 `data/` 的 junction，开发版和打包版共用同一份会话）

想重新建快捷方式：`powershell -ExecutionPolicy Bypass -File tools\install-shortcut.ps1`
（脚本会自动优先用打包好的 exe；没打包过就退回 `启动应用.vbs` 那套「node 服务 + Edge 独立窗口」。）

**这台机器上有一个坑：exe 必须带 `--no-sandbox` 才起得来。** 不带的话 Chromium 初始化沙箱时进程会**静默退出**（没窗口、没报错，表现就是「双击没反应」）。所以桌面/开始菜单快捷方式的参数里、`启动应用.vbs` 里都写了 `--no-sandbox`；应用只加载 `127.0.0.1` 的本地页面、外部导航一律拦掉，代价可控。想恢复沙箱：把快捷方式参数去掉，并在启动前设 `DSAPP_SANDBOX=1`。

启动过程有追踪日志：`data/app-start.log`（每次启动追加 `boot / singleInstanceLock / ready / findRunning / serverReady / windowCreated / windowShown`）。**再遇到双击没反应，先看这个文件**——停在哪一行就说明卡在哪一步；如果连 `boot` 都没有，那就是 exe 根本没进到 JS（多半是参数或沙箱问题）。

### 演示沙盒（不碰你自己的对话）

想拿一份干净数据试功能、截图、录屏，双击 **`启动演示.cmd`**：

- 它是**另一个实例**：数据目录 `demo-data\`、端口 **8899**，跟正常那套（`data\` + 8787）完全隔开；
- 首次启动会关掉「自动导入」（免得把工作区里你导出的真会话拷进演示数据），并调 `tools\seed-demo.mjs` 灌三条演示会话：**一次问十件事**（多问题 + 代码块）、**长对话如何不丢上下文**（6 段重复背景，用来看分档压缩）、**拿来就能用的几件小事**；
- 只起服务、在浏览器里打开 `http://127.0.0.1:8899`；想连 Electron 窗口就用 `set DSAPP_DATA=…\demo-data` + `set PORT=8899` 再起 `dist\DeepSeek-win32-x64\DeepSeek.exe`；
- 停掉用 **`停止演示.cmd`**（只杀 8899 上那个进程）。演示数据留在 `demo-data\` 里，下次接着用；想重来就把它删掉。

重复跑 `node tools\seed-demo.mjs http://127.0.0.1:8899` 不会翻倍——它会先把上次灌的「演示 · …」会话删掉再灌。

### 开发时改代码

```
npm start          # 用 Electron 起整个应用（改前端刷新即可生效）
npm run serve      # 只起服务，浏览器开 http://127.0.0.1:8787
npm run web        # 起服务并自动开系统浏览器
npm run desktop    # 起服务 + Edge/Chrome 独立窗口（旧的桌面方式，没装 Electron 时用）
```

### 重新打包 exe

```
$env:ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'
node node_modules\@electron\packager\bin\electron-packager.mjs . DeepSeek `
  --platform=win32 --arch=x64 --icon=assets/app.ico --out=dist --overwrite `
  --app-version=1.0.2 --electron-version=45.4.1 --prune=true --no-asar `
  --ignore="^/dist" --ignore="^/data" --ignore="^/node_modules"
```

打完之后要把数据目录接回去（否则新 exe 会看成空数据）：

```
New-Item -ItemType Junction -Path dist\DeepSeek-win32-x64\data -Target (Resolve-Path .\data)
```

第一次进来先点左下角 **设置**，填 API Key（在 https://platform.deepseek.com/api_keys 建），点「测试连接」看到绿色再用。Key 只存在本机数据目录的 `settings.json`，接口回给前端的永远是掩码。

默认地址 `http://127.0.0.1:8787`，端口被占用会自动往后找，实际地址写在数据目录的 `server.json` 里。

联网搜索、看图、读文档、语音输入、朗读用的都是同一把 Key，但**联网/看图/文档要求模型是 `deepseek-flash`**（`deepseek-v4-pro` 是纯文本，选它时这些按钮会灰掉）。

视频/音频解析需要本机有 **ffmpeg**（`ffmpeg.exe` 与 `ffprobe.exe`）。服务端会按这个顺序找：设置里的 `ffmpegPath` → 环境变量 `FFMPEG_PATH`/`FFPROBE_PATH` → `D:\ffmpeg-9.0-full_build\bin\` → `/usr/bin` → PATH。找不到时上传视频会直接报「找不到 ffmpeg」，不会静默失败。

---

## 跟 App 对得上的地方

用的是 DeepSeek 2026-11 发布的「全家桶应用 API」，所以 App 上那些能力这里基本都能对上：

| App 里有的 | 这里 |
| --- | --- |
| 会话列表、置顶、重命名、删除 | 有 |
| 全文搜索（点结果直接跳到那条消息） | 有 |
| 联网搜索 / 深度思考搜索 | 有（输入框上那个「联网」开关；思考开着就是深度思考搜索） |
| 阅读链接（把消息里的网址读进上下文） | 有（贴 URL 自动读；API 读不到时本机抓 HTML / 内嵌 Chromium 再读一次） |
| 深度思考过程，可折叠 | 有，显示「已深度思考（用时 N 秒）」，可调强度 低/高/最高 |
| 联网过程卡片 + 正文引用角标 + 参考来源 | 有（搜了哪些词、开了哪些页面、来源标题与站点都能点开） |
| 上传图片（看图提问） | 有（图片按钮或直接粘贴） |
| 上传文档（PDF/Word/Excel/PPT/EPUB 等） | 有（走 Files API 解析，TXT/MD/CSV/JSON/代码类不计费） |
| 上传视频 / 音频 | 有（本机 ffmpeg 抽音轨→切段→语音识别，视频再抽关键帧一起发给模型） |
| 语音输入 | 有（录完自动转文字填进输入框） |
| 朗读回答 | 有（每条回答上的喇叭，两种音色可选） |
| 自动生成会话标题 | 有（每轮由模型起名，可关） |
| 内容安全审核 | 有（关/低/高，对外提供服务时务必开） |
| 继续生成（接着说完） | 有（回答末尾的「继续」） |
| Markdown、公式、代码高亮 | 有（KaTeX + highlight.js，离线打包） |
| 复制、编辑重发、重新生成、删除消息 | 有 |
| 从某条消息分叉出新会话 | 有 |
| 模型切换 | 有（deepseek-flash 支持图片与联网；deepseek-v4-pro 纯文本、推理更强） |
| 深色 / 浅色主题 | 有（还能跟随系统） |
| 导入 App 导出的对话记录 | 有，拖文件或用「导入」 |
| 导出会话为 Markdown / JSON | 有 |
| 手机端布局 | 窗口窄于 860px 自动变抽屉式 |
| 长对话自动压缩 + 记忆摘要 | 有（顶部徽标看占用，`⋯`→「上下文与记忆」看摘要与召回） |
| 分档压缩：占用每涨 33% 压一档，每次记概要 + 关键词 | 有（面板里列「压缩记录」，每段可「展开」原文） |
| 占用过 50% 后按时间权重概括成长期记忆、老段遗忘 | 有（超半衰期的分段只留关键词，原文仍在归档里） |
| 关键词提示 + 逐步恢复（展开第 N 条） | 有（低相关度只给索引卡，说一句「展开第 2 条」就把原文取回来） |
| 旧对话按时间降权、按需召回 | 有（本地索引 + 时间衰减，见下面那节） |
| 自动路由：对话走 V4 Pro、逻辑思考走 V4.1 Flash、混合两遍（也可用二分树开关强制） | 有（模型菜单选「自动」，见下面那节） |

**App 有但 API 没有的**：账号与云同步、推送通知、离线缓存、App 内购买。这里一律不做假开关——界面上能点的都是真接 API 的。

**另外这里比 App 多的**：历史对话全在你本机（`data/conversations/`），可以导出成 Markdown，也可以直接用编辑器打开看。


---

## 上下文、记忆与检索（长对话怎么不跑偏）

模型只有有限的上下文窗口；这里不是把整段历史一股脑塞进去，而是分六层：

1. **热区**：从最后一条往前累计到「预算 × 热区比例」（默认 2.4 万 token 的 60%），这段原样发给模型。
2. **分档概要**：占用每涨 33%（`ctxStepRatio`）压一档，把新露出来的老消息压成一段结构化摘要（事实 / 决定与理由 / 偏好与要求 / 未完成），并记一条「压缩记录」：第几档、哪几条、压的时候占用多少、多少 token、用了哪个引擎、关键词、一句话提要、原文文件名。同一档不会重复压。
3. **长期记忆（时间加权 + 遗忘）**：占用（按历史总量算，不受压缩影响）过 50%（`ctxForgetRatio`）时，把所有分段概要合并成一段「长期记忆」，并按时间权重决定哪几段该忘——超过半衰期的分段标记为已遗忘，只留关键词，正文从记忆里丢掉（原文还在归档里，随时能展开回来）。
4. **原文归档**：压缩之前，被压掉的那一段原文先另存成 `data/archive/<会话id>/<起始>-<结束>.json`（`{convId,title,from,to,savedAt,engine,messages:[…]}`），同时写 `index.json`（分段 + 可选稠密向量）。摘要丢掉的细节还能翻原文，归档片段也能被召回；清空记忆不会删归档文件。
5. **检索 + 渐进激活**：老消息另建本地词面索引，按当前提问做 BM25 召回。命中分两级——相关度 ≥ `ctxActivateScore`（默认 0.2）的**直接给原文片段**；低于阈值的只给一张「记忆索引卡」（`#k 第 a–b 条 · 相关度 · 关键词 · 一句话提要`），并在系统提示里告诉模型「原文没展开，需要细节就让用户回一句『展开第 k 条』」。用户在对话里说「展开第 2 条 / 恢复记忆 2」时，系统把那段原文（优先历史、没有就翻归档 JSON）注进上下文；面板里每条压缩记录也有「展开」按钮。
6. **时间衰减**：召回排序乘一个半衰期权重（默认 30 天减半），老内容不会挤掉新内容；热区里超过半衰期的消息正文也会被压短，末尾留一行「较早的内容已按时间降权压缩」。

**要说实话的地方**：

- DeepSeek 没有 embeddings 接口（`/v1/embeddings` 是 404），所以历史索引是本机算的**词面**索引（BM25 + 词表维度），**认词，不认近义词**——查「心率」找得到「心率八次」，查「脉搏」不一定。
- 语义那部分靠本机 ollama：`ctxEmbedModel: auto` 时会给**归档区间**算一条 `nomic-embed-text` 向量（768 维），检索时和历史 BM25 混分（`max(bm25, bm25*0.6 + 余弦*0.4)`）。归档按区间存一条向量、不按段存，否则几千段 × 768 维会把 JSON 撑爆。没有 ollama 就自动退化成纯 BM25。
- 归档检索目前和历史检索覆盖同一段旧消息（历史索引也索引到了），所以命中通常会由历史那份先出；归档真正的价值是**原文备份**（摘要丢细节时能翻）和以后真裁剪历史时的兜底。
- 关键词是从消息里按词频 + 跨消息出现次数抽的，纯填充文本抽出来的会是「备份、存储、导出」这类词，不一定是人觉得重要的那个；索引卡只是线索，模型真要细节仍然靠「展开第 k 条」。

顶部那个徽标显示当前占用（超过预算会变橙色写「超预算」）。点开「上下文与记忆」可以：看记忆摘要、看压缩到第几档/概括到第几级、看摘要引擎与归档占用、看每一条压缩记录（含已遗忘的）并「展开」原文、拿任意查询试召回（会显示相关度、时间权重、是否来自归档、是直给还是索引卡）、手动触发一次压缩、清空记忆。设置里能调预算、热区比例、半衰期、召回条数、相关度阈值、分档步进（默认 33%）、遗忘阈值（默认 50%）、渐进激活开关与激活阈值、摘要用哪个模型（自动/只用本机/只用 API）、本机模型与向量模型、要不要归档原文，还有一个「测一下」直接问本机模型能不能写摘要。

关掉压缩会退化成「只用热区 + 检索」，关掉检索就只用热区 + 记忆。

### 摘要模型没了？会自动从国内镜像拉一个

压缩摘要优先交给本机 ollama 的小模型写（不走网络、不花 API 钱）。以前本机没装模型就只能退回 API，现在加了一条自愈路径：

- 触发：设置里「缺模型时自动拉一个（国内镜像优先）」（`ctxAutoPull`，默认开）。任何一次要写摘要时发现本机 ollama 在线但**没有可用对话模型**，就后台开始拉；面板上「现在拉一个」也能手动触发（`POST /api/context/model-pull`）。
- 顺序：先按目标试官方源 `ollama pull`（`qwen2.5:1.5b-instruct`，不行退 `qwen2.5:0.5b-instruct`）；官方源拉不动，就依次换**国内镜像**：
  - 魔搭 ModelScope：`https://modelscope.cn/models/<repo>/resolve/master/<file>`
  - HF 镜像 hf-mirror.com：`https://hf-mirror.com/<repo>/resolve/main/<file>`
  下到 `data/models/*.gguf`（先写 `.part` 再改名，按 2 MB 一步记进度），再生成 Modelfile（`num_ctx 8192`、`temperature 0.3`、Qwen ChatML 模板）用 `ollama create` 装成一个正常 ollama 模型。
- 只用一次：同一个模型装过就复用，不重复下载；`GET /api/context/model-pull` 能看进度、来源、日志（最近 20 行），设置页那块状态会自己轮询刷新。
- 可调：环境变量 `DSAPP_OLLAMA_CLI`（指定 ollama 可执行文件）、`DSAPP_PULL_MIRRORS`（JSON 数组换镜像，测试就是这么注入假镜像的）。
- 兜底：官方源和国内镜像都失败就写清原因（`官方源和国内镜像都没拉成（检查网络或手动 ollama pull）`），摘要照旧退回 API，不阻塞对话。

### 每个会话一套上下文参数（预算最多顶到 1M）

全局设置里那份是**默认值**；单个会话可以有自己的：

- 面板「上下文与记忆」中部有「本会话上下文参数」：预算（跟随全局 / 24k / 64k / 128k / 256k / 512k / **1M**）、热区比例、召回条数、半衰期，以及自动压缩、检索旧片段两个开关。
- 点「保存到本会话」写进 `conv.ctx`（只存改过的键），之后这个会话组装上下文、压缩、召回都用这份；点「恢复跟随全局」删掉覆盖。
- 面板顶部那行会写「（这个会话单独设了）」还是「（现在跟随全局）」，`GET /api/conversations/:id/context` 里也有 `ctx: { followGlobal, overrides, budgetMax }`。
- **1M 是 V4.1 Flash 的窗口上限**（`CTX_BUDGET_MAX`），原来全局上限卡在 40 万，现在放开了。注意：窗口 1M ≠ 应该用 1M——预算越大注意力越散，默认仍是 2.4 万。

### 整合记忆（手动把分段记忆压成一段长期）

面板底部「整合记忆」调 `POST /api/conversations/:id/context/consolidate`：把当前所有分段概要按时间权重合成一段长期记忆，超过半衰期的段只留关键词（原文仍在归档里，能展开回来），返回 `{before, after, forgotten, segments, engine}`，面板会 toast 提示省了多少 token。

- 还没压过档的会话会回 400 `NO_RECORDS`（「先压一次再整合」）；只有一段记忆时会回 `skipped: true`，不算失败。
- 它和「占用过 50% 自动做的那次概括」是同一个函数（`consolidateMemory`），手动按钮只是不必等占用涨上去。

装 ollama 之后建议拉个小模型（本机已有 qwen3.5:4b 也能用）：

```powershell
ollama pull qwen2.5:1.5b-instruct   # 更快，摘要这种活够用
ollama pull nomic-embed-text        # 想要语义混排在设置里把向量模型设成 auto
```

---

## 读链接：先靠 API，读不到再用本机

消息里有网址时，首选仍然是 API 那边的 `deepseek_read_url` 工具——它是服务端在读，正文干净、能带引用，模型自己决定读哪一段。

但有些站它读不到（反爬、必须登录、纯 JS 渲染），所以本机补两级兜底（`fetchlink.mjs`）：

1. **直接抓 HTML**：带浏览器 UA 请求，处理 charset（含 gb18030），优先 `<article>` / `<main>`，剥掉脚本、样式、导航、页脚，实体还原，最后得到纯文本。零依赖，通常几百毫秒。
2. **内嵌 Chromium**：HTTP 只拿到一点点（纯 JS 站点）或者干脆失败时，用应用自带的 Chromium 开一个隐藏窗口把页面真的渲染一遍，等脚本跑完再取 `innerText`。只有桌面版有这一级；在浏览器里打开、或用 `node server.mjs` 跑服务时自动跳过，不会报错。

读到的东西不额外花钱：正文截前 2500 字，作为一段 system 块插在你这条消息之前，明确标了「本机预读」「HTTP 抓取 / 内嵌内核」和原链接；模型仍然可以再调一次 API 工具去读更完整或更权威的版本。读不到就不假装读到——失败原因会以 warning 抛出来，并照旧交给 API 工具。

设置里三档：**自动**（API 工具 + 本机预读，默认）、**只用 API 工具**、**只用本机抓**（不发工具声明，适合模型不支持 tools 或想省工具费）。另有「本机预读网页」开关，只关掉预读时仍然保留 API 工具。

---

## 自动路由：一条消息该由谁写

模型菜单里选「自动（按内容路由）」后，每条消息发出去之前先判一次意图，再决定用哪个模型、要不要思考：

| 判定 | 走谁 | 怎么判 |
|---|---|---|
| 对话 | V4 Pro | 默认档：闲聊、问事、接着聊 |
| 逻辑思考 | V4.1 Flash（带思考） | 命中代码 / 报错 / 算法 / 推导 / 计算 / 为什么 / 排查 / 对比 这类词；或者你手动打开了深度思考 |
| 混合 | Flash → Pro（两次） | 要成篇的东西（周报、方案、报告、提纲、文案、剧本…）且超过 12 个字 |
| 看附件 | V4.1 Flash | 这条消息带图片 / 文档 / 音视频——Pro 是纯文本，看不了 |

「混合」是两遍：先让 V4.1 Flash 写一份 3–8 条的大纲（非流式、不开思考、≤800 token），把大纲作为 system 块插在这条消息之前，再让 V4 Pro 按大纲把正文写完整。第二遍的提示里明确要求「展开每一节、不要提大纲和草稿」。大纲这一遍失败不会让整条消息失败——降级成直接让 Pro 写，并用 warning 说清楚。

回答上方有一枚小标签写着这次的判定（`自动路由 · 混合 · V4 Pro · Flash 大纲 236 字`），关掉页面也在——路由结果存在消息的 `route` 字段里。

设置里能改每一档具体用哪个模型（对话 / 逻辑思考 / 混合出大纲 / 混合写正文四项），也能整体关掉「自动路由」。手动在模型菜单里选了具体模型的会话不受影响——只有选「自动」时才路由。

调试用：`POST /api/route/test {text, thinking, attachments, mode}` 只跑判断、不发请求，返回 `{kind, model, reason, draftModel}`。

### 混合模式开关（输入框里的二分树按钮）

自动路由里那档「混合」是靠关键词猜的（周报、方案、提纲…）。不想让它猜，就点输入框里的**二分树按钮**：从下一条消息起，不管内容是什么，一律走两遍——

1. V4.1 Flash 先写一份大纲（非流式、不开思考、≤800 token，不给你看）；
2. V4 Pro 按大纲把正文写完整（流式，标着「混合模式 · V4 Pro · Flash 大纲 N 字」）。

几个边界：

- 它**比自动路由更硬**：开关开着就接管，不受「自动路由」总开关影响，也不过 `HYBRID_HINTS`；关掉后立刻回到原来的判定。
- 开着混合时「深度思考」会变灰——第一遍不带思考，那是刻意的。
- **带附件的消息开不了**：Pro 是纯文本，看不了图；这时会提示先移除附件。真带着附件发（比如从别处切过来），服务端降级成「看附件」那一档，不会报错。
- 手动在模型菜单里选了具体模型也照样生效——开关是你按下的，优先级高于「模型菜单」。
- 服务端开关是 `hybridMode`（默认 `false`），设置页「自动路由」下面也有同一枚复选框。请求体用 `hybrid: true` 单条强制，`POST /api/route/test {hybrid:true}` 可以只验判断。

### 音视频两段式（带视频/音频的那个档）

「看附件」原来是一遍过：把转写和抽帧一起塞给 V4.1 Flash，让它又看又写。现在音视频单独一档，也是两遍——

1. **V4.1 Flash 先扒要点**（非流式、不开思考、≤900 token）：看转写文字 + 那 6 帧画面，输出「整体是什么 / 按时间的关键点 / 硬信息（数字、名字、地点、结论、待办）」，只写清单不成段，中文 500 字以内。
2. **V4 Pro 按要点写正文**（流式，标着「音视频 · V4 Pro · Flash 要点 N 字」）。第二遍会把图片块全部剥掉——Pro 是纯文本模型，留着 `image_url` 会 400。

几个边界：

- 只对**视频/音频**附件生效（`kind === 'video' | 'audio'`）；图片和文档仍走原来的一遍「看附件」。
- 设置页「音视频两段式解析」是开关（`mediaTwoStage`，默认开）。关掉就回到一遍过。省的那点钱和「先扒要点再成篇」的质量，你自己权衡。
- 第一遍失败不影响回话：降级成直接让 Pro 写，用 warning 说「要点没写出来」。
- 混合模式开着又带音视频时，走的就是这一档（不是 vision），`reason` 写「你打开了混合模式：V4.1 Flash 先扒要点…」。
- 调试：`POST /api/route/test {text, attachments:[{kind:'video'}], hybrid:true}` 会返回 `kind: 'media'` + `draftModel`。

---

## 四个整页入口：对话 / 日历·时钟 / QQ / 插件 / 设置

侧栏现在管导航：上面对话列表，底下四格是「日历 · QQ · 插件 · 设置」。点哪格，右边主区就换成那一页，左上角「回到对话」或按 Esc 回去。对话本身也是一个视图，不会因为切页丢掉。

- **日历 · 时钟**（一格，一页两面）：左边月网格和当天安排，右边大钟 + 今天还剩 + 接下来 7 天。那一格平时显示当前时间。
- **QQ**（独立一页）：顶部连接状态、扫码登录区、最近收发，下面是设置与发送框。
- **插件**（独立一页）：本应用自己的通道一览——QQ 通道、日历、读链接、自动路由、上下文压缩检索、本机小模型。每行显示状态（开/关、在线/没起、模型名），右边就地开关或下拉，还能「去 XX 页」跳过去。这里只管本应用的通道，不碰 DSH 的插件、配置和进程。
- **设置**（独立一页）：Key / 地址 / 模型 / 全家桶开关 / 上下文 / 路由 / 读链接 / 语音 / 主题 / 导入，顶部一行是「导入对话 JSON / 切换主题 / 本地 N 个会话 · M 条消息 · X token」。
- **侧栏「调」**：鼠标移到某个会话上，右边出现「调」，点它就地弹出这个小弹层——改标题、模型、上下文预算（跟随全局或 4k…1M）、召回条数、半衰期，保存只影响这一个会话，不用打开它。

**日历**：月网格（周日开头，42 格，今天有框、有事的日期下面带小蓝点），点某天看那天的安排；「＋ 新建日程」填标题 / 日期 / 开始 / 结束 / 备注。每条日程能「标记做完」「在会话里问」「删」。「在会话里问」会把这条日程丢进当前会话当一句话发出去——比如「下午三点牙医复诊，什么时候出门合适」。

**日历**：月网格（周日开头，42 格，今天有框、有事的日期下面带小蓝点），点某天看那天的安排；「＋ 新建日程」填标题 / 日期 / 开始 / 结束 / 备注。每条日程能「标记做完」「在会话里问」「删」。「在会话里问」会把这条日程丢进当前会话当一句话发出去——比如「下午三点牙医复诊，什么时候出门合适」。

日程存在 `data/calendar.json`，只在这台机器上。设置里「日程进上下文」（默认开）打开时，每次请求会把最近 3 天（`calendarDays` 可调）的日程作为一段 system 消息带给模型，所以问「我今天还有什么没做完」它答得上来。这一段能看到 `context` 事件里的 `schedule: {today, days, tokens}`。

**时钟**：大钟 + 日期星期 + 今天剩几件 + 「今天还剩」与「接下来 7 天」（跳过已完成的）。

**QQ**：走 OneBot 11 的 HTTP，跟 `dsh-qq-bridge` 插件用的是同一个后端、同一套 action，但**不经过 DSH 进程**——app 自己起一个轮询循环，也不读插件配置里的任何凭据。

前提是先有后端：NapCat 在本机 `D:\NapCatOneKey`（`扫码登录.bat` / `start-napcat-A.bat`），起来后默认监听 `http://127.0.0.1:3000`，要扫码登录一次。

**
二维码卡片会自己说明这张码多旧：超过十分钟没更新就标黄字提醒「扫码八成会失败」，并给出两条路——「刷新二维码」只是把目录里那张图重读一遍（NapCat 没重出码时会明确告诉你「还是同一张码（N 天前的）」），「重启 NapCat 出新码」才会杀掉 NapCat 再重跑启动脚本、逼它重新出码（会断开当前登录，最多等 60 秒）。判断换码看文件内容 hash，不看 mtime——NapCat 覆盖写有时不改时间。
扫码登录就在 QQ 页里做**：右上那格会显示 NapCat 状态和二维码——没起就点「启动 NapCat」（app 直接跑目录里的启动脚本），起好了点「刷新二维码」手动拉一次（app 会去目录里找最新的二维码图，10 分钟内的算新鲜），拿手机 QQ 扫，扫完点「检查是否已登录」，成功后那格变成账号昵称 + UID。

二维码**开着 QQ 页时每 2 分钟自动刷新一次**：每次只请求 `GET /api/napcat/qr`（只读那张图，不探端口、不拉登录态），服务端按文件内容算 `hash`，图没变就不动 DOM、不闪；变了才换图并把「第 N 次刷新」+1。卡片上写着「更新于 hh:mm:ss · 第 N 次刷新 · 约每 120 秒自动刷新（mm:ss）」那个 `mm:ss` 是倒计时，到 0 就自动拉下一轮。切走页面自动停，回来重新开始。真扫码时 NapCat 重连会重写 `qrcode.png`，下一轮自动换上新码，不用手动点。

QQ 页里：

- 模式：`关 / 只发 / 收发`。只发=你从面板发消息过去；收发=把 QQ 上的新消息拉进来，在当前会话里跑一轮，再把回答发回 QQ。
- 地址（默认 `http://127.0.0.1:3000`）、私聊 QQ 号、群号（填了群号走群）、轮询间隔（2–60 秒）、称呼（拼进提示里的「对方」）。
- 「测试连接」拉 `get_login_info`；「立刻收一次」手动跑一轮；「从插件配置读地址」只读 `%USERPROFILE%\.dsh\qq-bridge-config.json` 里的 NapCat 地址 / 私聊号 / 群号 / 称呼四个字段，**只回报读到什么，不落盘**（要写进去得再点一次）。
- 收发模式下，收进来的消息写成 `【来自 QQ 上的对方（QQ号），时间】正文`，自动用当前路由（通常 V4 Pro）回答；会话不存在时会自动建一个叫「QQ」的，后续都落在它里面。

调试接口：`GET /api/napcat`（目录/端口/二维码/登录态）、`GET /api/napcat/qr`（只读最新二维码 + hash，给自动刷新用）、`POST /api/napcat/start`（拉起 NapCat）、`POST /api/napcat/restart`（杀掉旧进程并重跑启动脚本，逼它出新码）、`GET /api/channels`（插件页那六行的数据）、`GET /api/qq/state`（连接状态 + 最近收发）、`POST /api/qq/test`、`POST /api/qq/send {text}`、`POST /api/qq/poll`、`POST /api/qq/import-config {apply?:true}`；日历是 `GET|POST /api/calendar`、`PATCH|DELETE /api/calendar/:id`。

QQ 这条链路是用本地假 OneBot 服务验的（`tools/qq-test.mjs` 自己起 3100 端口）；真号没连过——真连要你自己扫码。

---

## 导入 App 的导出记录

App 里「设置 → 数据管理 → 导出对话记录」拿到的 JSON，直接：

- 拖进窗口，或
- 点左下角 **导入**，或多选文件

文件里有 `messages` 数组就行（`{messages:[…]}`、`{data:{messages:…}}`、裸数组都认）；角色 `user/assistant/human/model` 都能识别；`reasoning` / `reasoning_content` / `think` / `thinking` 都当作深度思考内容。

首次启动时也自动扫工作区里这两个文件（只导一次，记录在 `data/.auto-imported.json`）：

- `../AI摸鱼写游戏.json`
- `../delta/战地1弹震症士兵.json`

导进来的是**只读的历史**——可以接着在同一个会话里继续问，历史会作为上下文发给 API。注意 `maxHistoryMessages` 默认限制只带最近多少条（设置里可改，0 = 不限），否则几十万字历史会把上下文撑爆。

App 导出里那几条 content 为空的消息（App 里是空白的）会被跳过，不进库。

**拖入压缩包直接整理成对话**：现在把 zip 拖进窗口就会自动拆包、认类型、整理成可以直接续聊的会话（不用再跑脚本）。

| 拖进来的东西 | 判定 | 整理成什么 |
| --- | --- | --- |
| 桌面 App「导出全部数据」的 zip（含 chat_session_index.json） | deepseek-export | 按会话拆开，图片落到 data/media/imported-<id>/，思考过程保留 |
| 任意含会话 JSON 的 zip | undle | 包里每个会话数组都变成对话 |
| 资料包（md / txt / 代码 / 日志…） | rchive | 按顶层目录分 2–6 组，每组一个对话；正文是「【包名 · 分组】+ 文件清单 + 逐文件内容」 |
| 单个 .md / .txt / .json | 	ext / JSON | 一份材料一个对话 |

限制：单包 ≤200 MB、文本文件最多 60 个（单文件取前 6000 字、单会话 ≤4 万字）、图片/文档/二进制只跳过不报错；包里一个可读文本都没有会直接回 400 并说明原因。重名会话会被替换（不是叠加）。

拖拽层只认「文件」拖入（拖选中文本不会触发），Esc 可收起；多文件一次拖进来会逐个整理，最后弹一条汇总。

整包导出（桌面 App「导出全部数据」那个 zip）用脚本导，会连图片一起搬进来：

```bash
node tools/import-deepseek-export.mjs "C:\path\to\deepseek_data-2026-11-22.zip" --dry   # 先看统计
node tools/import-deepseek-export.mjs "C:\path\to\deepseek_data-2026-11-22.zip"           # 真导（同名标题的旧会话会被替换）
```

脚本自己解 zip（不依赖任何库），把 `REQUEST/RESPONSE/THINK/FILE` 这几种 fragment 映射成消息、思考过程与附件：图片写到 `data/media/imported-<会话id>/`，工具调用过程（搜索、打开网页）跳过，同角色连续的 fragment 合并成一条消息。原始 `inserted_at / updated_at` 会保留——导入如果被刷成「今天」，时间衰减和「多少天前」就全错了。

---

## 目录

```
deepseek-app/
├─ server.mjs          零依赖 HTTP 服务：会话存储、SSE 转发、文件/语音代理、导入导出
├─ public/
│  ├─ index.html       页面骨架
│  ├─ styles.css       主题与布局
│  ├─ md.js            Markdown / 数学 / 代码高亮（自写，不用 CDN）
│  ├─ app.js           前端全部交互
│  └─ vendor/          KaTeX、highlight.js 及字体（离线）
├─ data/
│  ├─ settings.json    设置（含 API Key，别外传）
│  ├─ server.json      最近一次的监听地址
│  ├─ app-profile/     独立窗口用的浏览器配置（删了会重新生成，不影响对话）
│  ├─ uploads/         你传的图片与文档（文档另外在 DeepSeek 那边存一份 file_id）
│  ├─ media/           视频/音频解析结果：转写 + 音轨 + 关键帧（原文件解析完即删）
│  ├─ calendar.json    日程（标题/日期/时间/备注/做完没有）
│  ├─ conversations/   一会话一个 JSON + index.json
│  └─ archive/         压缩前的原文备份：<会话id>/<起始>-<结束>.json + index.json（含分段与可选向量）
├─ calendar.mjs        日历纯函数：日期/星期/月网格/排序/未来 N 天/拼成提示词
├─ qq.mjs              OneBot 11 HTTP 客户端：登录信息、收发消息、拉历史、去重、拼提示
├─ context.mjs         上下文管理：token 估算、BM25 索引、稠密余弦、时间衰减、分档摘要与长期记忆提示词
├─ fetchlink.mjs       读外链的两级兜底：HTTP 抓 HTML 抽正文 → 内嵌 Chromium 渲染
├─ electron/main.cjs   桌面壳主进程：进程内起服务、开窗口、退出时一起关
├─ dist/DeepSeek-win32-x64/   打包产物：DeepSeek.exe（双击这个）+ resources/app/ + data/（junction 回仓库 data/）
├─ assets/app.ico      应用图标（tools/make-icon.mjs 用 ffmpeg 画的）
├─ tools/              抓 vendor、冒烟/集成测试、假上游、装快捷方式
├─ 启动应用.vbs        兜底启动器：有打包 exe 就开它，没有就走 node 服务 + Edge 独立窗口
├─ 停止应用.vbs        双击 → 关掉后台服务
├─ 启动.cmd            旧方式：起服务 + 浏览器标签页
└─ package.json
```

## 图标与吉祥物

- 应用图标用 `dsh-whale-widget` 的那张鲸鱼女仆头（`%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-whale-widget\icon.png`）。换图标：`node tools/make-icon.mjs`（默认读上面那张，生成 16–256 七个尺寸打进 `assets/app.ico`）→ 重新打包 → 重跑 `tools/install-shortcut.ps1`。
- 页面右下角是同一套素材里的半身像（`public/assets/dsniang.png`），点它随机说一句话，切到日历/QQ/插件/设置页会自动收起，回到对话再出现。
- 浏览器标签页图标用 `public/assets/whale.png`。
- 吉祥物那块 HTML 必须写在 `<script src="/app.js">` **前面**——`initMascot()` 在脚本执行时就要能找到 `#mascot`，放到后面会静默失效（点了没反应）。

## 自测

```
node tools/smoke.mjs          # 接口检查（需服务已在 8787 跑着），51 项
node tools/integration.mjs    # 全家桶链路（自己拉假上游 8899，不花钱、不用 Key），54 项
node tools/lint-frontend.mjs  # 前端静态检查：HTML id ↔ JS 选择器、class ↔ CSS、接口是否存在
node tools/test-md.mjs        # 拿真 KaTeX/highlight.js 跑 md.js，39 项
node tools/check-assets.mjs   # index.html 引的本地资源是否都 200
node tools/dom-check.mjs      # 真浏览器（无头 Edge）点一遍：新建/搜索/主题/设置整页/移动端/上下文面板（含本会话参数）/自动路由/日历·时钟页/QQ 页/插件页/侧栏「调」/无 Key 报错，113 项
node tools/napcat-restart-test.mjs # 「重启 NapCat 出新码」：造假 NapCat 目录，验杀进程/重跑启动脚本/按 hash 认出新码，9 项，BASE 必填且不能是 8787
node tools/qr-refresh-test.mjs # QQ 页二维码自动刷新（自造两张假码换图，验 hash/换图/第 N 次/倒计时/手动刷新提示），13 项，需先起一个隔离数据目录的测试服务
node tools/dom-chat.mjs       # 真浏览器发一条联网消息（连假上游），验流式/过程卡片/引用角标/自动标题，30 项
node tools/media-smoke.mjs    # 视频/音频解析链路（假上游 + 真 ffmpeg）：抽帧、转写、两段式（Flash 扒要点 → Pro 写正文、第二遍不带图），23 项
node tools/context-test.mjs   # 上下文：token 估算/分词/召回/衰减/压缩提示词/本机摘要/归档/分档概要/遗忘/渐进展开/每会话参数/记忆整合，97 项
node tools/app-check.mjs      # 连上正在跑的应用窗口（需带 --remote-debugging-port=9333 启动），校验页面真的活了 + 内嵌内核读 JS 页，12 项
node tools/shot-ctx.mjs <会话id> [查询词]  # 重新截上下文面板/设置（无头 Edge，需要服务在跑）
node tools/link-test.mjs      # 读链接：HTML 抽正文/实体/链接抽取、HTTP 那一级、兜底顺序、/api/read-url、聊天预读注入，36 项
node tools/route-test.mjs     # 自动路由：判断表 + 四档真链路（专业对话/带思考/混合两次调用/音视频两段式）与手动会话不受影响，47 项
node tools/demo-route.mjs     # 造一个「自动路由」演示会话并截图（连假上游，跑完打印会话 id）
node tools/calendar-test.mjs  # 日历：纯函数 + 增删改查 + 日程进上下文（连假上游），48 项
node tools/qq-test.mjs        # QQ：自己起假 OneBot 3100，验登录/只发/收消息去重/收发一轮/群模式/故障/设置校验/读插件配置，35 项
node tools/shot-day.mjs       # 截日历/时钟/QQ 三张面板图（临时造日程与假 OneBot，跑完还原）
node tools/demo-archive-conv.mjs   # 造一个「压缩记忆 + 原文归档」演示会话（连假上游，跑完打印会话 id）
node tools/demo-archive-conv.mjs --clean <会话id>  # 删掉演示会话和它的归档目录
node tools/mock-upstream.mjs  # 假上游（正常由 integration / dom-chat / media-smoke 自动拉起）
node tools/vendor.mjs         # 重新下载 KaTeX / highlight.js（一般不用）
node tools/fonts.mjs          # 补齐 KaTeX 字体
node tools/make-icon.mjs      # 重新生成 assets/app.ico（需要 ffmpeg）
powershell -ExecutionPolicy Bypass -File tools\install-shortcut.ps1   # 重建桌面/开始菜单快捷方式
```

`integration.mjs` 和 `dom-chat.mjs` 会把设置临时指向假上游跑一遍，跑完还原——期间不会碰真 Key，也不产生费用。

`dom-*.mjs` 会启动本机 Edge 的无头模式（找不到可以设环境变量 `EDGE_PATH`）；它们跑完会把自己造的空会话删掉。

`media-smoke.mjs` 需要本机 ffmpeg；测试素材（9 秒测试视频、4 秒测试音）缺了会自己现场造。

### 一把跑完全部（2026-11-23 加）

```
pwsh -NoProfile -File tools\_run-suite.ps1 -Base http://127.0.0.1:8820 -Tests smoke,integration,dom-check
pwsh -NoProfile -File tools\_run-fresh.ps1 -Tests qq-test,context-test,route-test,tune-test,link-test
```

`_run-suite.ps1` 打一个已经跑着的实例（`-Data` 顺手把 `DSAPP_DATA` 传给子测试，`context-test` 认这个）；`_run-fresh.ps1` 给**每个测试单独起一个全新隔离实例**，跑完就拆——`route-test`/`tune-test` 会往实例里写 mock Key，不隔离会连累后面的测试被 `_guard.mjs` 拦下（这条坑踩过两次）。

分三堆跑才全绿：**静态/无状态那批**（lint、check-assets、test-md、model-fallback、model-pull、zip-import、import-preview、qq-bind、import-page）随便挂哪都行；**要数据的**（smoke、integration、calendar、media-smoke）必须挂在 `conv>0` 的实例上；**要真 Key 的**（chat-drop、app-check）得打日常那个 8787——附件会走上游文档解析，假 Key 会 502。

## 验到什么程度

2026-11-21 用真 Key 逐个跑过：联网搜索、深度思考（低/高/最高）、读链接、图片理解（让它读一张截图上的按钮文字）、PDF 文档问答、语音合成 → 语音识别闭环、视频解析（转写 + 6 帧，问「这段语音说了什么」答得对）、继续生成、内容安全开关、`deepseek-v4-pro` 纯文本。

浏览器端也端到端握过一遍：从附件按钮选真实视频 → 解析 → 发送 → 关键帧缩略图与转写折叠面板渲染 → 模型答对；附件条、音频附件、深浅主题、手机宽度都截图核对过。

没验到的两处：麦克风真机录音（无头浏览器没有麦克风设备，走的是同一套 ASR 接口，接口本身验了）、真实手机上的触摸操作。

---

## 隔离实例：一个 QQ 号一个 NapCat，谁也不抢谁（2026-11-23）

一个 NapCat 实例只能挂一个号，DSH 那边已经占了 echo（OneBot 3000）。这边要自己有一套：
复制一份 Shell、用自己的号、自己的端口，用 C++ 宿主管启停。**两边互不干扰**，而不是把 DSH 那份改一改。

- 宿主：`napcat/host.cpp` → 编译成 `napcat/out/DSLNapCatHost.exe`（`napcat/build.ps1` 编译，顺手拷进打包目录）。DLL 一个不带，只用系统 API。
- 命令：`status` / `start` / `stop` / `run`（看门狗）/ `qr`。参数：`--shell` `--login` `--http-port` `--ws-port` `--webui-port` `--wait-qr`。状态写 `state/host-status.json`。
- 端口：OneBot **3200**（HTTP）/ **3201**（WS）/ WebUI **6209**；DSH 那边照旧 3000/3001/6099。
- Shell 副本：`D:\NapCatDSL\Shell`（从 `D:\NapCatOneKey\NapCat.52230.Shell` 整份复制，原目录原样不动＝备份）。
- 账号数据目录：QQ 的聊天数据本来落在 `Documents\Tencent Files\<号>\`（按号分目录），
  这里把 delta 那份（`3810187208`，219 MB）整体挪到了 `napcat\data\3810187208`，
  原位置留一个目录联接（junction）指过去 —— QQ 照旧按原路径读写，字节全在 DSL 目录里。
  实测登录后新数据立刻写进 `napcat\data\3810187208\nt_qq\...`，从原路径也能看到同一个文件。
  换机器/重装时把新号的数据目录照同样办法搬一次就行。
- 登录目录：`--user-data-dir` 指到自己的文件夹（默认 `<exe 同级>\login`，开发态是 `napcat\login`）。
  这一条是整套隔离的关键——QQ 默认读系统共享的 `%APPDATA%\QQ`，一启动就快速登录 echo，永远不出二维码；
  给它一份干净的 profile，码才会出来。QQ 的聊天数据另落在 `Documents\Tencent Files\<号>\nt_qq`，那层还归系统。
- UI：QQ 页最上面「隔离实例（C++ 宿主）」卡片——状态行（进程数/端口/登录）、启动、停止、刷新状态、看二维码、保存 Shell 与登录目录。
- 接口：`GET /api/napcat/host`、`POST /api/napcat/host/start`、`POST /api/napcat/host/stop`。
- 实测（2026-11-23）：delta（3810187208）扫码登录 → 3200/3201/6209 全通 → `get_login_info` 回 `{"user_id":3810187208,"nickname":"delta"}` → `send_private_msg` 发到 3979605697 成功（`message_id 164640040`）。
- 坑：**别 `taskkill /im QQ.exe`**，那会连用户自己的 QQ 一起杀；宿主的进程判定只认「路径在 Shell 目录下」+「父链传播」，且限定在 `QQ.exe`/`NapCatWinBootMain.exe` 两个名字。
  登录成功后也别随便 kill——QQ 的会话要落盘，强杀可能把登录 profile 写坏，表现是「QQ 起来 20 秒就自己退出」，这时只能把登录目录删掉重扫。

### 「重启 / 刷新二维码」为什么以前会报「没找到启动器」（2026-11-23 修）

隔离实例用的是 `D:\NapCatDSL\Shell` 这份 **Shell 副本**，里面只有 `NapCatWinBootMain.exe` 和 `napcat.mjs`，没有 `扫码登录.bat` / `start-napcat-A.bat`。UI 的「重启 / 刷新二维码」以前还走老 NapCat 的 `.bat` 路径，所以一点就报：

```
重启失败：没在 D:\NapCatDSL\Shell 里找到启动器（扫码登录.bat / start-napcat-A.bat）
```

现在（`server.mjs` 的 `isNapcatShellDir` / `isoShellDir` / `startNapcat` / `restartNapcat`）：

- 目录里认到 `NapCatWinBootMain.exe` 或 `napcat.mjs`，就当 Shell 副本 → 交 C++ 宿主拉起（只有它知道要带 `--user-data-dir`，不带的后果是 QQ 快速登录别的号、永远不出码）
- `restart` **先看实例活没活**：`loggedIn` 或 OneBot 端口通，直接返回 `skipped`「没动它」，一次都不 stop；因为强杀会把登录 profile 写坏，代价是重新扫码（这个坑踩过两次）
- 真的挂了才 `stop` → 等 1.2 秒 → `start` → 最多等 60 秒看二维码 hash 有没有变，返回 `rebuilt` / `waitedMs` / `killed`

验法：`node tools\napcat-hostpath-test.mjs`（14 项；用假宿主 .mjs 冒充 C++ 宿主，跑在 18931，不碰真实例）。
### 长期托管怎么做的（2026-11-23）

- 托管入口：`%LOCALAPPDATA%\DeepSeekLocal\napcat-host\host-run.cmd` → 跑 `DSLNapCatHost.exe run`（前台看门狗）。
  这个 exe 故意放在**工作区外面**：放在 DSH 工作区里时进程表会被裁剪（只看得见十几个进程），看门狗会误判「实例没跑」而反复拉起第二份。放外面就正常（实测 `processCount 6`）。
- 计划任务 `DeepSeekLocal_NapCatHost`：登录时触发（延迟 30 秒）、以当前用户最高权限、`IgnoreNew` 单实例、无运行时长上限、失败重试 3 次。
  它跟应用是解耦的：应用开着不开着都不影响 QQ 通道。停掉就 `Disable-ScheduledTask -TaskName DeepSeekLocal_NapCatHost`。
- 看门狗行为：进程没了按 3→6→12→24→48→60 秒退避拉起；**连续失败 6 次退到 10 分钟一轮**，并在状态文件里写 `warning`
  （`反复起不来：可能是登录态被写坏…`），不无限快速重启刷屏。恢复登录后 `fails` 归零、`warning` 清空。
- 应用侧设置项 `napcatHost` 指向上面那个部署副本，所以卡片上的进程数/登录态和看门狗看到的一致（工作区那份 exe 看不全）。
- 自检顺序：`Get-ScheduledTask DeepSeekLocal_NapCatHost` → `host-status.json` 里看 `phase`（`online` / `waiting-login` / `restarting`）。

### 消息推送 + 自动纠错（2026-11-23）

两块都在 QQ 页上，接口是 `POST /api/push` 与 `GET|POST /api/napcat/heal`。

**消息推送**（`pushEnabled` 默认开、`pushUid` 存推给谁）——这是「这台机器主动找你」的通道，不是等你去翻页面：

- 权限门在服务端：`GET|PUT /api/settings` 里关掉 `pushEnabled`，`POST /api/push` 一律 **403 `PUSH_OFF`**，不是前端藏按钮糊弄人。
- 目标优先级：请求体 `uid` → `pushUid` → `qqUid`；群聊传 `group`。
- 用处：任务完成、长活跑完、自动纠错结论。走的是隔离实例那条 OneBot，跟回复同一个通道。
- 桌面通知另有一层：QQ 页开着时，新进来的私聊会弹系统通知（60 秒内的才算新，按 `messageId` 去重）。浏览器/Electron 首次要 `授权桌面通知` 点一下。

**自动纠错**（`napcatAutoHeal` 默认开，90 秒一轮，也能在卡片上手动跑一次）：

- 在线时不动手，只校验 OneBot 配置（端口不对/文件缺了就按模板重写）。
- 连续起不来 2 次：补 OneBot 配置后重启实例。
- 连续起不来 4 次：**轮换登录目录**（`login` 改名 `login-broken-<时间戳>`，建新的空目录），并把 `needLogin` 标出来等你扫码。
- 已经出码但没登录：只记「等扫码」，不算故障，不会为此反复重启。
- 有动作就推一条「【自动纠错】…」到你 QQ（推不通就静默，不影响修复）。
- 日志在 `data/napcat-heal.log`。

**它修不了什么**：强杀写坏的登录态*有时*能靠轮换目录救回来（等于让你重扫），但**已经丢掉的会话它救不回来**；真遇到「QQ 起来就退」先看卡片上的 warning，再看 `host-status.json` 的 `fails`。

**怎么演练「反复起不来」而不碰真实例**（2026-11-23 实际这样跑过一遍）：

1. 起一个沙盒实例：`$env:DSAPP_DATA='<repo>\data\_healsandbox'`、`$env:PORT='8811'`、先写 `{"autoImport":false}`。
2. 造三样假的：假 Shell（`shell\config\napcat_900001.json` + 端口写成 3000 的 `onebot11_900001.json`）、假登录目录（空目录）、假状态文件（`{"fails":5,"loggedIn":false,"phase":"restarting"}`）。
3. `PUT /api/settings` 把 `napcatShell` / `napcatLogin` / `napcatStatusPath` 指到这三样，`pushEnabled:false`（免得演练时真推你 QQ）。
4. 打 `POST /api/napcat/heal`，预期两条动作：`起不来但 OneBot 配置缺，已补 (900001) 并重启`、`进程反复起不来…已重置登录目录并重启，需要重新扫码`；
   然后看 `onebot11_900001.json` 的端口变成 3999/3998（按设置里的端口重写）、`login` 旁边多出 `login-broken-<时间戳>`、新 `login` 是空目录。

这套演练暴露过一个真问题，已经修掉：`fails` 只活在超管进程的内存里，而 `status` 是**另起一个进程**跑 —— 它既读不到 `fails`（永远 0，纠错分支等于死代码），又会在返回后**回写状态文件把它清成 0**。现在 `status` 改成只读：开跑先 `LoadPersistedStatus()` 从状态文件把 `fails`/`warning` 读回来，且不再 `WriteStatus`。

### 为什么不会再弹黑框（2026-11-23）

命令行窗口一闪一闪很碍事，四处都堵了：

1. **计划任务走 `wscript.exe //B host-run.vbs`**，vbs 里 `WScript.Shell.Run(..., 0, True)` —— 窗口样式 0，从头就没有窗口；`True` 是等它跑完，外面再套一层循环（退出码 3 = 已经在跑，就等 60 秒；其余 10 秒后重来），所以任务常驻 `Running`，宿主崩了自己会回来。之前任务是 `cmd.exe /c host-run.cmd`，那个 cmd 窗口会一直挂在桌面上（不是闪一下，是赖着不走）。
2. **宿主自己藏控制台**：`DSLNapCatHost.exe` 是 CUI 程序，`wmain` 一进来就 `ShowWindow(GetConsoleWindow(), SW_HIDE)`。手动双击 `host-run.cmd` 时窗口也会立刻消失；更关键的是 `NapCatWinBootMain.exe` 是 CUI、会继承这个隐藏控制台，所以它不会再自己开一个可见窗口（QQ.exe 本身是 GUI，不受影响）。
3. **应用里所有子进程都带 `windowsHide: true`**：`runCli`（宿主 status / ollama / ffmpeg）、`startNapcat`（老的 `cmd /c 扫码登录.bat` 路径，之前是 `false`）、`execFile`（模型下载）、`openBrowser` 的 `cmd /c start`。
4. 老的「重启 NapCat」路径同理走 `startNapcat`，已经一起静默。

验证方法（可复现）：用 `EnumWindows` 每 60ms 采样一次可见的 `ConsoleWindowClass` 窗口，同时连打 128 次 `/api/napcat/host`、再整轮重启应用并连点「启动隔离实例」—— 两次采样捕获到的可见控制台窗口都是 **0**。

例外：`启动演示.cmd`、`停止演示.cmd` 这类**你自己双击**的脚本仍然会开窗口（故意的，要能看见它干了什么）。

---

## 回复风格（2026-11-23 加）

设置里有三档，`settings.replyStyle`：

- `human`（默认）— 注入 `server.mjs` 里的 `HUMAN_STYLE_PROMPT`，六条：第一句给判断、别重述问题、每句带具体东西（数字/时间/文件/步骤）、说不准就说不知道、句子可短可说一半、别三段排比别段末总结别用「值得注意的是/综上所述」。最后一条兜底：**用户明确要清单、步骤、表格、代码时照给**——风格不能把东西讲糊。
- `native` — 一条都不加，跟以前一样。
- `custom` — 只用设置里那个「系统提示词」框。

选 `human` 时你自己写的系统提示词会**接在风格提示后面**一起发；选 `custom` 就只发你那一段。`buildMessages` 拼装处只在这一处判断，别在别处再塞一遍。

验证：`node tools/reply-style-test.mjs`（假上游记请求体，15 项：默认 human、活人感那几个关键词真进了 system、原生不带、自定义只带自己的、两段共存、非法值回落 human）。

同一句话两种风格的差别（2026-11-23 实测，问「要不要加自动更新」）：`native` 给了「结论 / 收益 / 主要坑 / 推荐落地路径」四段带加粗列表；`human` 是「我的倾向是加，但先确认一件事：卖给企业内网还是给普通用户下载？」开头，中间带签名证书一年几百到上千美元、Apple 99 美元这类具体数字，结尾反问用的是 Electron 还是 Tauri。

---

## 技能包（2026-11-24 加）

`skills/<id>/SKILL.md` 就是一份技能，DSH 里那套格式照搬：YAML front matter 写 `name` / `description`，正文是要注入的内容。

- 位置：**数据目录下的 `skills/`**（`data/skills`，装好后是 exe 旁边的 `data\skills`）。代码里自带的那份 `resources\app\skills` 只在第一次启动时「播种」过去，已有的一律不动 —— 所以覆盖 dist 里的代码、升级版本，都不会把你自己装的/改过的技能换掉。`DSAPP_SKILLS` 仍可指到别处（指了就完全听它的，既不播种也不读自带那份，测试与多开实例都靠这个）。
- 识别：只认有 `SKILL.md` 的目录；没 front matter 就用第一个 `# 标题` 当名字、第一段非标题文字当描述。
- 注入：设置里勾上的（`settings.enabledSkills`）在 `buildMessages` 里拼成**单独一条 system**，抬头 `【技能：名字】`，跟在风格提示后面。单个技能上限 6000 字，超了截断并注一句「技能过长已截断」。
- 与回复风格无关：`native` 也照样注入技能，两件事互不影响。
- 保存时按目录真实存在的 id 过滤，写 `../x` 之类的东西进不来。

接口：`GET /api/skills` 返回 `{dir, skills:[{id,name,description,chars,files,file,enabled}]}`。

### 技能页：拖进来就装（2026-11-24 加）

侧栏「技能」进去是一个拖放页，装完自动勾上：

- 能拖什么：一个 `.md`／`.txt`（就当成 `SKILL.md`）、装了它的整个文件夹、或者 `.zip`（里面套一层文件夹也行）。
- id 怎么定：传了 `id` 用它 → 主文件上层目录名（zip/文件夹）→ front matter 的 `name` → 文件名。中文名直接当目录名，重名自动加 `-2`、`-3`。
- 页面级 `dragover`/`drop` 会 `stopPropagation`，不然会被全局拖放层抢走（那层只认「导入」和附件两种模式）。拖文件夹靠 `webkitGetAsEntry` 递归摊平，文件名带相对路径，服务端 `installSkillFiles` 按相对路径落盘。
- 服务端写盘前查两道：`..` 段直接丢、扩展名得在 `SKILL_ALLOW_EXT` 里、单文件 ≤2 MB、一个技能 ≤24 MB；`skillDirOf()` 还会把 id `path.resolve` 之后核一遍必须在 `skills/` 里面。
- 停用/启用走 `POST /api/skills/enable {id, enabled}`，删除走 `POST /api/skills/delete {id}`（只删 `skills/<id>`，删完从 `enabledSkills` 里剔掉）。删除**不动**对话。

接口：`POST /api/skills {name?, id?, content}`（贴一段 SKILL.md 就能装）、`POST /api/skills/upload`（原始 body 或 multipart，query `?name=`）、`POST /api/skills/enable`、`POST /api/skills/delete`。

验证：`node tools/skill-install-test.mjs`（30 项：JSON 直传、单 md、zip 含子目录、`__MACOSX` 垃圾、重名加后缀、非法扩展名 400、zip 里 `../` 不越界、启停、删除、`..` id 400、空内容 400）。截图 `data/shots/101-技能页.png`。

注意：装进的是**数据目录那份** `data/skills`（不是 `resources\app\skills`），所以覆盖 dist 代码不会丢技能。想让技能跟着别的东西走、或者两个实例共用一套技能，就把 `DSAPP_SKILLS` 指到一个固定目录（比如 `%LOCALAPPDATA%\DeepSeekLocal\skills`）。全新装置（连 `settings.json` 都没有）第一次启动会把自带技能播进去并默认勾上；已有设置文件的只播种、不动你勾的。

第一个真技能是 `skills/video-platform-voice`（视频平台语感），数字不是手写的，是从 `voice-video\gen_skill.py` 读 102 万条语料统计生成的：弹幕中位 6 字、78% 不带句末标点、语气词 3.04/100 字、各分区性格表、各平台对照，末尾写明「抖音/快手/西瓜没采到，别编」。

验证：`node tools/skill-test.mjs`（22 项，假上游 + 临时技能目录）。实测效果——勾上它问「帮我写三条B站弹幕」，出来的是「这个汁儿看着就香啊 / 半夜刷到这个我真服了 / 啊啊啊饿了饿了」，`context` 事件里能看到 `skills:["video-platform-voice"]`。截图 `data/shots/100-设置-技能包.png`。

---

## 自学习：从群聊里学一个群怎么说话（2026-11-25 加）

一个群一条 JSONL，落在本机数据目录的 `qq-learn/<群号>/messages.jsonl`，不联网、不外传。

页面：侧栏「学习」。里面能刷新群列表、抽一批消息、结算本周、看某个群的画像与关系图。

- 抽消息：OneBot `get_group_msg_history` 往更早翻页（默认 2 页 × 100 条，最多 20 页），按 `message_id` 去重落盘
- 自动跑：`learnAuto` 打开时每 10 分钟抽一轮；`learnInject` 打开时，绑了群号的会话会在 system 里多一段这个群的说话画像（600 字以内）
- 周结算：一周一份 json + md，落在 `qq-learn/weeks/<群号>__<周>.json|.md`；本周还没长完就不覆盖
- 八个接口：`GET /api/learn/status`、`POST /api/learn/groups`、`POST /api/learn/ingest`、`GET /api/learn/analysis`、`POST /api/learn/settle`、`GET /api/learn/weeks`、`GET /api/learn/week`、`GET /api/learn/profile`
- 测：`node tools\learn-service-test.mjs`（48 项，假 OneBot 造 120 条两周数据）、`node tools\qq-learn-test.mjs`（57 项，纯函数层）；截图 `node tools\shot-learn-page.mjs`

数据侧现在还跑不起来：隔离实例要在线（`phase=online`）并且这个号得在群里，否则 `/api/learn/groups` 返回空。
## QQ 上的说话口径（2026-11-25 加）

QQ 会话（`source === 'qq'`，或 id 等于 `qqConvId`）会多收到一条 system：`QQ_VOICE_PROMPT`。它是从 `cn-net-voice` + `human-voice` 两个技能包的实测参数压出来的，不是随手写的规矩——小句 4–12 字、短句占一半、中文八成句子省主语、每两三句给一个能核对的东西、转折放在前中段、感叹号一条最多一个、不写「综上所述」这类串场词。

开关是 `qqStyle`（默认开）。关掉就是只剩通用的「活人感」提示。回话时的分段也一起放宽了：一次最多切三段、段落上限 140 字，不再一句一条地刷屏。

### 逐对话调口径（2026-11-25 加）

顶栏模型按钮左边多了一个下拉，选的就是**这个会话**的说话口径，改完立刻生效：

| 选的值 | 实际注入 |
| --- | --- |
| 跟随设置（空） | 全局 `replyStyle`；QQ 会话没设过就默认走 `qq` |
| `human` | `HUMAN_STYLE_PROMPT` + 反八股 |
| `qq` | `HUMAN_STYLE_PROMPT` + `QQ_VOICE_PROMPT`（`qqStyle` 开着时）+ 反八股 |
| `native` | 一条都不加 |
| `custom` | 只用自己的系统提示词（反八股仍在，可全局关） |

存的是会话自己的 `conv.replyStyle`（`PATCH /api/conversations/<id> { replyStyle: '' | 'native' | 'human' | 'qq' | 'custom' }`，空串=删掉此字段、跟随全局）。拼装只在 `buildMessages` 里做一次。

### 反八股（2026-11-25 加）

「鱼八股」就是这套东西的模板腔。`ANTI_BA_GOO_PROMPT` 用**反向清单**写：不是…而是…／不仅…更是… 的对仗、首先其次最后、值得注意的是／综上所述／换句话说、「在这个…的时代」起手、「希望对你有所帮助」收尾、赋能／闭环／抓手／颗粒度、段末复述+名词加粗+三连排比、客服腔、「自己刚用的梗还要解释一句」。比只说「别像 AI」有用——列出来的东西模型不会去撞。

开关 `antiBaGu`（默认开）；`native` 不注入，`custom` 仍注入（它管的是腔调，不是内容口径）。

验证：`node tools/voice-style-test.mjs`（假上游 + 隔离实例，14 项：网页会话带活人感/反八股/不带手机打字口径、逐对话改 qq 生效、native 两条都不带、custom 只带自己的、空串回落全局、全局关掉反八股后不再出现、绑了群的会话默认走 QQ 口径）。顺手改了历史消息：早期那条「【这条回在手机上】按语义分段…最多八段」是我塞进用户消息里的旧口径，已经用 `tools/_clean-legacy-qq-suffix.mjs` 从 `QQ 2` 的 28 条历史里剥掉（改前备份在 `data/backups/conv-legacy-*`）。

## 图片与附件（2026-11-25 补）

发图看不到，其实有两个不同的原因，都已经修了。

**网页里的图**：`server.mjs` 存用户消息附件时漏了 `url`，只留了 `uploadId`。气泡渲染那边要 `a.url` 才画 `<img>`，所以新发的图全退化成一块「文件」小标签（导入进来的老会话反而正常，因为它们带着 url）。现在存储时一定写 `url: /api/uploads/<uploadId>`，前端也多一层兜底：`a.url || (a.uploadId ? '/api/uploads/'+a.uploadId : '')`。

**QQ 发来的图**：`qq.mjs` 把 image 段只拼成 `[图片]` 文本，图从来没下载过，模型当然说「我看不到图片」。现在 `server.mjs` 的 `qqPollOnce()` 会先 `qqImageAttachments()`：

- `qqImageBytes()` 先试段里的直链（带 UA/Referer），拿不到就请 OneBot `get_image` 要本地文件，都不行就跳过单张；
- 落盘到 `data/uploads/`（单个上限 12 MB，一条消息最多 4 张），附件形状和网页上传的一模一样；
- `chatOnce(conv, text, settings, { attachments })` 带上这些附件；带图时模型自动切到能看图的 `routeThinkModel`（V4.1 Flash），纯文字还是走 `routeChatModel`；
- 「只发不回」模式也照样挂附件，界面上能看到图。

验法：`node tools/qq-image-test.mjs`（假 OneBot 发一张 16×16 PNG，18 项：附件落地、`GET /api/uploads` 能取回、发给上游的请求里真有 `image_url` 的 base64 块、模型是 flash、纯文字消息不带图）。
**修复之前收的图怎么补**：那批消息只留了 `[图片]` 文本，文件从来没下载过。`tools/backfill-qq-images.mjs` 会去 OneBot 重新拉历史，按消息时间戳对上会话里的那条，把图下载进 `data/uploads/` 再挂到消息上。默认演练，加 `--apply` 才写盘（写完要重启应用，会话是从磁盘读的）：

```
node tools/backfill-qq-images.mjs <会话id>          # 只看会补几张
node tools/backfill-qq-images.mjs <会话id> --apply  # 真写
```

**图片类型必须按文件头认**：QQ 给的 `content-type` 经常是 `application/octet-stream`，按扩展名硬写 `image/png` 就会拿一块「自称 png 的 jpeg」发给上游，模型那边解不出来，只能说「我看不到图」。`sniffImageMime(buf)` 读 `ff d8 ff` / `89 50 4e 47` / `GIF8` / `RIFF…WEBP` / `BM` 认类型，落盘和发请求都以它为准（`attachmentPayload` 也用它兜住老记录）。
**还有一个隐性坑**：V4 Pro 是纯文本模型，对话里明明存着图它也看不见，就会答「我没有读图能力」。所以 `/api/chat` 和 QQ 的 `chatOnce` 都加了一条判断——**只要这段对话里存在图片附件，本轮就换到能看图的 Flash**，哪怕这张图是几轮之前发的。
## 几个实现上的坑（改代码时留意）

- **带 `tools` 的请求必须回传历轮的 `reasoning_content`，否则 400**；不带 tools 时反而不能传（传了也被忽略）。所以 `buildMessages` 只在联网时才把思考内容拼回历史。
- **`server_tool_calls` 要原样回传**（连同 `kind` 与 `signature`）。`signature` 是加密后的网页正文，丢了网页内容就进不了下一轮上下文。
- **声明 `tools` / `safety_check` / `title` 之后，`temperature` 等采样参数会被忽略**（不报错但也不生效）。所以只有在纯聊天时才把 `temperature` 放进去。
- **流式末块可能把全量 `content` / `reasoning_content` 再下发一遍**，直接追加会重复；服务端对带 `finish_reason` 的块做了去重。
- **`latest_reminder` 必须紧贴在其所属 user 消息之前**（日期,星期,地点,平台,语言），否则 400；它是用户元信息，回传历史能提高缓存命中。
- **Files API 的 multipart 里 `purpose` 字段必须排在 `file` 之前**，否则解析失败；`TXT/MD/CSV/JSON/代码/xlsx/xls/epub/mobi` 用 `user_data`（转 Markdown、不计费），其余走 `text_recognition`。
- **继续生成**走 `/beta/chat/completions`，最后一条 assistant 加 `"prefix": true`；用过联网工具的回复不能续写（上游 400）。
- **停止生成**走 `AbortController` → 服务端 `res.on('close')` 感知后中止上游 fetch，并把**已经生成的部分**存盘；前端再回读一次，最多等 1.5 秒避开落盘竞态。
- **落盘顺序**：所有错误分支都是「先存会话、再发 error、最后 end」，否则客户端拿到响应结束立刻读文件会读到旧内容。
- **SSE 收尾顺序是 usage → title → warning → done**，`done` 必须是最后一个事件。
- 长会话只渲染最近 80 条，往上滚再加载，否则三千条消息的 DOM 会卡。
- **`启动.cmd` / `启动应用.vbs` 必须是 CRLF 换行**。用 LF 存盘时 cmd.exe 解析不了多行 `if (` 直接退出，表现就是「双击没反应」；VBS 也一样，改完记得转回 CRLF。
- **装快捷方式的 PowerShell 脚本要存成带 BOM 的 UTF-8**。Windows PowerShell 5.1 把无 BOM 的 UTF-8 当 ANSI 读，只要脚本里出现中文文件名（`启动应用.vbs`）就会「找不到文件」。
- 双击两次不会起两个服务：第二次检测到 `data/server.json` 里的端口还活着，只打开它、然后退出（退出码 3，启动脚本据此不提示「已退出」）。要强制再起用 `--force`。
- 旧设置里如果存着 `deepseek-chat` / `deepseek-reasoner` 这种历史模型名，服务端会自动迁移到 `deepseek-flash`，不用手动改。
- **没有「视频理解」这种 API**。视频是本地拆开的：ffmpeg 抽音轨 → 按 ≤110 秒切片 → 逐片调 `/v1/tools/asr` 转写 → 再按时间均匀抽关键帧，最后把「转写文本 + 几张图」当普通图文消息发过去。所以视频理解的上限取决于转写质量与抽帧密度；帧数在设置里可调（0–12，默认 6）。
- 每条消息最多回传 12 帧（`mediaBlocks` 里切），单帧最长边缩到 1280 再编码，免得一次请求体撑爆 48 MiB。
- **本机没有 embeddings 接口可用**，所以历史「向量索引」是词面的（BM25 + 词表维度），不是语义向量：认词、不认近义词。别在 README/界面上把它说成语义检索。语义那点能力是 ollama 的 embed 模型给的，且只用在归档区间上。
- **ollama 里带思考的模型（qwen3 系列等）会把正文塞进 `message.thinking`、`content` 留空**。压缩摘要时请求里加了 `think: false`，400 就退回不带该参数、并把 thinking 当兜底——不加这一步，摘要永远是「本地模型返回了空摘要」（实测 qwen3.5:4b）。
- 归档的 `from/to` 是**历史数组下标**（user/assistant 过滤后的），不是 `conv.messages` 下标；两套下标混用会让召回的「第几条」和年龄全错。改归档相关代码时统一用 `history[...]`。
- 召回的相关度阈值（默认 0.08）只看相关度，时间衰减只调排序优先级——否则几十天前的老会话会被权重直接判死、召回全空。
- **分档压缩的触发看「历史总 token / budget」这个 raw 比例**，不是压缩后的占用——否则压完比例掉回去，永远涨不到下一档。`step = floor(raw / 0.33)`、`forgetStep = floor(raw / 0.5)`，各自和 `memory.step / memory.forgetStep` 比大小，涨了才动。
- **「展开第 k 条」靠 `indexCardsCache`**：本轮用户消息是「展开第 1 条」这种话，拿它去检索是召不到东西的，所以展开前先取**上一轮给模型看过的索引卡**（`convId → cards`，最多 32 条）。没有缓存就展开不了。
- 记忆关键词按**消息 DF**（跨消息出现次数）抽，不按词频——一条消息里重复几十遍的填充文本会把词频骗高。短会话凑不出共同词时才退回词频，那时关键词会有点噪声。
- **改了 `context.mjs` 一定要重启服务**（`node server.mjs --stop` 再起），它是启动时 import 的；不重启跑测试会继续用旧模块，改动静默失效。
- 读链接的三级是「API 工具 → HTTP 抓 → 内嵌内核」，但**只有桌面版有第三级**：`fetchlink.mjs` 用 `import('electron')` 探测，纯 node 环境拿不到 `BrowserWindow` 就跳过，并把原因写进 `error`（「没有内嵌内核」），不会假装读到。
- 内嵌内核那个隐藏窗口关掉了图片（`images:false`）只取文字，别指望它能截全彩页面；有些站检测 headless / 缺少 cookie 会只给骨架，这时拿到的正文很短，会照实返回、由上层提示「正文太少」。
- **本机 1.5b 小模型偶尔会把提示词或原文复述回来**：`summaryLooksBad()` 会判它不合格（太短 / 长度接近原文 / 没有结论性小标题 / 在复述提示词），直接改用 API 重写，别让复述混进记忆。给本机的原文输入也收窄到 6000 字（1.5b 喂太长就会复述），API 那边给满。
- **假上游改了代码要重启**：`mockUp()` 发现 8899 已经有进程就直接复用，跑测试时可能还是旧版本（表现出来像「新写的记录逻辑没生效」）。改 `tools/mock-upstream.mjs` 之后先杀掉 8899 上的进程再跑。
- **混合模式的 `route` 事件是等大纲写完才发的**：第一遍失败降级时也会补发一次，所以前端只该在收到事件后贴标签；别在 `start` 时就假定有 `draft`。

- **Electron 起不来时先查两件事**：环境变量 `ELECTRON_RUN_AS_NODE` 如果被设成 1，electron 会退化成纯 Node 跑（报 `app is undefined`），要先清掉；在受限的进程沙箱里跑还要加 `--no-sandbox`（单实例锁要用命名管道，沙箱里会直接崩）。正常双击快捷方式不受这两条影响。
- **打好的 exe 里服务是进程内跑的**（主进程 `import()` 了 `server.mjs`），所以不再依赖系统 node；`DSAPP_DATA` 可以让它指向别处的数据目录，打包版默认用 exe 旁边的 `data/`。
- **重新打包后 `dist\DeepSeek-win32-x64\data` 的 junction 会跟着被删**（packager 覆盖输出目录），记得重建，否则应用会看成空数据。
- `@electron/packager` 的 bin 是 `bin/electron-packager.mjs`（不是 `.js`）；electron 的二进制要手动跑 `node node_modules\electron\install.js` 才会下载（npm 的 postinstall 有时被跳过）。
- **日历里的日期一律用本地零点**（`calendar.mjs` 的 `parseDate`），别拿 `new Date('2026-11-22')` 直接比：那是 UTC 解析，东八区会错一天。`sortEvents` 的顺序是「先日期、再时间（全天算 00:00）、最后标题」。
- **OneBot 的成败看 `status` 字段，不是 HTTP 码**：`{"status":"failed","message":…}` 也是 200，只看状态码会把失败当成功。
- **QQ 轮询必须过滤掉自己发的消息**（`user_id === 登录号`），否则收发模式下会自己跟自己无限对话；去重靠 `message_id` 的 `seen` 集合（只留最近 300 条）。
- **`qqConversation()` 建完会话必须回写 `qqConvId`**，不然每收一条消息就新建一个「QQ」会话。
- **测 QQ 别依赖真号**：`tools/qq-test.mjs` 自己起假 OneBot（3100），每次跑用不同 `message_id`，否则同一进程里第二次跑会被去重吃掉。真连之前 NapCat 要扫码登录、3000 端口得开着。

## 已知限制

- 单个会话几千条消息时，搜索是全量内存扫（本机数据量级完全够用）。
- 导入的会话没有原始时间戳（App 导出文件里就没有），时间衰减用的「年龄」是按消息位置在会话首尾之间插值算的，不是真实时间。
- 界面是桌面网页，不是原生 App；没有推送通知和后台任务。
- 本机摘要模型默认挑「最小的对话模型」（现在会自动选 qwen2.5:1.5b-instruct）：写一段摘要 100–150ms，首次调用要加载模型（几秒）。想换也可以在设置里手动选。
- 归档原文只存被压缩那几段，`data/archive` 会随长会话增长；删会话时不会自动删归档目录（原文备份留着手动清）。
- 语音输入要允许浏览器用麦克风（`127.0.0.1` 属于安全上下文，不用 HTTPS）；录音会先转成 16 位 PCM WAV 再发，最长 110 秒。
- 上传的单个文件 ≤100 MiB / ≤1000 页，一次最多 20 个文档；图片每张 ≤32 MiB。
- 视频/音频单个 ≤300 MiB；音轨按 110 秒切片逐片识别，长视频会按音频时长计费（0.39–0.78 元/小时），另加抽帧的图片 token。
- 联网搜索、读链接、内容安全这些是 DeepSeek 服务端工具，按官方计价规则可能产生额外费用；具体看官方文档。
- 文件是「上传一次、长期引用」：删了本机 `data/uploads/` 里的文件不影响已经发出去的消息（那边存的是 file_id），但重新发送那条消息时会找不到附件。
## 启动器与安装包

- **原生启动器**：`launcher/launcher.cpp`（Win32，无第三方依赖）。`launcher/build.ps1` 用 MSVC 编译（`call vcvars64.bat` → `rc` 编图标 → `cl /utf-8 /MT /O2`），产物 `launcher/out/DeepSeekLauncher.exe` 会同时拷到 `dist/DeepSeek-win32-x64/DeepSeekLauncher.exe`。
- 它负责：单实例、拉起 `DeepSeek.exe`（先裸启动，2.5 秒内退出就带 `--no-sandbox` 重试）、托盘菜单（打开应用 / 在浏览器打开 / 内存优化 / 退出）、每 10 分钟自动做一次工作集裁剪。应用若已在 8787～8804 任一端口上跑着，它直接用那个端口，不会重复启动。
- 手动内存优化：`DeepSeekLauncher.exe --trim`。它只把工作集页挪到 standby（实测 43.9→0.0 MB），**私有提交不变**（290.4 MB），所以别指望它降低实际占用峰值，只是让内存条歇一会儿。
- **安装包**：`installer/deepseek-local.iss` + Inno Setup 6（`ISCC.exe` 在 `%LOCALAPPDATA%\Programs\Inno Setup 6\`）。编译命令：
  ```powershell
  & "$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe" installer\deepseek-local.iss
  ```
  产物 `dist/installer/DeepSeekLocal-Setup-1.0.2.exe`（约 105 MB，按当前用户装、免管理员，默认目录 `%LOCALAPPDATA%\Programs\DeepSeekLocal`）。
- 打包前记得：`dist/DeepSeek-win32-x64/data` 是指向仓库 `data/` 的 junction（装着你的会话数据），`.iss` 里用 `Excludes: "data,data\*"` 排除它；`dist/DeepSeek-win32-x64/locales` 只留 `en-US/zh-CN/zh-TW.pak` 能省 47 MB。
- 安装后数据在 `%LOCALAPPDATA%\DeepSeekLocal\data`，第一次启动是空会话列表；卸载**不会**删这个目录（用户数据留着）。
- 装的时候需要写桌面快捷方式和 `HKCU` 卸载键，必须用你自己的账户在资源管理器里双击安装包；在沙箱化/受限令牌的进程里跑会以 `0x80070005 拒绝访问` 回滚（详见日志 `%TEMP%\*.log`）。

## 我自己怎么说话（2026-11-25 加）

群学习看的是「一群人怎么说话」，这一层只看一个人：**你**在网页里打的字、QQ 上发来的消息。

- 量什么：一条消息多少字、小句中位、≤8 字短句占比、语气词密度、省略主语比例、不写句末标点比例、问句占比、平均情绪、常挂嘴边的词（整句重复 + 小句开头 + 小句收尾）、习惯怎么开头、常出没时段、图片数。
- 数据落 `data/user-learn/profile.json`；`data/` 不出这台机器。
- 两个开关分开：学习页上的「对话里带上」= `meInject`（每轮把这段画像塞一条 system，默认关），「重新量一遍」= 强制重算并落盘。
- 接口：`GET /api/learn/me` 看摘要、`POST /api/learn/me/refresh` 重算。
- 口径：只收 `role === 'user'` 的消息；QQ 消息进库时套的「【来自 QQ 上的对方（uid），时间】」抬头和「【这条回在手机上】…」尾巴会先剥掉再量，不然量出来的是我们自己的提示词。
- 测试：`node tools/user-learn-test.mjs`（53 项）、`node tools/voice-style-test.mjs`（含 meInject 端到端 7 项）、`node tools/shot-learn-me.mjs`（拍学习页顶部那块）。
