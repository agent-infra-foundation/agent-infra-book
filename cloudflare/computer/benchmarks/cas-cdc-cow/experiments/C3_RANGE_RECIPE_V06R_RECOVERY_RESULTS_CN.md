# C3 无缓存区间配方 v0.6R——恢复重跑结果

日期：2026-08-10
作者：Wang Runyuan
基线：`e745e1da8a6ee3e97fa794ce36a5d504d74bdeb3`

## 结论

冻结后的两轮正式恢复实验全部通过 H1–H11。270 次正式执行全部返回正确
字节，270 次读取前后存储指纹全部不变；按区间配方路线从未在内部物化完整
逻辑文件。

第二轮的确定性负载比例：

- 三种稀疏读取合计：完整传输的 0.23%；
- 连续读取四分之一文件：25.12%；
- 顺序读取完整文件：100.12%；
- 配方规划需要处理的新身份字节：文件字节的 0.39%。

最大算法工作集约为
374 KiB。
三个完整读取场景合计发出 162 次本地
CAS 对象区间查询。三种稀疏读取的本地中位时间合计为
4 ms，完整物化为
181 ms。

大白话：真正省下来的不是“把旧文件压缩得更神奇”，而是消费者只要几小段
时，配方能让系统只去拿那几小段。消费者要整文件时，负载就老老实实回到
约 100%，这反而说明记账没有作弊。

## 冻结判定

| 检查 | 结果 | 冻结门槛 |
| --- | --- | --- |
| H1_correctness | PASS | 270/270 formal executions exact |
| H2_readOnly | PASS | 270/270 storage fingerprints unchanged |
| H3_noCompleteMaterialization | PASS | zero complete logical-file materializations on range-recipe route |
| H4_sparsePayload | PASS | three sparse shapes <= 2% aggregate payload in each run |
| H5_quarterPayload | PASS | quarter access <= 26% aggregate payload in each run |
| H6_fullAccessOverhead | PASS | full access <= 101% aggregate payload in each run |
| H7_boundedIdentityWork | PASS | planning hashed bytes <= 1% aggregate file bytes in each run |
| H8_boundedWorkingSet | PASS | range-recipe peak <= 25% of file in every scenario/run |
| H9_rangeSpecificity | PASS | range payload < full-recipe payload in every non-full scenario/run |
| H10_actualCasRangeReads | PASS | at least one CAS object-range query in each run |
| H11_replicatedSparseLocalDirection | PASS | sparse-shape range local median sum < full materialization in each run |

## 原始数据哈希

- `results/c3-range-recipe-recovery-formal-run-1.json`：`6f3104beae91687911832d9c458a265183b031b138a3d5008a8db85f250520d4`
- `results/c3-range-recipe-recovery-formal-run-2.json`：`c379b07726f0c50749da76b33bbd4c91f590b207df520425941f8715e854b0fa`

这是引擎层、本地 SQLite、合成负载的机制证据，不等于完整 Computer、FUSE、
网络或生产工作负载加速结论。
