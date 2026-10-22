# Vue 2 → Vue 3 通用迁移 Skill

[源码仓库](https://github.com/EasyTZ/vue-migration-skill) · [自动检查](https://github.com/EasyTZ/vue-migration-skill/actions) · [问题反馈](https://github.com/EasyTZ/vue-migration-skill/issues) · [MIT](LICENSE)

面向 AI 编程智能体的 Vue 2 项目迁移工作流：根据原项目的依赖和实际用途选择目标依赖，使用执行时核验的最新稳定版本，把旧代码改写为现代 Vue 3 写法，并同步排查和修复有证据的 BUG。

**当前为预览版。** 本仓库提供迁移规则、辅助脚本和验收方法，不是自动完成任意项目迁移的转换器。尚未完成多家智能体及代表业务项目的端到端验证。

## 能做什么

- 从原项目的清单、锁文件、调用点和部署形态推导目标依赖，不预设 UI、请求、状态、构建工具或语言组合，不内置长期有效的版本号。
- 核验最新稳定版本，优先改写代码或替换失维护依赖，不为保留旧 API 降级依赖。
- 按项目需要处理 JS/TS、SPA、SSR、组件库、微前端及 workspace。
- 迁移时审查空值、异步竞态、重复提交、资源释放、会话与表单等问题；正确预期明确时直接修复，业务规则不明时记录待确认。
- 环境支持时使用多个子代理并行调查、改写、排查和验证，主代理负责共享契约、冲突处理及最终集成验收。
- 保留源工程既有文件，只在独立目标工程改写；过程资料统一放控制目录，支持检查点续作。

## 能力边界

源工程能否运行、后端是否可用、业务规则是否清楚、宿主能否操作文件和浏览器，都会影响可验证范围。静态扫描只是候选信号；编译通过不代表业务正确，脚本测试通过不代表智能体迁移已通过。不能保证发现所有 BUG，也不替代必要的业务人工验收。

源代码、测试数据、账号、日志和截图可能包含敏感信息。不要将真实凭证、客户数据或未获授权的私有项目上传到公开仓库或 Issue；写操作在获准的测试环境中执行。

## 安装与调用

先克隆仓库，或从 GitHub 下载源码压缩包：

```sh
git clone https://github.com/EasyTZ/vue-migration-skill.git
```

下载仓库后，将**整个目录**作为 Skill 保存，建议目录名为 `vue2-to-vue3-migration`。不要只复制 `SKILL.md`：它依赖 `references/`、`scripts/` 和 `assets/`。

仓库名为 `vue-migration-skill`，技能标识为 `vue2-to-vue3-migration`；安装到技能目录时使用后者，以便与 `SKILL.md` 的名称及调用入口一致。

### Codex

本地 Codex 可将完整目录复制到项目的 `.agents/skills/vue2-to-vue3-migration/`，或用户目录的 `~/.agents/skills/vue2-to-vue3-migration/`。确认它已出现在可用技能列表，再使用技能入口或明确要求加载 `SKILL.md`。发现机制与作用域以当前客户端及[官方 Skills 文档](https://learn.chatgpt.com/docs/build-skills)为准，本仓库不提供未经验证的一键安装命令。

### Claude Code

本地 Claude Code 可将完整目录放到项目的 `.claude/skills/vue2-to-vue3-migration/`，或用户目录的 `~/.claude/skills/vue2-to-vue3-migration/`，加载后使用 `/vue2-to-vue3-migration`，并附上源、目标目录及约束。其他作用域和加载方式见 [Claude Code 官方文档](https://code.claude.com/docs/en/skills)。目录格式支持不代表本仓库已在 Claude Code 完成实测。

### DeepSeek 及其他宿主

先确认具体的 CLI、IDE 插件或智能体框架。模型名称不能决定宿主是否支持 Skill、终端、浏览器及子代理；使用该宿主的技能加载机制，不假设存在统一的 DeepSeek 安装路径。

没有自动发现能力时，可显式提示：

```text
请先完整读取 <本 Skill 的实际目录>/SKILL.md，按需读取它引用的文件。
源工程是 <源工程绝对路径>，目标工程是 <目标工程绝对路径>。
按原项目依赖和实际用途选择目标依赖，执行时核验最新稳定版本。
在新工程改写并修复有证据的 BUG，保留源工程既有文件。
环境支持时使用多个子代理；明确文件所有权，集成后统一验证。
先完成能力检查与普查，再按批次持续推进，准确报告未验证项。
```

宿主需要实际的文件、终端等工具才能执行，普通文本聊天无法直接完成本地迁移。详见[跨智能体适配规则](references/platform-adapters.md)。

## 使用流程

优先让智能体依照 [SKILL.md](SKILL.md) 执行以下流程。辅助脚本依赖可运行 `.mjs` 和 `node:test` 的现代 Node.js；仓库测试使用 Node.js 22/24，目标项目使用的 Node 与包管理器版本另按目标依赖要求确定。

这些命令中的路径都是占位符，请替换成实际路径，并为含空格的路径加引号。脚本不会自动安装目标依赖或启动项目。

### 1. 建立控制目录与普查

```sh
node "<Skill目录>/scripts/init-control.mjs" "<源工程>"
node "<Skill目录>/scripts/inventory.mjs" "<源工程>" "<源工程>/migration/inventory/source-01.json"
```

默认控制目录为 `<源工程>/migration/`，也可向 `init-control.mjs` 传第二个参数指定独立目录。初始化不覆盖已有文件，普查快照不覆盖旧输出。源工程既有源码与配置保持只读。

### 2. 根据项目填写配置

初始化后编辑控制目录中的 `project.json`，以 [assets/project.example.json](assets/project.example.json) 为结构依据：

- 填写真实 `sourceRoot`、`targetRoot` 和 `control.root`；相对配置路径以控制目录解析。
- 按项目选择 `packageManager`，填写 Node、包管理器、浏览器等实际约束。
- `targetManifest` 保存目标项目真实的 `package.json` 内容：名称、脚本、生产与开发依赖，以及库导出等需要的字段。
- `dependencyDecisions` 和迁移规范记录每个源依赖的实际用途、升级/替换/删除决定及版本核验依据。
- 填写可执行的检查命令、业务场景和已知差异，未知值保持待确认，不用示例冒充事实。

本仓库刻意不提供一套可复制的目标依赖版本。对注册表依赖填写当次核验后的稳定精确版本；workspace、库的 peer 范围和特殊来源按真实契约处理。附带初始化器不支持的特殊声明，可按已选技术路线手动建立工程并记录依据。

### 3. 初始化目标清单

```sh
node "<Skill目录>/scripts/init-target.mjs" "<目标工程>" "<控制目录>/project.json"
```

目标目录必须为空，且不能在源工程或控制目录内部。该命令**只生成 `package.json`、README 和 `.gitignore`**，不会生成可运行的固定框架骨架。随后由智能体按所选技术路线的官方模板补齐源码和配置，安装依赖并生成锁文件。

已有迁移工程直接续作，不运行初始化器覆盖重建。

### 4. 分批改写、修复与验收

按依赖图先验证公共能力及代表链路，再扩大业务批次；各子代理负责独立文件，依赖清单、锁文件和根配置统一管理。每批执行适用的 lint、静态/类型检查、测试、构建及新旧行为对拍。详见[并行迁移](references/parallel-migration.md)、[BUG 修复](references/bug-fixing.md)和[验收规则](references/verification.md)。

```sh
node "<Skill目录>/scripts/check-sfc.mjs" "<目标工程>"
node "<Skill目录>/scripts/check-boundary.mjs" "<控制目录>" "<目标工程>"
```

SFC 检查器使用目标工程的编译器检查 `src/` 下的 `.vue` 文件；需先安装匹配的编译依赖。它不代替项目构建、类型检查或实际挂载；特殊目录与编译配置应补充对应验证。边界检查器发现候选越界文件后应人工核实，不能据此自动删除业务文件。

## 目录结构

```text
SKILL.md                    智能体入口
assets/project.example.json 项目配置结构
references/                 依赖策略、平台适配、迁移和验收规则
scripts/                    普查、初始化及检查工具
tests/                      辅助脚本回归测试
.github/                    CI、Issue 和 PR 模板
EVALUATION.md               智能体与真实项目评测方案
CONTRIBUTING.md             贡献说明
CHANGELOG.md                版本记录
LICENSE                     MIT 许可证
SECURITY.md                 非公开安全报告约定
```

## 验证状态

| 范围 | 当前状态 |
|---|---|
| Windows、Node.js 22.21.1 辅助脚本 | 2026-10-22 本地测试通过；覆盖范围见 tests/，不代表业务迁移验收 |
| Linux/macOS 与其他 CI Node 组合 | 已提供 CI 配置；首次仓库运行前均为待验证 |
| Codex 文件操作及子代理协作 | 本仓库维护过程中已使用；不等于完整项目迁移验证 |
| Claude Code | 标准目录与文档适配；实际执行待验证 |
| 使用 DeepSeek 的宿主 | 需指定宿主及版本，待验证 |
| 代表业务项目完整迁移 | 待验证，尚无公开端到端成功案例 |

本地运行辅助脚本测试：

```sh
node --test
```

CI 只证明测试覆盖范围内的脚本行为，不证明模型遵循指令、真实项目可运行或业务验收完成。[EVALUATION.md](EVALUATION.md) 定义人工评测与案例记录方式；欢迎贡献脱敏复现和实际验证结果。

## 贡献与许可证

欢迎提交问题、补充测试、改进规则和贡献脱敏迁移案例，参见 [CONTRIBUTING.md](CONTRIBUTING.md)。提交前不要将具体项目的版本、路径、凭证和业务规则固化成所有项目的通用要求。

本仓库采用 [MIT 许可证](LICENSE)。迁移源项目和其依赖仍遵守各自的许可证与使用约定。

安全问题请参见 [SECURITY.md](SECURITY.md)，不要在公开 Issue 中提交敏感信息或可利用细节。

## 首次建立公开仓库

1. 将此目录作为仓库根目录，保留 `.github/`、`.gitignore` 与 `.gitattributes` 等隐藏文件；无需先安装业务依赖。
2. 检查即将上传的文件不包含迁移项目、凭证、截图和本地过程资料。本仓库已包含 README 和 MIT LICENSE，创建远程仓库时无需再自动生成一套。
3. 推送后查看 Actions 六组检查的实际结果；通过后再更新兼容表，不提前宣称跨平台验证成功。
4. 确认 Issue 模板和安全报告渠道可用。首次发布标为预览版，真实迁移案例按 EVALUATION.md 逐步补充。
