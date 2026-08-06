# Chapter Workspace

The book is represented by an editorial blueprint, the canonical Part I
article, its chapter research sources, and manuscript shells for Parts II and
III:

- [Book writing template](BOOK-WRITING-TEMPLATE.md)
- [Part I development specification (reference)](PART-I-WRITING-SPEC.md)
- [Part I — Introducing Cloudflare Durable Objects](PART-I.md)
  - [Architecture and algorithm evidence audit](PART-I-EVIDENCE-AUDIT.md)
  - [Chapter 1 — The Object That Owns State](part-i/CHAPTER-1.md)
  - [Chapter 2 — Identity Persists; Memory Does Not](part-i/CHAPTER-2.md)
  - [Chapter 3 — Durable Storage: From Legacy KV to SQLite](part-i/CHAPTER-3.md)
  - [Chapter 4 — From Durable Object to `/workspace`](part-i/CHAPTER-4.md)
  - [Chapter 5 — Measuring the Durable Workspace](part-i/CHAPTER-5.md)
  - [Benchmark method and complete interpretation](../benchmarks/storage/BENCHMARK.md)
  - [End-to-end medium result](../benchmarks/storage/results/medium-summary.md)
- [Part II — Engineering the Durable Computer](PART-II.md)
  - [Storage-layer component diagnostic](../benchmarks/storage/results/summary.md)
- [Part III — Giving State Hands](PART-III.md)

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
