# Collaborative Notes — ChatGPT 桌面版适配规范

[English](chatgpt-desktop-adapter.md) | **中文**

> **版本：** 0.8.9 · 在 macOS（ChatGPT 26.908.70816、26.928.31416）和 Windows（ChatGPT 26.930.2377.0）上验证。
>
> **范围：** 本插件如何在 ChatGPT 桌面版的 **Codex** 模式，以及**在用户电脑上运行的 Work** 对话上实现 Collaborative Notes [Core Contract](core-contract.md)。这是本版本的宿主描述（host profile）；产品语义以 Core Contract、[Agent 指南](agent-guide.zh-CN.md) 和[概念](concept.zh-CN.md)为准。观察到的宿主事实见 [Codex](codex/capability-map.md) 和 [Work](work/capability-map.md) 能力图（英文）。

## 1. 宿主界面

- **Codex 对话：** 每个对话是一个 Codex thread，有稳定的 thread id、项目文件夹（`cwd`），以及可以通过 `codex app-server` 读取的条目历史。
- **“在你电脑上运行”的 Work 对话：** 同样是 Codex thread，只是 thread 的 `originator` 是 `codex_work_desktop`（Codex 对话是 `Codex Desktop`）。同一套代码同时支持两者。
- **不在范围内：** 云端 Work 对话、从普通 Chat 分支出来的 Work 对话、普通 Chat、网页版、手机版——它们都没有本地 thread、hooks 或插件工具。
- **平台：** macOS 和 Windows。同一套代码；Windows 特有的部分只限于进程启动、可执行文件查找和面板 deeplink（§10）。

## 2. 组成部分

| 部分 | 作用 |
|---|---|
| **Skill**（`skills/collab-notes`） | Agent 操作规则：用户主导记录、如实报告完成情况、不删除、修改后提示刷新、回到来源、局部性 |
| **Hooks**（`SessionStart`、`UserPromptSubmit`） | 在桌面会话里打开便签面板；把勾选的便签附到下一条消息；关掉的面板在之后的消息时重新打开 |
| **MCP 服务**（`collab_notes`） | Agent 工具：`notes-read`、`notes-write`、`notes-edit`、`notes-source-reentry`、`notes-open-panel` |
| **本地服务** | 每个用户数据目录一个，只绑定 `127.0.0.1`：提供面板和接口、核对引用、维护每个对话的历史缓存、运行分支检测、升级后交接给最新安装 |
| **面板** | 桌面侧栏浏览器标签里的页面：分道、编辑区、引用视图、回到来源、继承、搜索、帮助（英文 / 简体中文） |

运行环境：桌面版自带的 Node.js，只用标准库；通过自带的 `codex` 访问 app-server。

## 3. 身份与存储

- **Holder（所属对话）：** Codex thread id，机械绑定：来自 hook 的 session id、MCP 调用的 `_meta.threadId`、面板 URL 路径。Agent 从不提供 holder。
- **项目：** thread 的 `cwd`。每个项目一次性设置，绑定一个便签根目录（默认 `<项目>/notes`；Decision 64）。配置的根目录缺失时如实报告，绝不重新创建。
- **布局：** `<根目录>/<分道>/<threadId>.md`，分道为 `conversation_todo`、`deferred_work`、`knowledge_candidate`、`lesson_candidate`。
- **格式：** `dsh-note v1` 块，与 DSH 版本相同，加一行 `dsh-meta host: codex`。
- **插件数据：** `~/.codex/plugins/data/<插件>-<市场>/`：绑定、分道配置、每个对话的勾选和偏好、服务记录与密钥、分支检测记录。便签内容只保存在便签根目录，唯一的例外是：附到某条消息上的便签文字（包括其中引用的原文）会随该轮的记录保存，使该轮在 24 小时内重试时得到相同内容；这些副本 24 小时后从磁盘清除，删除便签本身时不会立即清除。卸载插件不会删除这个目录，需要时可以手动删除。

## 4. 来源捕获（Core §§2, 5；Decision 44）

