# 增量检测与机器可读迁移覆盖

这套工具帮助主代理发现遗漏、过期记录和缺少证据的状态，不自动发现全部入口或证明业务正确。现有 Markdown 台账继续保留；机器状态是核对与汇总来源，不能重建时清空人工结论。

## 1. 建立源指纹基线

先初始化控制目录并填写真实 project.json 路径，再运行：

```sh
node "<Skill目录>/scripts/source-snapshot.mjs" "<控制目录>" "inventory/source-baseline-01.json"
node "<Skill目录>/scripts/init-status.mjs" "<控制目录>" "inventory/source-baseline-01.json"
```

源指纹扫描包含普通源文件、依赖/构建配置、锁文件与静态资源的字节哈希，不限于 inventory.mjs 的源码风险信号。依赖、构建产物、控制目录、符号链接和秘密文件按扫描策略排除；快照记录排除边界。它不是备份，也不是秘密扫描器：未被规则识别的敏感文件仍可能被读取计算哈希，快照只保留路径、大小与指纹，不复制文件内容；证据和源路径默认不公开。

初始化得到 `migration-status.json`，文件行默认为 pending，保留每个源文件的基线 sha256。状态文件已存在会拒绝覆盖。旧控制目录续作时只补新文件，不重新初始化覆盖已有状态。

## 2. 每批前检测变化

```sh
node "<Skill目录>/scripts/check-source.mjs" "<控制目录>" "inventory/source-baseline-01.json" "evidence/source-delta-01.json"
```

退出码：`0` 为所选扫描范围内未变化，`2` 为发现增量，`1` 为输入或执行错误。有变化时报告 added、modified、deleted，主代理查调用方、共享配置及已迁消费方，判定影响批次并使相关证据失效。相同内容换路径按删除+新增处理，不推测重命名。

变化处理后重新生成不同名字的快照，显式切换状态中的 baselineSnapshot，逐行核对新增/删除/修改及 sourceSha256。已删除源文件从活动 files 移出，删除决策及原映射保留在台账、旧快照和旧报告中；新增文件补 pending 行，受影响记录在重验前退回实际状态。不要只刷新 hash 就沿用旧验收；相关调用方与跨模块链路同样需要重验。未变化的源码也可能受改动的配置或共享依赖影响，工具不能自动完成这种影响分析。

源在持续修改时，协调稳定的提交或工作区时点后再扫描；文件系统快照不是事务。扫描器的排除项不代表对应外部依赖、环境变量或秘密配置已验证，需要其他契约证据。

## 3. 维护覆盖状态

格式参考 [migration-status.example.json](../assets/migration-status.example.json)，格式版本 `schemaVersion: 1`。入口、架构层、检查与缺陷由主代理按实物补齐，不能仅凭源文件列表自动生成验收结论。

| 集合/字段 | 填写与核对要求 |
|---|---|
| `baselineSnapshot` | 控制目录内快照相对路径 |
| `files` | source、sourceSha256、targets、disposition、stage、reason、evidence |
| `entriesReviewed` / `entries` | 确认入口普查范围，登记路由/弹窗/导出/打印/任务等；入口含 id、sourceFiles、targets、status、evidence |
| `architectureReviewed` / `architecture` | 确认架构范围，逐层登记 id、status、evidence；不适用需 reason 和依据 |
| `checks` | 默认包含 lint、static、test、build；运行后填写 command、exitCode、executedAt、status、evidence；测试通过还需 testCount > 0 |
| `bugs` | id、status、expected、basis、evidence；fixed 必须有正确预期、依据和回归证据 |

文件 `stage` 支持 pending、in-progress、migrated、verified、accepted、blocked。`disposition` 为 pending、mapped 或 omitted；不迁移的文件须给出理由及证据，并达到 verified/accepted 状态。mapped 文件须引用真实目标文件；达到 verified/accepted 还须有控制目录内证据。accepted 是已有人工决定的登记，不是由工具授予。

入口/架构状态用 pending、in-progress、verified、accepted、blocked 或 not-applicable；不适用须理由与证据。检查状态用 pending、passed、failed 或 not-applicable。未修复/未验证缺陷保留实际状态，不随进度清空。

证据数组均为控制目录内普通文件的相对路径；targets 为目标目录内普通文件的相对路径；使用 `/` 分隔，拒绝绝对路径、`..` 越界和链接跳出目录。日志应保留实际命令及输出；必要的人工验收文件应登记复核者、日期与结论，不伪造签字。

## 4. 生成 JSON 与 Markdown 报告

```sh
node "<Skill目录>/scripts/migration-report.mjs" "<控制目录>" "migration-status.json" "evidence/report-01.json" "evidence/report-01.md"
```

报告汇总文件、已登记入口、架构层、检查和缺陷，列出未登记、指纹过期、缺少目标、缺少证据与待确认事项。输出只能在控制目录内，名称已存在时拒绝覆盖。

退出码 `0` 表示记录达到提交复核的条件，`2` 表示有待处理项，`1` 表示工具或输入错误。JSON 中 `reviewReady` 不代表迁移已验收：工具检查引用与结构，不读取证据来判定真假，不绑定目标/证据文件与执行时版本，也不自动运行被记录的命令或代签业务人工复核。目标文件修改后必须实际重跑检查并更新记录；文件仍存在不能证明旧结果对新目标有效。入口统计的分母仅是已登记入口；entriesReviewed 是主代理的范围声明，仍需人工复核是否漏登记。

新旧系统协议差异、高风险计算和真实部署仍按 [verification.md](verification.md) 执行验收。公开报告前脱敏，不把源路径、内部业务名称及私有证据直接上传到社区仓库。
