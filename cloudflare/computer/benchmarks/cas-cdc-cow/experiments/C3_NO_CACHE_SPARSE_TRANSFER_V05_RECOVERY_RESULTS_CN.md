# C3 无缓存稀疏传输 v0.5——恢复重跑结果

日期：2026-08-10
作者：Wang Runyuan
基线：`e745e1da8a6ee3e97fa794ce36a5d504d74bdeb3`

## 结论

冻结后的两轮正式恢复实验全部通过 H1–H8。288 次正式执行全部逐字节正确，
288 次读取前后存储指纹全部不变；稀疏路线没有一次完整逻辑文件物化。

第二轮中，12 个场景的中位本地时间相加：稀疏流为
103 ms，完整物化为
172 ms，比例为
59.88%。最坏场景只需对
6.25% 的文件字节做新身份工作；16 MiB
场景的最大算法工作集为文件的
3.13%；每个配方至少引用
93.75% 的原有字节。

大白话：它能像“旧积木引用 + 改过的小块”那样顺序输出，不先拼一份完整
文件。但在完全冷、没有缓存的接收端，网络上仍要收到一整个文件，不能把
它宣传成冷传输省流量。

## 冻结判定

| 检查 | 结果 | 冻结门槛 |
| --- | --- | --- |
| H1_correctness | PASS | 288/288 formal executions exact |
| H2_readOnly | PASS | 288/288 storage fingerprints unchanged |
| H3_noCompleteMaterialization | PASS | zero complete logical-file materializations on sparse route |
| H4_boundedIdentityWork | PASS | hashed bytes <= 10% of file in every scenario/run |
| H5_largeFileWorkingSet | PASS | 16 MiB sparse peak <= 5% of file in every scenario/run |
| H6_honestColdPayload | PASS | cold wire payload equals file size; no cache credit |
| H7_structuralReuse | PASS | at least 90% referenced bytes in every scenario/run |
| H8_replicatedLocalDirection | PASS | sparse median-sum local time <= 1.25x full in each run |

## 原始数据哈希

- `results/c3-sparse-transfer-recovery-formal-run-1.json`：`fbe703ca0f212a521cd112d7d1c7bab88422936b8520eb423248928a5581bfe9`
- `results/c3-sparse-transfer-recovery-formal-run-2.json`：`1eb49e9fa1c48f3f01b0917b68fefdf21e4c5876f7e2b9aa5f79d2dbd35efd46`

原来未推送分支的原始文件被工作区维护清理；本报告只使用重新冻结后产生的
新正式数据，不冒充丢失的原始文件。
