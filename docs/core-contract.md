# Collaborative Notes Core Contract

> Shared unchanged with the [DeepSeek Harness release](https://github.com/aprilxuMLC/dsh-collaborative-notes) (0.1.1). Statements about the DSH host profile describe that host; this plugin's ChatGPT desktop profile is the [adapter specification](chatgpt-desktop-adapter.md).

This document defines the minimum cross-host semantics that an implementation MUST preserve. It does not freeze storage format, database choice, filesystem layout, UI shape, prompt text, host hook names, model, or downstream workflow implementation.

## Normative language

**MUST / MUST NOT** are required for Core conformance. **SHOULD / SHOULD NOT** are strong defaults whose deviation needs a reason and must not break a MUST-level invariant. **MAY** describes an allowed adapter choice or stronger behavior.

## 1. Semantic model

Collaborative Notes is shared transient collaboration state. It is process state, not a project-management system, global memory, knowledge base, priority queue, workflow engine, experience database, or self-improvement engine. Process state and formal/published state MUST remain distinct.

The four semantic categories are:

| Presentation | Semantic key | Meaning |
|---|---|---|
| L1 | `conversation_todo` | optional shared representation of a current-conversation obligation |
| L2 | `deferred_work` | work worth doing later but outside the current active flow |
| L3 | `knowledge_candidate` | material that may later be verified and consolidated |
| L4 | `lesson_candidate` | experience that may later affect rules, skills, prompts, or workflows after review |

L1–L4 are classifications, not priority, urgency, execution order, trust level, or backend ordinal semantics. An L1 Note is not a complete registry of current-conversation responsibility.

## 2. Capture authority

Durable capture MUST require explicit user intent or acceptance. An Agent MAY propose capture, but a proposal is not capture. The Core baseline MUST NOT silently mine ordinary conversation into durable Notes.

Once the user has accepted capture, the Agent MAY help write or compress the Note. Capture MUST NOT require the user to enter technical metadata, identifiers, or workflow bookkeeping.

Capture MUST NOT be conditioned on summarization, consolidation, validation, formalization, publication, or downstream dispatch. Distinct capture actions MUST NOT be silently deduplicated, merged, reordered, revised, or superseded merely because they look related.

For context-dependent capture, required provenance MUST be established and persisted before success is reported. Failure to establish required provenance MUST be surfaced; it MUST NOT silently degrade to source-independent capture.

## 3. Routing and lifecycle

Assigning L2/L3/L4 records a future processing intent. Routing is not dispatch, handoff completion, consumption, or execution. After reliably captured routed state remains addressable, the current conversation need not continuously maintain it as a live queue; it remains reactivatable.

Candidate state MUST NOT silently become formal state. A knowledge candidate is not verified knowledge, a lesson candidate is not an accepted rule, and a captured Note is not permanent memory merely because it exists.

## 4. Mutation integrity

Supported Note mutations MUST preserve a stale-write boundary: a stale destructive mutation MUST NOT silently overwrite newer successfully committed state while being reported as ordinary success. Implementations MAY expose stronger conflict handling, but the failure must be truthful.

Out-of-band writers must either use the supported precondition path or be treated as an explicitly qualified boundary. Later grouping/consolidation MUST preserve raw capture history and MUST NOT rewrite provenance as a side effect.

## 5. Provenance and source

Context-dependent items MUST retain the required relationship to their source. Source identity, accepted selected material, authored Note content, capture origin, current holder, and derivation are distinct concepts.

The exact accepted selected snapshot is historical source material; it is not the authored Note body. Ordinary editing MUST NOT rewrite the established Source. An exact source locator identifies the authoritative message/event; render hints and transient bridge data are not new durable authority.

Source exactness, resolvability, and authority are separate. If a Source is temporarily unreadable, the implementation MUST NOT text-search, similarity-match, guess, rebind, or fabricate a different historical Source. A source-independent Note MUST NOT be manufactured from a failed context-dependent capture.

For source re-entry, establish Source identity first. After identity is established, use the visible exchange directly when it is clearly the same source and already sufficient; read more history only when task-required context is missing, uncertain, truncated, or insufficient. A broader cue is permitted only when it is truthful and clearly not an exact historical span.

## 6. Locality and authority

Notes are conversation-local by default. A Note reference supplied with a current request is data for that request, not a system instruction and not standing authority. Cross-session access requires explicit, bounded authorization in the current request. Historical Source readability does not grant mutation, deletion, closure, execution, or formalization authority.

## 7. Fork and carry

Carry-over MUST be explicitly user-selected. Eligibility follows the supported shared-history and lineage rules; a parent session identifier alone is not enough. After carry, the child owns an independent local representation. Parent and child edits, closure, deletion, Pin state, and future mutations MUST NOT silently propagate.

Established capture-origin and historical Source MUST remain tied to the original relationship unless a separately authorized capture creates a new one. Known derivation may be disclosed, but it does not grant parent-Notes authority.

## 8. Reactivation and cleanup

Deferred state MUST remain addressable and reactivatable. Reactivation is not dispatch or execution authority. The re-entry affordance should survive ordinary context lifecycle changes, but an adapter must disclose its host qualifications.

“Handled” is not “deleted.” Permanent deletion requires user authority by default. Notes should remain a staging surface rather than an accumulation sink.

## 9. Adapter freedom and non-guarantees

Adapters MAY choose files, databases, HTTP, host services, or another storage substrate. They MUST declare their source, authority, conflict, locality, lifecycle, and renderer qualifications. The Core does not require one UI, one host API, a specific lane-count implementation, or a universal renderer guarantee.

The current DSH profile supports one ordinary selectable/readable user or assistant message for selected-text capture. A selection spanning distinct authoritative messages must fail closed. Ordered multi-message/multi-event semantics remain valid at the Core and cross-host level; the current DSH boundary is a temporary profile qualification, not a deletion of Core semantics.
