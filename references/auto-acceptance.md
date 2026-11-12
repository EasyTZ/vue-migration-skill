# 自动化运行验收（托管化）

本文件定义“迁移完成后本机启动目标工程并自动验证 UI、接口与交互”的执行规范和评分口径。目标不是生成报告，而是**用真实运行证据发现差异、修复差异、证明新工程可以直接跑起来**。

工具默认只对本机回环地址执行；对远程或测试环境验收需用户明确授权，浏览器审计要显式 `--allow-remote`，并使用独立的部署验证流程，不能把本流程指向生产写操作。

## 1. 证据与目录

```text
控制目录/
├── inventory/capabilities-<日期>.json   从老工程抽取的能力清单（只读输入）
├── runtime/
│   ├── routes.json                      源入口 → 目标入口映射（人工复核）
│   ├── scenarios.json                   登录/交互场景
│   ├── capability-status.json           场景无法覆盖的能力核对结论
│   ├── source-runtime.json              老工程启动状态（基线采集后停止）
│   └── target-runtime.json              目标工程启动状态（交付前必须 stopped）
└── evidence/
    ├── baseline/                        老工程 DOM/截图/网络基线
    ├── runs/<run-id>/http.json          HTTP 巡检
    ├── runs/<run-id>/ui.json            浏览器审计与场景结果
    ├── runs/<run-id>/screens/           截图
    ├── runs/<run-id>/fidelity.json      分数与阻塞项（机器可读）
    └── runs/<run-id>/fidelity.md        验收报告（随老工程交付）
```

每次重跑使用新的 `run-id`，不覆盖旧证据。`evidence/` 默认不入库；是否提交按项目约定。

## 2. 输入准备

### 2.1 能力清单

```sh
node <skill目录>/scripts/extract-capabilities.mjs <控制目录> inventory/capabilities-<日期>.json
node <skill目录>/scripts/init-acceptance.mjs <控制目录> inventory/capabilities-<日期>.json
```

`init-acceptance.mjs` 只在文件缺失时生成种子。种子是候选范围，不是验收结论：必须回读老工程确认路由映射、补交互场景、核对能力状态。

### 2.2 路由表

```json
{
  "schemaVersion": 1,
  "kind": "acceptance-routes",
  "mode": "history",
  "reviewed": true,
  "routes": [
    { "id": "R-001", "title": "登录", "sourcePath": "/login", "targetPath": "/login", "menuVisible": true, "covers": ["route:/login"] },
    { "id": "R-002", "title": "用户编辑", "sourcePath": "/user/edit/:id", "targetPath": "/user/edit/:id", "menuVisible": false }
  ]
}
```

要求：

- `id` 唯一且基线/目标共用；`targetPath` 必须以 `/` 开头，并填写可访问的**具体测试路径**（如 `/user/edit/1`），不能写 `:id` 或 `*`；测试数据必须可回收。
- 覆盖菜单、按钮/返回跳转、菜单外子页面、弹窗型入口；`reviewed` 在逐条核对后改 true。
- `mode=hash` 时 HTTP 层只验证入口 HTML，页面 DOM 由浏览器审计负责。
- 浏览器审计会从页面 `<a href>` 爬取同源链接补充入口（默认开启，`--no-crawl` 关闭），排除登出、下载与外部链接；爬取发现但未登记的入口也纳入渲染门禁。

组件库、SSR 或纯服务工程没有页面路由时，不要伪造路由：用组件测试、Storybook 页面或 SSR 渲染入口作为验收对象，并在 `运行验收.md` 记录替代方式与未适用维度理由。空路由表不能当作门禁通过；`acceptance.mjs` 会拒绝空的验收路由表。

### 2.3 场景

```json
{
  "schemaVersion": 1,
  "viewport": { "width": 1440, "height": 900 },
  "setup": [],
  "scenarios": [
    {
      "id": "SC-001-用户新增校验",
      "phase": "interaction",
      "route": "/user",
      "covers": ["form:src/views/user/Edit.vue", "dialog:src/views/user/Edit.vue"],
      "steps": [
        { "action": "click", "selector": "[data-testid='create']" },
        { "action": "click", "selector": "[data-testid='submit']" },
        { "action": "expectText", "selector": "[data-testid='name-error']", "contains": "请输入" },
        { "action": "fill", "selector": "[data-testid='name']", "value": "演示 {{NOW}}" },
        { "action": "click", "selector": "[data-testid='submit']" },
        { "action": "expectRequest", "method": "POST", "urlContains": "/api/users", "status": 200 }
      ]
    }
  ]
}
```

