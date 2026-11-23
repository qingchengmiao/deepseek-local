# DeepSeek Local v1.0.2

发布日期：2026-11-23

把官方 App 的体验接到你自己的 DeepSeek API 上：界面照官方做，每一句话都由你自己的 Key 发出，对话记录只落在这台机器上。

这一版的主题是 **QQ 通道真正独立**：不再跟 DSH 抢同一个 NapCat 实例、同一个号、同一个端口，并且有人值守——崩了自己回来，起来了会自己修配置。

## 下载

| 文件 | 体积 | SHA256 |
| --- | --- | --- |
| `DeepSeekLocal-Setup-1.0.2.exe` | 107.14 MB（112340666 字节） | `82e28b81c5b0d4816c6d0710910f182c68aa2f183beb215f5642b92872a7eead` |
| `DeepSeek-Local-1.0.2-source.zip` | 约 7.1 MB | 见 `SHA256SUMS.txt`（源码包里有 notes，算完才定得下来） |
| `DeepSeek-Local-1.0.2.bundle` | 约 4.4 MB | 见 `SHA256SUMS.txt`（bundle 里含这次提交，最后一次生成） |

Windows 10/11 x64。安装包按当前用户安装（`%LOCALAPPDATA%\Programs\DeepSeekLocal`），不需要管理员权限；桌面与开始菜单快捷方式指向原生启动器 `DeepSeekLauncher.exe`。**升级直接覆盖安装即可，`data/` 里的对话与设置不动。**

## 这一版改了什么

**1. QQ 通道独立实例（C++ 宿主 + Shell 副本）**

以前 DSH 的 qq-bridge 写死 `http://127.0.0.1:3000`，应用这边也打 3000，两边抢同一个 NapCat、同一个 QQ 号，消息随时被另一头取走。现在：

- 应用自带一份 Shell 副本（默认 `D:\NapCatDSL\Shell`，从 `D:\NapCatOneKey\NapCat.52230.Shell` 复制，原目录原样保留当备份），自己的号、自己的端口：OneBot `3200/3201`、WebUI `6209`
- `napcat/host.cpp` 编译成 `DSLNapCatHost.exe`（255 KB，纯 Win32 API，无第三方 DLL），命令 `status|start|stop|run|qr`，只有 `run` 是常驻看门狗
- 关键一步：`NapCatWinBootMain.exe` 会把多余参数转给 `QQ.exe`，所以宿主给它带 `--user-data-dir=<登录目录>`。不带的后果是 QQ 读系统共享的 `%APPDATA%\QQ`，一启动就快速登录原来那个号，**永远不弹二维码**
- QQ 页顶部新增「隔离实例（C++ 宿主）」卡片：启动 / 停止 / 刷新状态 / 看二维码 / 保存目录，对应 `GET /api/napcat/host`、`POST /api/napcat/host/start|stop`

**2. 长期托管：掉了自己回来**

- 计划任务 `DeepSeekLocal_NapCatHost`（登录时触发、延迟 30 秒、`ExecutionTimeLimit=0`、`MultipleInstances=IgnoreNew`）
- 入口是 `%LOCALAPPDATA%\DeepSeekLocal\napcat-host\host-run.vbs`，用 `WScript.Shell.Run(cmd, 0, True)` 循环跑宿主，**全程没有黑框**
- 退避 3→6→12→24→48→60 秒，连续失败 ≥6 次退到 10 分钟一轮；连续失败 ≥3 次把「连续起不来几次了」写进状态文件，≥6 次直接给出诊断：「可能是登录态被写坏（QQ 起来就退出），删掉登录目录后重新扫码」
- 宿主 `wmain` 一进来就把自己的控制台窗口隐藏，`NapCatWinBootMain.exe` 是 CUI、继承这个隐藏控制台，所以双击、计划任务、点按钮都不会闪窗

**3. 自动纠错 + 消息推送**

- 每 90 秒一轮自检：OneBot 配置缺了/端口不对就按模板重写并重启；连续失败 ≥4 次判定登录态坏了，把登录目录改名成 `login-broken-<时间>` 再建空目录、置 `needLogin`；在线时什么都不动
- `POST /api/napcat/heal` 可手动跑一次，`GET /api/napcat/heal` 看轮次与动作，日志 `data/napcat-heal.log`
- 推送：设置 → QQ 页「消息推送」卡，`POST /api/push`；关掉「允许主动推送」之后接口一律 **403**；推给谁按 body.uid → `pushUid` → `qqUid` 回落

**4. 回复风格三档**

设置里选「回复风格」：活人感（默认）/ 原生 / 自定义。活人感会额外注入一小段提示（先给判断、说具体数字、别段末总结、允许改口），但用户要清单、步骤、表格、代码时照给。实测同一句话，原生是四段加粗清单，活人感是一句判断加两个具体价格再反问。

**5. 「重启 / 刷新二维码」不再报「没找到启动器」**

隔离实例的 Shell 副本里没有 `.bat` 启动器，只有 `NapCatWinBootMain.exe`。UI 的重启现在认这种情况交给宿主拉起；而且**实例活着（已登录 / 端口通）时一次 stop 都不做**，只回一句「没动它」——强杀会写坏登录 profile，代价是重新扫码。

**6. 自适应临时设定并进同一条 system**

以前自适应调温那段「这一轮的临时设定」是单独一条 system，等于每次请求两条 system。现在并进开头那段 system 的末尾（开头没有 system 时才新建）。带工具、带风格一次请求也只有一条。

## 自测

- 全量回归 **790 通过 / 0 失败**：qq 35、context 97、route 49、tune 19、link 36、import-page 15、smoke 51、integration 54、calendar 48、media 23、model-fallback 15、model-pull 13、zip 25、import-preview 27、qq-bind 15、dom-check 114、dom-chat 30、dom-drop 16、hover-tip 13、chat-drop 11、selection-copy 12、app-check 12、lint 11、check-assets 10、test-md 39
- 本轮新增：`reply-style-test` 16 项、`napcat-hostpath-test` 14 项（用假宿主验「Shell 副本走宿主 / 活着跳过 / 挂了才重启」三条路）
- 真机：delta（`3810187208`）扫码登录、3200/3201/6209 全通、`/api/qq/send` 发消息返回 `message_id`；推送接口实测 `messageId 177342083`

## 已知限制

- QQ 的聊天数据根还在 `Documents\Tencent Files\<号>`，`--user-data-dir` 只管 Chromium profile 那一层。要连数据一起搬，得再改 QQ 的数据根，这一版没做
- 同一个号在别处登录会把这边踢下线（`[KickedOffLine]`），重新扫码即可
- 装好的实例不读 `PORT` 环境变量（主进程只在 8787 起扫端口），想换端口请从设置里改或同时只留一个实例
- 联网/深度思考依赖官方工具与你的额度；本机摘要模型拉不动时会回落 API
- QQ 真扫码这条链在 CI 里没法自动化，只能人工验；本版是人工验过的
