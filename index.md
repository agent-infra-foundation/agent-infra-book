# Agent Infra Book Index

This repository collects technical books about the infrastructure that gives AI
agents private work, controlled execution, durable history, recovery, and safe
publication.

## Current Book

### Volume I — The Agent Workspace

*Building Parallel Agent Workspaces with Ephemeral Sandbox*

- [Volume overview](sandbox/ephemeral-sandbox/volume-1/README.md)
- [Part 0 manuscript — Overview of Agent Sandboxes in Practice](sandbox/ephemeral-sandbox/volume-1/chapters/PART-0.md)
- [Part 0 manuscript — 智能体沙箱实践概览（简体中文）](sandbox/ephemeral-sandbox/volume-1/chapters/PART-0.zh-CN.md)
- [Part I manuscript — The Concurrency Ceiling of Parallel Coding Agents](sandbox/ephemeral-sandbox/volume-1/chapters/PART-I.md)
- [Part I manuscript — 并行编码智能体的并发上限（简体中文）](sandbox/ephemeral-sandbox/volume-1/chapters/PART-I.zh-CN.md)
- [Part II manuscript — Shared History and Workspace Sessions](sandbox/ephemeral-sandbox/volume-1/chapters/PART-II.md)
- [Part II manuscript — 共享历史与工作空间会话（简体中文）](sandbox/ephemeral-sandbox/volume-1/chapters/PART-II.zh-CN.md)
- [Part III draft — Private Workspaces and Published History](sandbox/ephemeral-sandbox/volume-1/chapters/PART-III.md)
- **Part IV — Running and Operating the Workspace Runtime** — Planned
- **Part V — The Boundary of Version 1** — Planned
- **Part VI — Reading the Implementation: From Tool Call to Workspace Runtime** — Planned

## In Editorial Development

### Cloudflare Durable Object Storage

*Building Durable Systems and Agent Workspaces with Cloudflare Durable Objects*

- **Read:** [Part I — Introducing Cloudflare Durable Objects](cloudflare/durable-object-storage/chapters/PART-I.md) · [第一部分：Cloudflare Durable Objects 入门（简体中文）](cloudflare/durable-object-storage/chapters/PART-I.zh-CN.md)
- **Measure:** [Native filesystem vs Computer benchmark](cloudflare/durable-object-storage/benchmarks/storage/BENCHMARK.md) · [Latest end-to-end result](cloudflare/durable-object-storage/benchmarks/storage/results/medium-summary.md)
- **Verify:** [Part I evidence audit](cloudflare/durable-object-storage/chapters/PART-I-EVIDENCE-AUDIT.md)
- **Explore:** [Book overview](cloudflare/durable-object-storage/README.md) · [Detailed outline](cloudflare/durable-object-storage/outline.md)
- **Part II — Cloudflare Computer: How to Cut AI Agent Sandboxing Costs by 80%** — [English](cloudflare/durable-object-storage/chapters/PART-II.md) · [简体中文](cloudflare/durable-object-storage/chapters/PART-II.zh-CN.md) · [Run the example](cloudflare/durable-object-storage/examples/dual-mode-website-builder/)
- **Part III — Giving State Hands** — Planned

Development references: [product requirements](cloudflare/durable-object-storage/PRD.md), [book writing template](cloudflare/durable-object-storage/chapters/BOOK-WRITING-TEMPLATE.md), and [Part I development specification](cloudflare/durable-object-storage/chapters/PART-I-WRITING-SPEC.md).