步骤动作：

| action | 参数 | 说明 |
|---|---|---|
| `goto` | `path` / `url` | 打开地址；path 会按 base/mode 拼接 |
| `reload` | — | 刷新当前页 |
| `click` / `hover` / `check` / `uncheck` | `selector` | 取第一个匹配元素；优先语义选择器 |
| `fill` | `selector`, `value` | 清空后输入；支持 `{{ENV:NAME}}`、`{{NOW}}` |
| `press` | `selector`, `key` | 默认 Enter |
| `select` | `selector`, `value` | 原生 select |
| `waitFor` | `selector`, `state` | 等待可见/隐藏/挂载 |
| `wait` | `ms` | 最多 15 秒；优先等待具体条件 |
| `expectVisible` / `expectHidden` | `selector` | 等待条件成立 |
| `expectText` / `expectValue` | `selector`, `contains`/`equals`/`regex` | 轮询直到匹配或超时 |
| `expectCount` | `selector`, `count` | 元素数量 |
| `expectUrl` | `contains`/`equals`/`regex` | 地址断言 |
| `expectRequest` | `method`, `urlContains`, `path`, `status`, `bodyContains` | 断言本场景已发生的请求 |
| `screenshot` | `name` | 额外截图 |

约定：

- `phase=setup`：登录/取 token 等前置，同一浏览器上下文继续，失败直接阻塞。
- `phase=interaction`：计入交互维度，覆盖能力清单必需项。
- `phase=route`：仅打开页面，渲染由审计判定，不计入交互分。
- 场景失败会自动截图；不要用 `wait` 掩盖竞态，修真实问题。
- 口令只通过 `{{ENV:NAME}}` 注入，场景文件不写真实凭证；登录态可用 `--storage-state runtime/auth.json`（控制目录内、不入库）。
- 断言不要依赖组件库内部 class；优先 `data-testid`、`role`、可访问名称与稳定业务文本。

### 2.4 能力核对状态

```json
{
  "schemaVersion": 1,
  "kind": "capability-status",
  "reviewed": true,
  "units": [
    { "id": "print:src/views/report/List.vue", "status": "verified", "reason": null, "evidence": ["evidence/print/preview.png"] },
    { "id": "map:src/views/track/Map.vue", "status": "omitted", "reason": "该入口在目标版本已下线，业务确认不再使用", "evidence": ["evidence/decisions/map-offline.md"] }
  ]
}
```

`verified` 必须有证据引用；`omitted` 必须有理由。没有登记且未被通过的场景覆盖的能力项计入缺口。

### 2.5 老工程基线

老工程能运行时，必须采集运行基线；只做静态扫描无法证明 UI 复原度。

```sh
# 1) 启动老工程（用老工程自己的命令和端口）
node <skill目录>/scripts/serve-target.mjs start <控制目录> --root <源工程> \
  --command "npm run serve" --port 4174 --url http://127.0.0.1:4174/ --state runtime/source-runtime.json

# 2) 采集基线（--source-paths 让同一份路由表按 sourcePath 访问老工程，id 自动对齐）
node <skill目录>/scripts/browser-audit.mjs <控制目录> evidence/baseline/source.json \
  --capture evidence/baseline --routes runtime/routes.json --source-paths \
  --screens evidence/baseline/screens --base-url http://127.0.0.1:4174/ \
  --playwright <Playwright入口> --no-crawl

# 3) 停止并核对端口
node <skill目录>/scripts/serve-target.mjs stop <控制目录> --state runtime/source-runtime.json
```

基线要求同一测试数据、账号/权限、视口、语言/时区、字体和浏览器版本。数据不同造成的文本/表格差异不能算迁移回归，也不能用忽略规则掩盖。老工程无法启动时记录原因，视觉维度默认阻塞；经用户批准可在 `project.json.acceptance` 中降级，但最终只能报告“视觉维度未验证”。

