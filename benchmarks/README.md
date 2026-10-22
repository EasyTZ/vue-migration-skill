# 公开合成迁移评测

这是重新编写的虚构设备台账，不含真实项目、账号、接口或业务数据。它提供真实 Vue 2 输入、公开验收契约、Vue 3 + Vite 参考实现，以及可对用户目标运行的评测器。参考实现通过只证明基准可运行，不表示任何智能体已经独立完成迁移。

## 组成与版本边界

| 目录/文件 | 作用 |
|---|---|
| `source/` | 固定 Vue 2.7.16 输入：mixin、filter、旧作用域插槽、列表与编辑表单 |
| `reference-target/` | Vue 3 SFC + Vite 参考答案，包含已修复实现；盲评时不提供给被测智能体 |
| `contract.mjs` / `evaluate.mjs` | Node 内置领域逻辑断言，可对任意可信目标目录执行 |
| `browser/` | 独立 Playwright 页面契约，可对任意本地预览 URL 执行 |
| `serve.mjs` | 仅监听本机的静态构建产物预览服务 |

参考依赖于 2026-10-22 从官方 npm registry 核验：Vue 3.5.44、Vite 8.3.5、Vue 插件 6.0.10；浏览器工具 Playwright 1.64.1。精确版本和锁文件是本次评测快照，不是 Skill 的永久依赖推荐。Vue 2.7.16 已结束维护，仅作为历史迁移输入，不用于新目标工程。新评测批次核验最新稳定依赖后再更新参考与锁文件。

## 已知缺陷及正确预期

| 编号 | 源行为 | 正确预期 |
|---|---|---|
| BUG-001 | 使用真假值校验数量，合法的零库存无法保存，负数/小数等边界也缺少校验 | 名称去空白后非空；数量允许 0 和非负整数，空、负数、小数、非数值应拒绝 |
| BUG-002 | 先发慢查询晚返回，覆盖后发快查询 | 最后一次发起的查询拥有最终结果；旧响应不得覆盖新结果 |

仍须保持：初始两条合成记录、名称必填反馈、正常保存及请求失败后恢复状态。源工程故意保留上述缺陷，评测不要求目标重复错误。

## 本地验证参考样板

在每个工程目录分别安装并构建（Node 22/24 为本仓库的验证线；依赖需满足其 engines）：

```sh
cd benchmarks/source
npm ci
npm run build
npm run preview
```

另开终端，在仓库根目录执行：

```sh
cd benchmarks/reference-target
npm ci
npm run build
npm run preview
```

源页面为 `http://127.0.0.1:4174`，参考页面为 `http://127.0.0.1:4175`。这些服务只用于合成数据；结束后在各自终端按 Ctrl+C。

### 领域契约

在仓库根目录：

```sh
node benchmarks/evaluate.mjs benchmarks/reference-target
node --test tests/benchmark.test.mjs
```

评测任意迁移目标：

```sh
node benchmarks/evaluate.mjs <目标工程绝对路径>
```

目标须保留测试入口 `src/domain.mjs`，导出 `normalizeDraft(draft)` 和 `createSearch(fetchItems)`。后者返回 `{ state: { items, loading, error }, search(query) }`，`search` 返回 Promise。可以内部重构、组合式封装或为测试建立薄导出，但必须让实际页面接入相同实现；只为测试另写一套逻辑不算通过。

此命令会执行目标模块，仅对可信代码运行。每项异步断言有超时，失败退出码 1、通过为 0；JSON 输出列出逐项结果。源输入直接运行契约会失败，这是预期的缺陷证据。根测试验证“源缺陷存在、参考修复通过”，不会把源预期失败算成 CI 故障。

### 真实浏览器契约

安装独立工具及 Chromium（仅首次需要）：

```sh
cd benchmarks/browser
npm ci
npx playwright install chromium
```

保持两个预览服务运行，在仓库根目录执行：

```sh
node benchmarks/browser/evaluate.mjs http://127.0.0.1:4174 --expect-source-bugs
node benchmarks/browser/evaluate.mjs http://127.0.0.1:4175
```

第一条命令仅在恰好发现两项指定源缺陷、其他页面检查通过时退出 0；第二条要求全部页面检查通过。用户目标构建后，以其本地预览地址替换 URL，并保留 `data-testid` 标识：`query/search/item/name/quantity/save/error/saved`，以及“合成设备台账”标题。工具仅接受 localhost/回环地址，不能拿真实生产页面运行。

已有浏览器可用时，可通过 `BENCHMARK_BROWSER_EXECUTABLE` 指定其绝对路径；有获准复用的 Playwright 模块时，可通过 `BENCHMARK_PLAYWRIGHT_MODULE` 指定模块入口。这两个环境变量只是可选的本地适配，不应将机器路径写入源码或提交记录。

领域契约不验证 UI 接入；浏览器契约不代替生产业务验收。参考构建、契约测试和智能体独立迁移结果应分别记录。

## 让智能体做一次盲评迁移

复制 `source/` 到独立工作目录作为只读输入；只提供 Skill、源工程及本文件的公开验收要求，不给智能体读取 `reference-target/`。安装依赖、创建构建产物是测试准备，源代码与固定依赖声明不得在任务中改写。先使用源快照工具记录基线，结束后检查源文件指纹。

```text
读取指定目录中的 SKILL.md，将这个合成 Vue 2 工程迁移到独立目标目录。
根据实际依赖和运行方式选择最新稳定目标依赖，不读取参考答案。
改写 mixin、filter、旧作用域插槽等旧实现，并修复 BUG-001、BUG-002。
保留公开领域导出与页面 data-testid，确保实际页面使用被测试的逻辑。
保留源文件，记录依赖决定、修复依据、执行命令及未验证范围。
完成后运行目标构建、公开领域契约和浏览器契约。
```

报告宿主/模型/Skill 提交、目标依赖、源指纹、实际命令、退出码及逐项结果；不把参考答案通过写成智能体成功。不使用参考答案的输出作为待测目标，也不删除失败断言或给整页套 stub。

## 当前实测范围

本地 Windows / Node 22.21.1 已实际安装锁定依赖、构建 Vue 2 源和 Vue 3/Vite 参考工程，并执行领域契约。Chrome 真实页面验收也已运行：Vue 2 页面恰好暴露两项已知 BUG，其他三项通过；参考目标五项全部通过。测试启动的预览服务已结束。GitHub CI 尚待实际运行；跨智能体独立迁移仍待验证。此样板没有登录、后端鉴权、生产部署及复杂业务，不能代表任意真实项目。
