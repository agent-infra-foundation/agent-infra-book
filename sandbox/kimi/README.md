# Kimi Sandbox Research Dossier

This dossier documents the observable architecture of Kimi's code-execution
sandbox, with a focus on the container boundary, persistent storage, the
FUSE-based fuse.portal gateway, security controls, and filesystem performance.

## Recommended Entry Points

- [Comprehensive technical report — English](<Kimi Sandbox Comprehensive Technical Report.md>)
- [综合技术报告 — 简体中文](Kimi沙箱综合技术报告.md)

The root repository README links only to these two main reports as reader-facing
article portals. The supporting reports remain available below.

## Reports in This Dossier

### Main Reports

- [Kimi Sandbox Comprehensive Technical Report — English](<Kimi Sandbox Comprehensive Technical Report.md>)
- [Kimi 沙箱综合技术报告 — 简体中文](Kimi沙箱综合技术报告.md)

### Supporting Source Reports

- [Kimi 沙箱技术报告](Kimi沙箱技术报告.md)
- [Kimi 沙箱 FUSE 文件系统深度报告](Kimi沙箱FUSE文件系统深度报告.md)

## Evidence Boundary

The reports distinguish direct observations from reasoned inferences. They do
not claim to reveal services or storage implementations outside the sandbox
boundary. Performance comparisons with other filesystems are provided as
order-of-magnitude context, not as controlled apples-to-apples benchmarks.