## 3. 托管运行

```sh
node <skill目录>/scripts/serve-target.mjs start <控制目录>
node <skill目录>/scripts/serve-target.mjs status <控制目录>
node <skill目录>/scripts/serve-target.mjs stop <控制目录>
```

- 启动优先使用 `acceptance.command`，否则用项目包管理器执行 `acceptance.runScript`。Vite 项目通常配置 `args: ["--", "--host", "127.0.0.1", "--port", "{port}", "--strictPort"]`，避免自动换端口。
- `acceptance.url` 与端口必须匹配；就绪以 HTTP 响应为准，不以日志出现“ready”为准。
- 端口已被占用时拒绝启动，不结束未知进程；需要换端口就改配置或 `--port`。
- 状态文件记录 PID、命令、地址、日志、就绪/停止时间；`stop` 通过进程树结束并轮询端口释放，仍被占用时报告失败。
- 运行期间日志写在控制目录，可直接读取；Windows 下由内部 wrapper 转发，避免日志被独占。
- 交付前必须 `stop`；临时服务不得挂着。需要长期运行时，由用户自己启动并明确告知。

## 4. HTTP 巡检

`probe-routes.mjs` 对每个入口检查：HTTP 状态、Content-Type、HTML 中的挂载节点、同源 script/link 资源。它不能证明页面渲染或交互，但能快速发现 base/路由回退/资源路径/开发服务器编译错误。

失败处理：开发服务器 500 先看日志与 `check-sfc.mjs`；404 检查 base、history 回退、public 资源；资源 404 检查 alias、动态导入与子路径部署。

## 5. 浏览器审计

每个入口：

1. 打开页面，等待 `domcontentloaded` + 网络空闲（有上限）+ 短暂稳定。
2. 判定失败：导航错误、`vite-error-overlay`/webpack 错误遮罩、接近空白、挂载节点无内容、控制台错误、页面异常、失败请求、严重 Vue 警告（`Invalid prop`、组件解析失败等）。
3. 采集 DOM 指纹（可见节点标签/角色/尺寸档位、控件数量、文本）、截图、接口调用。
4. 有基线时计算：像素相似度（32×32 网格 RGB 平均差）、文本 token 相似度、结构相似度；加权为 0.4/0.3/0.3。

接口通过浏览器实际请求捕获：记录 xhr/fetch 的 method、路径、状态；开发服务器内部请求、favicon、HMR 等噪声按 URL 过滤，切页导致的 `net::ERR_ABORTED` 不算失败。控制台过滤规则在 `project.json.acceptance.ignoreConsolePatterns`/`ignoreRequestPatterns` 中追加，必须有明确理由，不能用来隐藏业务错误。

浏览器获取：优先控制目录独立安装 Playwright（`tools/browser`）；或使用本机 Chrome/Edge（`--channel chrome`、`--browser-executable`）。目标工程依赖不加入验收工具。缺少浏览器时本次验收不能通过。

## 6. 接口契约

- 从能力清单抽取源接口（method + 归一化路径），归一会把数字/UUID/日期/长随机串变为占位符，允许代理改写前缀时的整段后缀匹配。
- 目标侧以浏览器实际请求为准；同一接口的多次调用合并状态集合。
- 判定：源接口必须至少被调用一次，且没有 5xx；未覆盖接口逐条列缺口。4xx 记录提醒，需结合场景判断是否为预期校验/未登录。
- 仅 mock 通过、或只验证 adapter 配置，不能算真实接口验收；无后端时保留固定响应重放证据，并把真实集成列为未验收。
- 真实写操作只对已授权测试环境与可回收数据执行；生产环境禁止自动结算、删除与真实付款。

## 7. 复原度评分与门禁

| 维度 | 权重 | 通过判定 |
|---|---|---|
| 渲染与运行时错误 | 0.25 | HTTP 通过 + 页面渲染通过 + 零错误/失败请求 |
| 视觉与基线相似度 | 0.25 | 每条基线入口相似度 ≥ `minSimilarity`（默认 0.9） |
| 交互场景 | 0.25 | `phase=interaction` 场景全部通过 |
| 接口调用 | 0.15 | 源接口全部被调用且无 5xx |
| 能力覆盖 | 0.10 | 必需能力项被通过场景覆盖或登记 verified |

