# Collaborative Notes（协作便签）for Codex & Work

[English](README.md) | **中文**

**让对话继续向前，让重要的事不被弄丢。**

协作便签就在 ChatGPT 桌面版 Codex 和 Work 对话的旁边。想法、问题、决定、还没收尾的事，都可以随手记下，而不把正在进行的对话带偏；等它们重要的时候再回来——一直回到它们出自的那段原文。

> **面向人机协作的共享注意力工作区：让一件事离开当前主线，却不离开协作。**

Collaborative Notes（协作便签）是一个面向 ChatGPT 桌面版 **Codex** 和 **Work** 模式的人机协作插件。它不是普通笔记本，也不是任务管理器、长期记忆或知识库。它在当前对话旁边增加一块**共享的临时工作区**，帮助人和 Agent 决定：什么现在应该继续占据注意力，什么可以安全放下；放下以后，又怎样在真正需要时准确地拿回来。

**0.8.7 版本**在 macOS（ChatGPT 26.928.31416）和 Windows（ChatGPT 26.930.2377.0）上验证，适用于 Codex 对话，以及在你电脑上运行的 Work 对话。

它延续 [Collaborative Notes for DeepSeek Harness](https://github.com/aprilxuMLC/dsh-collaborative-notes)，共享同一套产品契约；ChatGPT 桌面版上的具体实现见[适配规范](docs/chatgpt-desktop-adapter.zh-CN.md)。

---

# I. 它是什么，它为什么重要

### 对话是线性的，工作不是<br>
**Conversation is linear. Work is not.**

真实工作会不断产生旁支。东西一直留在对话里，主线会越来越重；东西随手扔进另一个笔记本，又容易丢掉“它当时为什么重要”。

Collaborative Notes 尝试提供第三种选择：

> **让一件事离开当前主线，但不离开协作。**

这背后不仅是一个记忆问题，也是一个注意力问题。

### 注意力稀释<br>
**Attention Dilution**

长程协作中，即使所有历史、文件、memory 和 Notes 都还存在，Agent 仍然会面对另一个问题：随着越来越多事项同时保持“可能相关”，此刻真正应该关心什么会越来越难判断。信息没有丢失，协作却未必更清晰；真正重要的约束可能被越来越多“也许有用”的状态稀释。

Collaborative Notes 尝试把**注意力本身也变成一种可以共同管理的资源**。当前真正需要的内容继续留在主线；其它内容一旦被可靠安置，就可以退出 Agent 的持续注意力，之后再由用户或当前任务重新带回前台。

这里利用了一种朴素的人机差异：人不需要把所有事项持续塞进 active context。一个容易浏览的共享工作面可以提供成本很低的外围注意力——看一眼、置顶、勾选，或者说一句“把这个拿回来”。Agent 则在需要时沿明确入口重新读取和恢复上下文。

> **人类的低成本外围注意力 + Agent 的按需重新激活。**

它能否在不同用户和长程任务中稳定降低认知负担、提高任务质量，目前仍是需要继续验证的产品假设。

### 记忆不等于注意力<br>
**Memory ≠ Attention**

“以后还能找到”和“现在还应该持续关注”不是同一个问题。Collaborative Notes 允许已经可靠安置的事情不再占据持续注意力：延后工作、知识候选和复盘素材可以退出主线，而不是永远跟着对话往前走。

> **还存在，不等于现在优先。**

安全放下只有一半，另一半是以后真的还能回来。对于来自具体对话内容的 Note，Collaborative Notes 保留它和原始讨论之间的来源关系；重新处理时可以回到真正的 source，而不是靠全文搜索或模型猜测找一个“差不多在这里”的位置。

> **释放注意力，不等于丢失返回原始语境的路径。**

它不要求当前 Agent 在记录时预测未来所有的上下文需求。未来有读取权限的 Agent 或工作流，可以先读 Note，再沿保存的来源回到原始讨论，按自己的任务补读足够的上下文。

> **保存未来上下文的把手，而不是预先打包未来上下文。**

所以 Collaborative Notes 刻意保持一个小核心：capture、暂存、路由、provenance 和 reactivation；真正的后续加工由不同的消费者完成：

| 便签 | 未来消费者 | 后续工作 |
|---|---|---|
| **L2 延后工作** | BACKLOG / 工作规划 Agent | 排序、合并、安排、执行 |
| **L3 知识候选** | 知识整理 Agent / Workflow | 核验、去重、重组、正式沉淀 |
| **L4 复盘素材** | 复盘 / Agent improvement Workflow | 复盘、验证、接受，再决定是否改变 Rule / Skill / Prompt / Workflow |

> **候选状态，不是正式状态。**一条东西被记下来，只说明它值得以后处理，并不说明处理已经发生。

默认的协作方式是**用户主导记录，人和 Agent 协作维护**。Agent 可以帮你把决定要记的东西写清楚，也可以建议“要不要记一条”，但建议本身不是记录；它不会扫描普通对话大量挖掘便签，也不会在记录时去重或合并。便签**默认只在本对话内**：其它对话的便签，只有你在这次请求里点名那个对话时，才会进入当前 Agent 的工作。

> **默认局部，需要时明确取用。**

---

# II. 现在能做什么

## 能力速览

- **静默记录。** 写便签、引用原文都不会产生对话轮次，agent 不会被打断，甚至察觉不到。
- **四条分道**：L1 会话待办 · L2 延后工作 · L3 知识候选 · L4 复盘素材。分道表示去处，不表示优先级；L1 仍属于本对话的责任，L2–L4 可以真正离开主线。
- **精确来源。** 把对话里的一段原文引用进便签：便签分别保存你写的正文、当时选中的原文，以及来源消息的身份。
- **↪ 回到来源。** 显示原来那一轮，准确高亮当时选中的文字，并可按需展开前后几轮。来源绝不靠搜索去猜：读不到就如实说明，不会绑到一段相似的文字上。
- **在对话里找到任何内容，哪怕是很早以前的。** 引用视图先显示最近几轮，并能搜索**整个**对话——包括已经被压缩、agent 不再记得的部分；还可以从 Codex 对话里复制一段文字，粘贴后直接跳到那里。这也顺手补上了宿主的一个缺口：Codex 本身无法在长对话里准确搜索某一段原文。
- **由你决定何时带回。** 勾选便签，下一条消息会把它们作为参考资料（而不是指令）交给 agent。
- **和你的 agent 一起处理便签。** 你可以让 agent 帮你写一条便签或修改便签，问它便签里写了什么，或者直接和它讨论这些便签——既可以是本对话的便签，也可以是你点名的另一个对话的便签（只读）。agent 能沿便签回到来源，读取前后的讨论，所以讨论从当时实际说过的话出发，而不是从一段摘要出发。跨对话回到来源比 DSH 版本更强。
- **任何 agent、任何对话、任何工作流都能使用便签，作为后续工作的素材。** 每条便签把三样东西放在一起：
  - 你自己的思考（便签正文）；
  - 它产生于哪个对话；
  - 引用的便签还带着引发这次思考的那句原话。

  便签是格式公开的普通文件，任何 agent 或工作流之后都能拿来用，并按任务需要从来源找回足够的上下文，进一步扩展。例如：
  - 用 L3 知识候选和它们背后的讨论建立知识库；
  - 把 L4 复盘素材整理成 agent 自我进化的长期经验 / 教训记忆；
  - 把 L2 延后工作带进之后的规划。

  L3 和 L4 只是候选：要经过你自己的审阅，才成为知识或教训。见[第 IV 部分](#iv-给下游-agent-和工作流)。
- **分支。** 分支（fork）后，几秒内新对话自己的便签会打开，问你要把父对话的便签全部、部分还是都不带过来；来源在分支点之后的便签不会带入，之后两边各自独立。
- **维护。** 搜索、排序、置顶、编辑、确认后删除。只有你能删除。
- **中英双语。** 面板跟随应用语言（English / 简体中文）。

## 用起来是什么样

- **让 agent 帮你记一条。** “记到 L2：发布之后再看看缓存那个想法。”刷新便签后，它就出现在 L2 里。
- **问另一个对话的便签。** “我在讨论定价模型的那个对话里，L3 记了什么？带我回到它的出处。”agent 只读地读取那个对话的便签，并打开来源处的讨论。
- **现在就讨论选中的便签。** 勾选你想处理的两条便签，再写“我们来逐条过一下”。这条消息会把它们带给 agent。
- **在分支里换个角度讨论。** 分支（fork）这个对话，只带过去一部分便签；分支沿新的方向展开，原对话继续它自己的进程。
- **找一条便签。** 在便签面板里用便签中的任何词搜索。
- **引用很早以前的话。** 打开 **从对话引用**，搜索你记得的一个词——哪怕那部分 agent 早已不在上下文里。展开那一轮，选中准确的那句话，引用进便签。
- **一起回到来源。** “回到那条便签的来源，提醒我当时围绕它定了什么。”agent 会读取原来那一轮和前后几轮。
- **在专门建立知识库的工作流里使用。** 在为这件事开的对话里说：“把这个项目里所有关于注意力的便签想法找出来，连同它们引用的原话和前后的讨论，整理成知识库条目草稿给我审阅。”agent 直接读取便签文件，并沿每条便签的来源回到原来的对话。

---

# III. 安装、第一次使用与支持范围

## 安装

需要：带 Codex 或 Work 的 ChatGPT 桌面版，以及 git。

### macOS

如果 Mac 上没有 git，先在“终端”里运行一次 `xcode-select --install`，安装 Apple 的 Command Line Tools。

在“终端”里运行：

```sh
CODEX=/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex
[ -x "$CODEX" ] || CODEX=/Applications/ChatGPT.app/Contents/Resources/codex   # 旧版应用的位置
"$CODEX" plugin marketplace add aprilxuMLC/codex-work-collaborative-notes
"$CODEX" plugin add collaborative-notes@collaborative-notes
```

### Windows

如果没有 git，先安装 [Git for Windows](https://git-scm.com/download/win)，或者用下面的 ZIP 方式。

在 PowerShell 里运行（普通窗口即可，不需要管理员权限）：

```powershell
$CODEX = (Get-ChildItem "$env:LOCALAPPDATA\OpenAI\Codex\bin" -Recurse -Filter codex.exe | Sort-Object LastWriteTime -Descending | Select-Object -First 1).FullName
& $CODEX plugin marketplace add aprilxuMLC/codex-work-collaborative-notes
& $CODEX plugin add collaborative-notes@collaborative-notes
```

最新的那个 `codex.exe` 才与你的 ChatGPT 匹配；旁边可能还有一个旧的副本，用它会报“failed to load configuration”。

### 然后（两个系统相同）

这些命令用的是 ChatGPT 自带的 codex，不需要另外安装任何东西。

1. 完全退出 ChatGPT（macOS 用 ⌘Q；Windows 如果托盘里有图标，也从托盘退出）再重新打开。
2. **信任 hooks：** ChatGPT → 设置 → Coding → Hooks → Collaborative Notes → 信任两个 hook。Codex 只在你信任后才运行插件 hook；如果某次更新改动了 hook（hook 会显示为已修改），需要再信任一次。
3. **再完全退出并重新打开一次 ChatGPT。** 信任在启动时才生效；在那之前，便签不会自动打开，面板上会显示“自动功能已关闭”的提示。

其它安装方式：
- **没有 git：** 把本仓库下载为 ZIP 并解压，在 `marketplace add` 里用解压后的文件夹路径代替 GitHub 名称。
- **让 Codex 帮你装：** 请它严格只运行上面的命令，出错就停下报告，不要安装其他软件，也不要手动修改 `~/.codex`。信任 hooks 仍然要你自己完成。Windows 上请自己在 PowerShell 里运行：Codex 的沙箱不能写入插件文件夹。

**更新：** 用你的 `$CODEX` 运行 `plugin marketplace upgrade`（macOS：`"$CODEX" plugin marketplace upgrade`；Windows：`& $CODEX plugin marketplace upgrade`），再运行一次 `plugin add` 那条命令，然后重启 ChatGPT。如果这次更新改动了 hook，需要再信任一次并再重启一次。更新后如果便签没有自动打开，请完全退出 ChatGPT 再重新打开。便签和设置都会保留。

**卸载：** 用你的 `$CODEX` 运行 `plugin remove collaborative-notes@collaborative-notes` 和 `plugin marketplace remove collaborative-notes`，然后重启 ChatGPT。便签仍保留在你的项目文件夹里；插件自己的数据（绑定、勾选、设置）在 `~/.codex/plugins/data/collaborative-notes-collaborative-notes/`（Windows 上是 `%USERPROFILE%\.codex\plugins\data\collaborative-notes-collaborative-notes\`），不需要时可以手动删除这个文件夹。

## 第一次使用

1. 在一个项目里打开 **Codex** 对话，或一个**在你电脑上运行**的 **Work** 对话（"Where should this chat run?" → On your computer），发送一条消息。**便签**面板会在侧栏里自动打开。
2. 在新项目里：确认四条分道的名称；选择便签存放位置（默认 `<项目>/notes`，也可以选别的文件夹）。如果 `<项目>/notes` 里已经有协作便签（例如来自 DSH 插件），设置时可以选择继续使用；其它位置里不能已经有便签；想继续用放在别处的便签，请在设置前把那个文件夹移到 `<项目>/notes`。
3. 写一条便签，或者点**从对话引用**：找到那一轮（最近的、搜索，或粘贴你复制的文字），准确选中原文，**将选中文本引用到便签**。
4. 对 agent 说：“把这个记到 L2”、“我 L3 那条便签写了什么”、“回到那条便签的来源”、“看一下关于 X 的那个对话的 L1 便签”。每次修改后，它的第一句话会是“已经更新，请刷新查看。”

用侧栏开关收起或显示侧栏（macOS 上是 ⌥⌘B，或菜单里的“隐藏/显示侧边面板”；Windows 上是 Ctrl+Alt+B），便签标签页会一直保留。如果关掉了标签，关掉约 5 分钟后你发下一条消息时会自动重新打开；也可以对 agent 说“打开便签”。面板里的 **?** 有上面这些的完整说明。

| 不信任 hooks 也能用 | 需要信任 hooks |
|---|---|
| 面板功能、agent 的便签操作、按需打开面板 | 自动打开面板、把勾选的便签附到下一条消息 |

## 支持范围

**支持：** macOS 和 Windows；Codex 对话；在你电脑上运行的 Work 对话。

**不支持：** 在云端运行的 Work 对话，以及从普通 Chat 分支出来的 Work 对话（也是云端）——便签需要你的电脑；普通 Chat、ChatGPT 网页版、手机版；Linux，以及在 WSL 里运行的 Windows 对话（未测试）。

**需要知道的事：**
- 引用范围是单条用户消息或助手消息内的文字；思考过程、工具调用和文件修改不能引用。
- 分支时，Codex 会把父对话的标签页也复制到新对话里。请使用标题显示新对话名称的那个便签页；父对话的那份里有“打开分支的便签”按钮。
- 勾选的便签如果附加失败，那条消息会被拦下，勾选保留。除此之外，便签出问题从不阻挡你的对话。
- 更新插件后请重启 ChatGPT；在那之前，已经打开的对话仍使用旧版本的 agent 工具。
- 在 Files 标签、编辑器或终端里直接修改分道文件，会绕过便签的保护，不受支持。
- 删除是永久的，没有回收站。便签是你项目里的普通文件，不加密，也不同步。
- 插件依赖观察到的桌面版行为（侧栏 deeplink、app-server 字段、用于检测分支的会话文件元数据、标签页恢复），这些可能随应用版本变化。详见能力图。

---

# IV. 给下游 agent 和工作流

便签是普通的 Markdown 文件，每个分道、每个对话一个文件：

```text
<便签根目录>/<分道>/<threadId>.md
分道 ∈ conversation_todo | deferred_work | knowledge_candidate | lesson_candidate
```

每条便签是一个独立的 `dsh-note v1` 块，格式与 DSH 插件相同，包含：`dsh-meta kind`（`source-independent` | `source-aware`）、`origin`（记录时所在的对话）、`host: codex`、内部的 `item-key`、带引用的便签还有 `source-payload` `{"sessionId": <threadId>, "messageId": <Codex item id>}` 以及当时选中的原文，最后是便签正文。

要恢复一条便签的上下文，通过 Codex app-server（`codex app-server`：`thread/items/list`、`thread/turns/list`）解析 `threadId + messageId`，再按任务需要读取前后的对话。L3 和 L4 只是候选，只有经过你自己明确的审阅才能升级为正式内容。

---

# V. 设计文档与开发

| 文档 | 什么时候读 |
|---|---|
| [Concept（概念）](docs/concept.zh-CN.md) | 想理解背后的想法：记忆与注意力、注意力稀释、暂存、provenance、下游工作流 |
| [Core Contract（核心契约）](docs/core-contract.md) *（英文）* | 想知道任何宿主都必须保持的稳定产品语义 |
| [Agent Guide（Agent 指南）](docs/agent-guide.zh-CN.md) | 想知道 agent 应该怎样使用便签、哪些事不能做 |
| [ChatGPT 桌面版适配规范](docs/chatgpt-desktop-adapter.zh-CN.md)（[English](docs/chatgpt-desktop-adapter.md)） | 想知道本插件在 Codex 和 Work 上怎样实现这份契约、有哪些声明和边界 |
| [Codex 能力图](docs/codex/capability-map.md)、[Work 能力图](docs/work/capability-map.md) *（英文）* | 想看设计背后观察到的宿主事实 |
| [DSH 功能对照](docs/codex/dsh-parity.md) *（英文）* | 想逐项对比 DSH 版本的功能 |
| [CHANGELOG](CHANGELOG.md) *（英文）* | 想知道改了什么 |

Concept、Core Contract 和 Agent Guide 与 DSH 版本共享；其中关于 DSH 宿主的描述只适用于 DSH，本插件的宿主描述以适配规范为准。

**开发：** 运行环境是 ChatGPT 桌面版自带的 Node.js，只用标准库，没有 npm 依赖。测试：`node --test test/core/*.test.mjs test/service/*.test.mjs`。从本地克隆安装：把克隆的路径传给 `"$CODEX" plugin marketplace add`。

```text
plugins/collaborative-notes/   插件（manifest、skill、hooks、MCP 服务、本地服务、面板）
.agents/plugins/               插件市场定义
test/                          node:test 测试
docs/                          产品文档、适配规范、能力图
```

## 许可证

MIT，见 [LICENSE](LICENSE)。
