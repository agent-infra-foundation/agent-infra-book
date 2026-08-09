# Chapter Workspace

The book is represented by an editorial blueprint, the canonical Part I
article, its chapter research sources, a runnable Part II tutorial, and the
benchmark-backed Part III C3 prototype:

- [Book writing template](BOOK-WRITING-TEMPLATE.md)
- [Part I development specification (reference)](PART-I-WRITING-SPEC.md)
- **Part I — Introducing Cloudflare Durable Objects** — [English](PART-I.md) · [简体中文](PART-I.zh-CN.md)
  - [Architecture and algorithm evidence audit](PART-I-EVIDENCE-AUDIT.md)
  - Chapter 1 — Durable Objects: Stateful Serverless from First Principles
  - Chapter 2 — Computer: SQLite Becomes a Filesystem Through FUSE
  - Chapter 3 — Follow One Command from Push to Durable Pull
  - Chapter 4 — Measure the Storage and Speed Costs
  - [Legacy long-form research drafts](part-i/)
  - [Benchmark method and complete interpretation](../benchmarks/storage/BENCHMARK.md)
  - [End-to-end medium result](../benchmarks/storage/results/medium-summary.md)
- **Part II — Cloudflare Computer: How to Cut AI Agent Sandboxing Costs by 80%** — [English](PART-II.md) · [简体中文](PART-II.zh-CN.md)
  - **X Article editorial edition** — [English](PART-II-X-ARTICLE.md) · [简体中文](PART-II-X-ARTICLE.zh-CN.md)
  - Chapter 5 — The 10% Container Strategy
  - Chapter 6 — Build One Website in Two Modes
  - Chapter 7 — Follow One Command Across the Durability Boundary
  - Chapter 8 — Calculate the 80% Reduction
  - [Runnable dual-mode website builder](../examples/dual-mode-website-builder/)
- **Part III — Reengineering Cloudflare Computer: 98.4% Less Branch Storage, 3.18× Faster Edits, and Safe Multi-Agent Parallelism** — [English](PART-III.md) · [简体中文](PART-III.zh-CN.md)
  - **X Article editorial edition** — [简体中文](PART-III-X-ARTICLE.zh-CN.md)
  - Chapter 9 — CAS: Store Once, Share Everywhere
  - Chapter 10 — COW: Write Only What Changed
  - Chapter 11 — CDC: Keep Small Changes Small
  - Chapter 12 — Branch and Publish: Many Agents, One Durable Main
  - Chapter 13 — Benchmark: Storage, Speed, and Multi-Agent Execution
  - [C3 prototype and benchmark project](../benchmarks/cas-cdc-cow/)

The [PRD](../PRD.md) defines audience, scope, evidence rules, and completion
criteria. The [detailed outline](../outline.md) defines the narrative progression
and running-system increment for each chapter.

## Recommended Chapter Shape

1. Opening incident, architecture decision, or agent task.
2. Central question and system invariant.
3. Compact mental model.
4. Concrete trace, implementation slice, or worked experiment.
5. Failure modes, limitations, and common misconceptions.
6. Evidence classification and sources.
7. Synthesis and transition to the next chapter.

Write as an informative systems book. Do not add quizzes, homework, generic
learning objectives, or detached tutorial labs. Commands and benchmarks should
appear as worked evidence inside the narrative.

## Evidence Labels

Use these labels in drafting notes and preserve the distinction in prose:

- **Platform contract**
- **Current platform behavior**
- **Documented implementation**
- **Open-source implementation**
- **Case study**
- **Proposal**

Never silently promote a repository observation, local Wrangler behavior, or
third-party architecture into a Durable Objects platform guarantee.