- 维度不可用时按剩余权重归一，但“缺少证据/未执行”会进入阻塞或降级，不能用归一后的高分冒充完整验收。
- 门禁：总分 ≥ `minScore`（默认 0.99）且阻塞项为空。
- 阻塞项（必须清零才能宣称完成）：任一入口渲染失败、场景失败、源接口未覆盖、能力缺口、5xx、缺少基线且未批准、缺少托管启动/停止证据、服务仍运行/端口未释放。
- `acceptedDifferences` 只用于用户批准的差异，必须含对象、理由、批准人和日期；工具从分母扣除并列出。用它批量豁免页面、接口或能力等于跳过验收。

```json
{
  "id": "AD-001",
  "reason": "源工程打印入口依赖已停用的 LODOP 插件，业务确认目标版本改用浏览器打印，页面按钮保留",
  "approvedBy": "业务负责人 / 2026-11-12",
  "scope": { "capabilities": ["print:src/views/report/List.vue"], "routes": [], "api": [] }
}
```
- 视觉相似度受字体、抗锯齿、滚动条、数据与视口影响；阈值只是回归信号。截图必须留给人看，Canvas/图表/地图必须人工复核。

## 8. 修复循环与反作弊

1. 先修阻塞项，再修维度扣分；同一根因检查同类页面/接口。
2. 每次修复用新 `run-id` 重跑完整验收；旧报告不能证明新代码。
3. 禁止：删除/放宽断言、扩大全局忽略、把入口移出路由表、把失败场景标 `omitted`、调低 `minScore`/`minSimilarity`、只跑局部场景就宣称完整通过、伪造截图或人工签字。
4. 允许：登记有依据的允许差异、经批准的降级、明确列出的未验收项。降级时最终答复必须写明“未达到 99% 的维度与原因”。

## 9. 常见失败定位

| 现象 | 优先检查 |
|---|---|
| HTTP 404/空白 | history 回退、base、路由 base、部署子路径、挂载节点选择器 |
| 资源 404 | alias、`public` 路径、动态导入、子路径部署、CSS/字体 URL |
| 页面渲染失败 | 控制台首个错误、Vue 警告、组件解析、模板 ref、UI 库插件注册 |
| 场景按钮点不到 | 选择器是否随组件库变化、是否被遮罩/条件渲染、等待条件是否错误 |
| 请求未覆盖 | 场景未触发、接口路径前缀改写、鉴权失败、请求被 mock 拦截 |
| 视觉相似度低 | 字体/视口、布局回归、组件库样式适配层、数据不一致、动画未稳定 |
| 能力缺口 | 场景未覆盖、能力项误报、功能确实缺失或已下线 |

## 10. 命令速查

```sh
# 一键：启动 → HTTP → 浏览器/场景 → 停止 → 评分
node <skill目录>/scripts/acceptance.mjs <控制目录> --run-id r01

# 分步
node <skill目录>/scripts/serve-target.mjs start <控制目录>
node <skill目录>/scripts/probe-routes.mjs <控制目录> evidence/runs/r01/http.json
node <skill目录>/scripts/browser-audit.mjs <控制目录> evidence/runs/r01/ui.json --baseline evidence/baseline
node <skill目录>/scripts/fidelity-report.mjs <控制目录> evidence/runs/r01/fidelity.json evidence/runs/r01/fidelity.md --probe evidence/runs/r01/http.json --ui evidence/runs/r01/ui.json
node <skill目录>/scripts/serve-target.mjs stop <控制目录>
```

退出码：`0` 表示门禁通过；`2` 表示验收未通过（存在阻塞项或分数不足）；`1` 表示工具、输入或启动错误。`2` 不能当成“已执行所以完成”，必须继续修复或登记缺口；只有 `0` 才能宣称自动验收通过。运行目录名唯一，重跑换 `--run-id`，不覆盖旧证据。