- **方式：** 引用在面板里进行，面板中的对话镜像按准确的条目 id 从 app-server 构建；不会产生对话轮次。
- **来源身份：** 用户或助手消息的 `{sessionId: threadId, messageId: itemId}`。`S` 是在面板渲染器里选中的可见文字，渲染器的文本投影与服务端对该条目的投影一致。
- **核对：** 服务直接读取该条目（不经过缓存），要求 `S` 是其可见文字的字面子串。跨消息的选区直接失败（fail closed）。思考过程、工具调用和文件修改不能引用。
- **导航不等于身份：** 引用视图先显示最近几轮（“加载更早的 20 轮”），并通过每个对话的缓存搜索整个对话（忽略空白和大小写）；粘贴从对话里复制的文字可以跳到对应的一轮。搜索和粘贴只负责定位，保存的引用永远是用户自己选中的原文。

## 5. 回到来源（Core §§5, 8）

- **人：** “↪ 回到来源”显示来源消息，高亮其中 `S` 的每一处字面匹配，可按需展开前后几轮。来源消息总是直接读取；缓存只提供上下文。来源可读但没有字面匹配时标为“不精确”；来源读不到时如实报告“不可用”，保留快照。另一个对话里的来源需要在面板里按次确认。
- **Agent：** `notes-source-reentry` 返回 `source: resolved | unavailable | unauthorized` 和 `match: exact | not-located`、来源消息，以及由 agent 决定、每侧最多 30 轮的上下文；用户明确要求往前或往后多读时，`before` / `after` 可以取任意轮数，`hasEarlier` / `hasLater` 表示是否还有更多。带 `thread` 参数时，可以只读地回到用户点名的另一个对话里那条便签的来源。
- 绝不为来源搜索相似段落，也绝不重新绑定来源。

## 6. 把便签带给 Agent（Core §8）

- 勾选的便签组成每个对话的选择集，由服务保存。`UserPromptSubmit` hook 把它们作为附加上下文附上，并标明是协作资料而不是指令。
- 附加失败时，消息被拦下，勾选保留；没有勾选时，便签出问题从不阻挡消息。
- Codex 没有轮次结束后的 hook，所以送达在该轮出现在对话里时确认；在那之前面板显示“正在附加…”，如果这一轮一直没出现，就恢复选择。按轮次幂等，服务重启后依然有效。

## 7. Agent 操作与局部性（Core §§2, 6）

- `notes-read` 读取；`notes-write` 只创建普通便签；`notes-edit` 修改正文，需要预期版本号。没有删除工具，也没有来源捕获工具。修改后，agent 的回复以刷新提示开头。
- **其它对话：** `notes-read {thread}` 和 `notes-source-reentry {thread}`，只用于用户在本次请求中点名的对话；结果只读，不产生长期权限。授权是行为层面的（skill 和工具约定），Core §6 把这一点留给适配实现。

## 8. 并发与完整性（Core §4）

- **受支持的修改路径：** 面板（经本地服务）和 MCP 工具。两者都走同一个写入器：分道版本号（SHA-256 比较并交换）、跨进程分道锁（只能从已退出的持有者那里接管，且接管时持有单独的接管锁）、原子写入，并在重命名前再次核对。
- **“仍然覆盖”** 把用户的修改重新应用到最新的分道内容上，绝不写入过期内容。
- **删除** 只能在面板里进行，需要确认。
- **不受保护的路径：** 在 Files 标签、编辑器、终端或其它插件里直接修改分道文件，或用服务密钥直接调用本地 HTTP 接口，都会绕过这些保护，不受支持。

## 9. 分支与继承（Core §7）

- **检测：** 本地服务监视新创建的 Codex 会话文件，只读取第一行（元数据）。对于桌面端、用户发起的分支，如果项目已设置、父对话有便签、继承尚未决定，它会在几秒内打开该分支自己的便签，每个分支只打开一次。`CN_FORK_WATCH=0` 可关闭检测。
- **宿主行为：** Codex 会把父对话的标签页复制进分支。父对话的面板会显示“刚从这个对话分出了分支…”，并提供按钮把这个标签切换到分支自己的便签，以及返回的入口。
- **决定：** 全部 / 部分 / 都不；已有内容的分道询问合并 / 保留 / 替换，并显示预览。
- **资格：** 来源条目在子对话历史里 → 保留；只在父对话历史里（分支点之后）→ 不带入；无法比较或没有来源 → 保留。带入的便签获得新的 key，之后各自独立。
- **持久性：** 写入每个分道之前，继承记录先写下该分道计划的子对话 key 和写入后的版本；重试时，已经包含这些内容的分道视为已完成，不会重复。

