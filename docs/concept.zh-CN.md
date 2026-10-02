# 协作便签：共享注意力工作区

> 本文与 [DeepSeek Harness 版本](https://github.com/aprilxuMLC/dsh-collaborative-notes)（0.1.1）共享，内容未改动。文中关于 DSH 宿主的描述只适用于 DSH；本插件在 ChatGPT 桌面版上的宿主描述见[适配规范](chatgpt-desktop-adapter.zh-CN.md)。

Collaborative Notes 是 DeepSeek Harness 旁边的共享临时工作区。它让一件事可以离开当前对话主线，同时保留之后由人或 Agent 重新激活它的路径。

## 为什么是注意力，而不只是记忆

长程协作的问题不只是“以后还能不能找到”，还包括“现在是否还应该持续关注”。把所有可能有用的东西都留在主线会造成注意力稀释；把东西随手移走又可能丢失它为什么重要以及从哪里来。

Notes 因此把注意力释放和重新激活分开处理：可靠放置后的内容可以暂时退出当前工作集；需要时，用户或当前任务可以沿着明确的来源关系把它带回。

这不是通用笔记本、项目管理器、全局记忆、知识库、优先级队列或工作流引擎。它保存的是过程状态和后续处理候选，不能把候选状态静默升级为正式知识、规则或已完成工作。

## 四个语义 lane

| lane | 语义 |
|---|---|
| L1 `conversation_todo` | 当前会话仍需回来处理的事项的共享表示 |
| L2 `deferred_work` | 值得以后做、但不应打断当前主线的工作 |
| L3 `knowledge_candidate` | 以后值得核验、整理并正式沉淀的知识素材 |
| L4 `lesson_candidate` | 以后值得复盘、可能影响规则或工作方式的经验候选 |

L1 不是当前 Agent 所有责任的完整登记册；没有 L1 Note 不等于没有责任。L1–L4 是语义分类，不是优先级、执行顺序或可信度排序。

## 捕获与后续处理

默认捕获由用户发起或接受。Agent 可以提出建议，也可以在用户决定捕获后帮助整理措辞，但建议本身不是保存。捕获不要求先完成总结、核验、合并、发布或下游执行；不同的捕获也不会因为相似而被静默去重、合并或重排。

一条普通 Note 可以没有历史 Source。若 Note 依赖具体对话内容，则保存的 Note 正文、capture 时接受的 Source snapshot、以及指向原始消息的 Source Anchor 必须保持可区分。编辑 Note 正文不会偷偷改写已建立的历史 Source。

当前 DSH 选定文本 profile 的支持范围是同一条普通、可选择的 user 或 assistant message。跨不同消息的选择必须如实失败，不能静默选一条、丢掉另一条、猜测或降级成无来源 Note。这是当前 host/profile 的临时边界，不删除 Core 对有序多消息语义的支持。

## 来源与重新激活

“回来源”先使用持久化的 Source relationship 确认原始消息，再在已经确认的消息内使用保存的文本构造提示。不能跨消息搜索相似文本来重新绑定 Source。若 exact span 无法机械重建，可以使用清楚标注为 broader/non-exact 的消息级提示；不能把更宽的提示冒充历史精确选区。

Source 可读性不等于修改、删除、关闭、执行或 formalization 权限。跨会话读取需要当前请求中的明确、有限授权，不会建立持续扫描所有会话的权限。

## Fork、维护与清理

Fork 的 carry 是一次明确的用户选择。Child 中的 Note 是独立演化的 holder-local state；编辑、关闭、删除、Pin 或历史 Source 不会因为 carry 自动跨分支传播。搜索、排序、置顶、编辑和删除是注意力管理能力，不改变 Source identity 或 Agent authority。

“已经处理”不等于“已经删除”。永久删除仍然需要用户授权；Notes 也不应成为无限积累的垃圾桶。

## 当前假设

Collaborative Notes 仍然是一项需要继续验证的协作设计：它是否降低注意力负担、帮助用户保留主线连续性、并在不同 host 上稳定恢复真实来源，属于产品假设而非已证明的普适结论。未来 host 可以提供更强的 profile，但必须明确 authority、来源、失败和跨会话边界。
