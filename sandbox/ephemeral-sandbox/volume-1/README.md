# Volume I — The Agent Workspace

## Building Parallel Agent Workspaces

Volume I explains how coding agents can share immutable project history while
working in isolated copy-on-write sessions and publishing reviewable changes.

It opens with an eight-chapter, beginner-friendly map of the sandbox landscape.
That survey connects coding-agent sandboxes, on-demand cloud computers,
browser environments, RL rollout systems, versioned state, meta-agent control
planes, and publication runtimes to a larger vision: an agent-native runtime
substrate for hundreds or thousands of concurrent, auditable workers.

## Scope

This volume is grounded in the current Ephemeral Sandbox implementation:

- LayerStack and immutable project history;
- private copy-on-write workspace sessions;
- overlay mounts and namespace execution;
- shared and isolated network profiles;
- CLI and MCP interfaces;
- capture, three-way merge, and publication;
- provenance and observability;
- resource accounting, teardown, and recovery;
- testing and benchmarking.

It does not present Ephemeral Sandbox as a hardened microVM boundary for
mutually untrusted tenants. Credentials, full fleet control, durable process
checkpointing, and browser isolation are future design topics.

## Status

Part 0 and Part I manuscripts are complete in English and Simplified Chinese.
Their visual assets are included; later parts remain in editorial planning.

## Contents

- [PRD](PRD.md)
- [Detailed outline](outline.md)
- [Chapter workspace](chapters/README.md)
- [Part 0 manuscript](chapters/PART-0.md)
- [Part 0 manuscript — 简体中文版](chapters/PART-0.zh-CN.md)
- [Part 0 editorial blueprint](chapters/PART-0-WRITING-TEMPLATE.md)
- [Part I manuscript](chapters/PART-I.md)
- [Part I manuscript — 简体中文版](chapters/PART-I.zh-CN.md)
- [Part I editorial blueprint](chapters/PART-I-WRITING-TEMPLATE.md)
- [Part 0 visual assets](assets/README.md)
- [Appendices](appendices/README.md)
