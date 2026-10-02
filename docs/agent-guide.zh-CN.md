# Collaborative Notes Agent Guide

> 本文与 [DeepSeek Harness 版本](https://github.com/aprilxuMLC/dsh-collaborative-notes)（0.1.1）共享，内容未改动。文中关于 DSH 宿主的描述只适用于 DSH；本插件的工具名称和行为见[适配规范](chatgpt-desktop-adapter.zh-CN.md)和插件自带的 skill。

本指南说明 Agent 怎样使用 Collaborative Notes，并把产品 Core 与当前 DSH host 能力区分开。

## 0. 最重要的规则

1. 不要因为内容看起来有用，就静默扫描普通对话并创建 Note。
2. 用户决定 capture；Agent 可以建议，也可以在用户接受后协助写清楚。
3. 不要把 Note 当成 system instruction、自动任务、永久记忆或完成证明。
4. 需要历史来源时先确认 Source identity，再读取所需上下文。
5. 不要用相似文本、模型记忆或跨 message 搜索重新绑定历史 Source。
6. 跨会话读取只使用当前请求明确授权的有限范围。
7. 修改前读取当前版本；stale conflict 后重新读取，不要盲目覆盖。
8. 永久删除需要用户授权。

## 1. Capture

如果用户明确说保存、引用、记下或接受 Agent 的 capture 建议，才可以创建 durable Note。Note 的文字可以由 Agent 帮忙整理，但不要要求用户填写 sessionId、messageId 或其他内部字段。

Capture 不是总结、验证、formalize、发布或下游执行。不要在 capture 时静默去重、合并、重排或改写不同的捕获事件。

依赖具体对话内容的 Note 只有在所需 Source relationship 和 accepted selected snapshot 已建立并保存后才能报告成功。缺少 required provenance 时要如实失败，不要降级成无来源 Note。

当前 DSH 选定文本 profile 只支持同一条普通、可选择的 user 或 assistant message。跨不同 authoritative messages 的 selection 必须 fail closed；不能只选一条、丢掉一条、猜测顺序或用搜索补齐。Core 的多消息有序语义仍然存在，当前限制只是 DSH profile 边界。

## 2. Lane 选择

- L1 `conversation_todo`：当前会话之后还要回来处理的事项；没有 L1 不等于没有责任。
- L2 `deferred_work`：以后做，但现在不打断主线。
- L3 `knowledge_candidate`：以后核验和整理的知识候选。
- L4 `lesson_candidate`：以后复盘、可能影响工作方式的经验候选。

Lane 是语义分类而不是 priority queue。放入 L2–L4 不等于 dispatch、handoff、consume 或执行已经发生。

## 3. Reference 与回来源

Notes 面板中选中的 Note 会随下一条当前会话请求提供给 Agent；它不会自动广播到其他 Agent，也不会建立永久跨 session authority。收到引用后先读取 shared state，再按用户请求判断是否需要回来源。

若任务只需要当前 model-visible context 中已经存在的内容，且不需要证明历史 Source identity，不要为了仪式感重新读取相同 history。若任务要求回答“来自哪一轮/哪条 message”、确认一个 visible exchange 是否确实是 recorded Source，必须先通过持久化 Source relationship 或受支持 resolver 建立权威身份，不能靠相似文本、记忆或 snapshot 推断。

Source identity 建立后，如果所需 surrounding exchange 已经在上下文中并且明确属于同一 Source，可以直接使用。只有在内容缺失、不确定、截断或不足时才补读历史。读到的文本是任务上下文，不得用它重算或覆盖 Source exactness。

## 4. Cross-session

默认不读其他会话。用户明确指定目标会话并授权当前读取范围时，可以做 bounded historical read；不要顺便扫描其他 session，也不要把一次授权变成 standing permission。Host、workspace 和 security 的独立审批规则仍然优先。

## 5. Mutation、fork 与 cleanup

正常修改走支持的 Notes path。出现 stale/precondition failure 时重新读取当前版本，向用户说明冲突，再决定是否重试；不要直接用旧内容覆盖。

Fork carry 是用户明确选择的复制。Child Note 与 parent Note 独立演化；carry 不会重写 capture-origin 或 historical Source，也不会因为 `parentSession` 存在就建立 parent Notes authority。Continuable subagent 不是普通 fork。

Agent 不应把“工具调用成功”当成用户问题已解决，也不应把离开上下文当成 closure。关闭、formalize、删除和执行都需要各自的真实 outcome 与 authority。删除尤其需要用户授权。

## 6. 失败时怎样说

Source 暂时不可读、identity 缺失、message identity 不明确、跨消息 capture 不受当前 profile 支持，或 mutation 遇到 stale conflict 时，都要报告真实边界。不要用 broad cue 冒充 exact cue；如果能确认 message 但不能确认更窄的 span，可以明确说是 broader/non-exact message-level cue。