## 10. 生命周期与容错

- **面板入口：** 启动和恢复时自动打开；用侧栏开关收起或显示；如果 5 分钟内没有便签页面签到，下一条消息会重新打开；也可按需打开（`notes-open-panel`）。
- **面板访问：** 每个对话一个 HMAC token，换成持久的 `HttpOnly`、`SameSite=Strict` cookie，所以重启后恢复的标签页仍然可用。
- **升级：** 升级删除旧安装后，旧服务会在同一端口和数据目录上启动最新的安装；子进程从用户主目录启动，因为 `codex app-server` 在已删除的工作目录里无法运行。服务版本变化时，打开的页面会自动重新载入。
- **运行时查找：**
  - macOS：MCP 通过 `/bin/sh`（`server/launch-mcp`）启动，优先使用自带的 Node；hooks 使用 `CODEX_MCP_NODE_PATH`；app-server 使用自带的 `codex`（兼容两种已知的目录布局）。
  - Windows：Codex 把 MCP 命令解析为 `server/launch-mcp.cmd`；MCP 和 hooks 都经 `server/node-run.cmd` 运行，它会找到 ChatGPT 复制到 `%LOCALAPPDATA%\OpenAI\Codex` 下的 Node。hooks 在会话的 shell（PowerShell）里运行，所以 hook 命令以 `cmd /d /c call` 开头。app-server 使用 `%LOCALAPPDATA%\OpenAI\Codex` 下最新的 `codex.exe`；在 `PATH` 上只接受真正的 `codex.exe`。后台进程隐藏窗口启动，且不以插件文件夹为当前目录，所以 ChatGPT 运行时也能更新插件。
- **面板 deeplink：** macOS 用 `codex://browser?url=…`；Windows 用 `codex://threads/<id>?browserUrl=…`，因为在 Windows 上单独的 browser 链接没有反应。
- **历史缓存：** 最多 3 个对话，闲置 10 分钟后清除，增量补充；对话被回退（rewind）时丢弃过期的轮次。

## 11. 数据访问声明

只读取：项目的便签根目录；插件自己的数据目录和安装文件（面板资源、manifest）；在设置时浏览便签位置时，你打开的文件夹的列表，以及你要求新建的文件夹；通过自带 `codex app-server` 只读地读取 Codex 对话数据；新建 Codex 会话文件的第一行（用于检测分支）；`~/.codex/config.toml`（界面语言）；对话记录的第一行（区分桌面会话和 CLI 会话）；Windows 上还读取 `%LOCALAPPDATA%\OpenAI\Codex` 下的文件列表（找到 ChatGPT 的 Node 和 `codex.exe`），以及只在旧服务没有响应时，读取该进程的命令行，确认它是本插件的服务。

只写入：便签根目录、插件数据目录，以及设置时你要求新建的文件夹。

不向本机以外发送任何数据；服务只监听 `127.0.0.1`。

## 12. 已知限制

- 引用一次只能来自一条用户或助手消息。
- 勾选便签的送达是事后确认（宿主没有轮次结束后的 hook）。
- 跨对话授权是行为层面的，不是机械强制的。
- Windows 上，hook 信任也覆盖 Windows 命令：更新如果改动了它，hooks 会显示为已修改，直到用户再次信任。macOS 上只看 macOS 命令。
- 直接修改文件不受保护。
- 分支后复制标签页是宿主行为，插件做了绕过处理。
- 插件依赖观察到的桌面版行为（侧栏 deeplink、app-server 字段、会话文件元数据、标签页恢复），这些可能随应用版本变化。`node probes/codex/host-contract.mjs <threadId>` 在应用更新前后检查 app-server 的对话数据结构、自带的 codex 和 `codex://` URL scheme；侧栏打开、分支检测和标签页恢复需要在桌面版上人工检查。
