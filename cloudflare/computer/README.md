# From Stateful Compute to Agent Computers

## Building Durable Systems and Agent Workspaces

This book explains how Cloudflare Durable Objects combine identity,
coordination, compute, and private transactional storage. It then uses
Cloudflare Computer as an open-source case study in building a durable virtual
filesystem inside a Durable Object. The final part introduces C3, an
experimental CAS, CDC, and COW filesystem design for reducing storage
amplification, accelerating incremental work, and supporting private
multi-agent branches.

The central thesis is:

> State can have a durable, globally addressable home while execution remains
> disposable and capability-scoped.

## Narrative Arc

The book opens with a coding agent moving away from an always-on VM. It then
answers three questions:

1. How does a Durable Object give state an identity and an owner?
2. How can that state become a durable computer workspace?
3. How can one durable workspace support cheaper edits and multiple agents
   without silently losing work?

## Parts

- **Part I — Introducing Durable Objects** establishes object identity,
  coordination, lifecycle, and storage, then uses Cloudflare Computer's VFS and
  FUSE projection as a concrete bridge from durable state to durable files. It
  closes by measuring the bridge's storage and speed trade-offs.
- **Part II — Cloudflare Computer: How to Cut AI Agent Sandboxing Costs by
  80%** turns the architecture into a runnable dual-mode website tutorial. It
  keeps ordinary work in isolates, escalates npm and Vite to a container, and
  derives the cost claim from a transparent monthly model.
- **Part III — Reengineering Cloudflare Computer: 98.4% Less Branch Storage,
  3.18× Faster Edits, and Safe Multi-Agent Parallelism** builds and measures an experimental CAS, CDC, COW,
  and conflict-aware branching layer over Durable Object SQLite.

## Scope and Evidence

The book keeps four kinds of claims visibly separate:

- **Platform contract** — behavior documented for Durable Objects.
- **Documented implementation** — published descriptions of SQLite, WAL,
  Storage Relay Service, snapshots, and recovery.
- **Open-source application design** — behavior verified in Cloudflare
  Computer, `workerd`, Workers SDK, or `just-bash` source.
- **Case study or proposal** — third-party architecture and future design.

Cloudflare Computer is preview software. Its 512 KiB file chunks, VFS schema,
manifests, FUSE projection, and synchronization protocol are Computer design
choices, not Durable Objects storage guarantees.

## Status

The book is in editorial development. Part I is a canonical four-chapter
article available in English and Simplified Chinese. Both editions share the
same source notes, evidence audit, and benchmark. Part II is a runnable tutorial
available in English and Simplified Chinese. Part III is also available in both
languages and is backed by the C3 storage, multi-agent, and full Computer/FUSE benchmarks.
The source-pinned storage benchmark and its first full result support the benchmark chapter. The
publication benchmark uses the native WSL
filesystem as its baseline and measures the existing Computer pipeline through
real FUSE, `computerd`, synchronization, and local workerd Durable Object
SQLite.

## Contents

- [Product requirements](PRD.md)
- [Detailed outline](outline.md)
- [Chapter workspace](chapters/README.md)
- [Book writing template](chapters/BOOK-WRITING-TEMPLATE.md)
- [Part I development specification (reference)](chapters/PART-I-WRITING-SPEC.md)
- **Part I — Introducing Cloudflare Durable Objects** — [English](chapters/PART-I.md) · [简体中文](chapters/PART-I.zh-CN.md)
- [Part I evidence audit](chapters/PART-I-EVIDENCE-AUDIT.md)
- [Part I chapter research sources](chapters/part-i/)
- **Part II — Cloudflare Computer: How to Cut AI Agent Sandboxing Costs by 80%** — [English](chapters/PART-II.md) · [简体中文](chapters/PART-II.zh-CN.md)
- **Part II X Article editorial edition** — [English](chapters/PART-II-X-ARTICLE.md) · [简体中文](chapters/PART-II-X-ARTICLE.zh-CN.md)
- **Part III — Reengineering Cloudflare Computer: 98.4% Less Branch Storage, 3.18× Faster Edits, and Safe Multi-Agent Parallelism** — [English](chapters/PART-III.md) · [简体中文](chapters/PART-III.zh-CN.md)
- [C3 prototype and benchmarks](benchmarks/cas-cdc-cow/)
- [Dual-mode website builder tutorial](examples/dual-mode-website-builder/)
- [Durable Object storage benchmarks](benchmarks/storage/)
- [Native filesystem vs Computer benchmark document](benchmarks/storage/BENCHMARK.md)
- [Latest end-to-end medium result](benchmarks/storage/results/medium-summary.md)
- [Latest storage-layer component result](benchmarks/storage/results/summary.md)
- [Visual assets plan](assets/README.md)
- [Appendices](appendices/README.md)

## Canonical Starting Sources

- [Cloudflare Durable Objects documentation](https://developers.cloudflare.com/durable-objects/)
- [Legacy KV Storage API](https://developers.cloudflare.com/durable-objects/api/legacy-kv-storage-api/)
- [SQLite Storage API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)
- [Cloudflare Computer](https://github.com/cloudflare/computer) — Part I research pin:
  [`76d9e75`](https://github.com/cloudflare/computer/tree/76d9e75c5688713b656bce85540d9e0071cece8b)
- [Our coding agent runs in a Cloudflare Durable Object, not a VM](https://camelai.com/blog/our-coding-agent-runs-in-a-cloudflare-durable-object-not-a-vm)
- [Zero-latency SQLite storage in every Durable Object](https://blog.cloudflare.com/sqlite-in-durable-objects/)
- [Code Mode](https://blog.cloudflare.com/code-mode/)
- [`just-bash`](https://github.com/vercel-labs/just-bash)

This is an independent technical book and not an official Cloudflare
publication.
