# 从老工程抽取验收能力面

用户通常只会说“迁 UI 和接口”。真正要复原的功能藏在老工程里：菜单外的子页面、弹窗里的表单、按钮触发的上传、权限指令、打印、图表、地图、轮询、WebSocket、localStorage 键。本文件规定如何把这些能力抽取成**可执行、可计分的验收项**。

原则：**静态扫描给候选，运行基线给事实，场景给证据。** 三者缺一，复原度分数就不可信。

## 1. 静态抽取

```sh
node <skill目录>/scripts/extract-capabilities.mjs <控制目录> inventory/capabilities-<日期>.json
```

工具遍历源码（排除依赖、产物、控制目录、符号链接），按规则抽取单元。每个单元带稳定 `id`（`kind:detail`）、源文件与行号、严重级别和建议验证方式。

### 1.1 必需项（计入能力覆盖分母）

| kind | 抽取信号 | 典型来源 | 验收建议 |
|---|---|---|---|
| `route` | `path:` + router 文件/`createRouter`/`new Router` | 路由表、动态路由、菜单配置 | 直达、渲染、默认跳转、权限 |
| `api` | `axios.get`/`request.post`/`fetch`/`url:` + method | api 模块、页面直接调用 | 触发操作，核对 URL/method/参数/返回 |
| `form` | `<el-form>`/`<form>`、`v-model`、`prop`、校验 message | 新增/编辑/查询表单 | 留空、非法值、提交、重置、错误反馈 |
| `table` | `<el-table>`/`<table>`/`el-table-column` | 列表页 | 数据、分页、排序、空态、行内操作 |
| `dialog` | `<el-dialog>`/`<el-drawer>`/`<a-modal>` | 弹窗表单、详情 | 打开、关闭、重开、回填、提交 |
| `permission` | `v-permission`/`v-has`/`checkPermission`/`meta.roles` | 按钮/菜单/路由权限 | 有权限/无权限两种账号 |
| `upload` | `<el-upload>`/`input[type=file]`/`FormData` | 附件、导入 | 选择、校验、成功、失败 |
| `download` | `download=`/`createObjectURL`/`saveAs`/`exportExcel` | 导出、附件下载 | 文件名、内容、鉴权 |
| `print` | `window.print`/`printJS`/`LODOP`/打印 | 打印预览 | 内容、分页、样式 |
| `chart` | `echarts`/`new Chart`/`canvas`/`WebGL` | 仪表盘、趋势图 | 渲染、刷新、空数据、销毁 |
| `map` | `AMap`/`BMap`/`leaflet`/`mapbox` | 轨迹、点位 | 加载、点位、交互 |
| `realtime` | `WebSocket`/`EventSource`/`SockJS`/`stomp`/`mqtt` | 消息、告警 | 建立、重连、更新、离开清理 |
| `storage` | `localStorage/sessionStorage` 键、cookie | token、偏好、页签 | 键名、刷新恢复、退出清理 |

### 1.2 提示项（报告提醒，不直接计分）

`timer`（`setInterval`/`requestAnimationFrame`）、`i18n`（`$t`/`useI18n`）、`store`（Vuex/Pinia 调用）、`legacy`（`filters`/`mixin`/`$children`/`$set`/`Vue.prototype`/`.sync` 等）、`worker`。

提示项仍要核对，只是不把所有 `setTimeout` 都变成验收欠账；可在 `capability-status.json` 中主动登记 `verified` 或 `omitted`。

### 1.3 必须回读确认

正则会命中注释、字符串、示例代码、相邻路由配置、第三方封装。抽取后逐条：

- 打开源文件对应行，确认是真实调用而非注释/文档。
- 判断是否动态生成：权限菜单、后端下发路由、`require.context` 批量注册、弹窗内组件，静态路由表可能没有，必须从老工程运行页面补充。
- 判断是否环境开关：只在特定 mode/租户/后端开关出现，登记条件与测试数据。
- 判断是否死代码：无路由、无 import、无动态访问时也不能直接删除，先登记结论。

## 2. 运行基线

老工程能启动时，用 [auto-acceptance.md](auto-acceptance.md) 的基线采集命令，对以下内容留证据：

| 内容 | 用途 |
|---|---|
| 每页面 DOM 指纹与截图 | 视觉/文本/结构对比 |
| 接口请求（method、路径、状态） | 目标接口覆盖对照 |
| 菜单与可见按钮/表单项 | 补全静态漏掉的动态入口 |
| 关键交互（查询、提交、弹窗、分页） | 场景预期基线 |
| 控制台/网络错误 | 区分源缺陷与迁移引入 |

基线必须使用同一账号、测试数据、视口、语言/时区、字体和浏览器；否则差异无法归因。老工程有已知 BUG 时，基线记录“旧行为”，修复后的目标按正确预期断言，并在台账登记差异，不用相似度强行要求复现错误。

## 3. 能力 → 验收映射

```
能力清单 unit
  ├── route  → runtime/routes.json 的入口；渲染维度自动覆盖
  ├── api    → 场景触发 + 浏览器网络；接口维度自动比对
  └── 其他   → 场景 covers（通过后自动覆盖）
              或 runtime/capability-status.json 登记 verified/omitted
```

- 单元 `id` 直接写进场景 `covers`；一个场景可覆盖多个单元。
- 路由单元的 `targetPath` 必须替换成可访问的具体测试路径（如 `/user/edit/1`），不能把 `:id` 或 `*` 直接交给浏览器。
- 只打开页面的路由冒烟不能覆盖表单、弹窗等交互能力；必须写 `phase=interaction` 场景。
- 场景失败时 covers 不算覆盖。
- 不能写自动化断言的能力（打印、原生桥、地图图层、复杂 Canvas）用 `verified` + 证据（截图、日志、人工复核记录），证据放控制目录 `evidence/`。
- 确认功能已下线/不适用时用 `omitted` + 理由；批量省略等于跳过验收，不合法。

## 4. 场景写法

优先稳定选择器：

1. `data-testid`（迁移时保留或补上）。
2. `role` + 可访问名称（`getByRole` 语义等价）。
3. 业务文本（与数据/语言解耦，必要时用 regex）。
4. 避免 `.el-input__inner`、`nth-child`、深层 CSS 等随组件库变化的定位。

每个能力至少覆盖：

- 正常路径：有效输入 → 成功反馈/请求。
- 校验路径：留空/非法值 → 错误提示且不发请求（或符合接口约定）。
- 状态路径：打开/关闭/重开、查询/重置、分页、空数据、失败重试。
- 权限路径：无权限时隐藏/禁用/接口拒绝（两种账号）。

示例（表单 + 弹窗 + 接口）：

```json
{
  "id": "SC-012-新增用户",
  "phase": "interaction",
  "route": "/user",
  "covers": [
    "form:src/views/user/Edit.vue",
    "dialog:src/views/user/Edit.vue",
    "api:POST_/api/users",
    "permission:src/views/user/Edit.vue"
  ],
  "steps": [
    { "action": "click", "selector": "[data-testid='create']" },
    { "action": "expectVisible", "selector": ".user-form" },
    { "action": "click", "selector": "[data-testid='submit']" },
    { "action": "expectText", "selector": "[data-testid='name-error']", "contains": "请输入" },
    { "action": "expectRequest", "method": "POST", "urlContains": "/api/users", "status": 200, "timeout": 3000 }
  ]
}
```

请求断言放在触发动作之后；`expectRequest` 检查的是本场景内已经发生的请求。异步竞态用 `expectText`/`expectVisible` 轮询，不用固定 `wait` 掩盖。

## 5. 覆盖判定与报告

`fidelity.md` 的“能力覆盖”列出：

- 已覆盖（通过场景或 verified）
- 缺口（未被覆盖/场景失败/verified 缺证据）
- 按理由豁免（omitted）
- 提示类未登记（只提醒）

缺口在门禁中阻塞。处理方式只有三种：补场景、补人工证据并登记 verified、经确认登记 omitted。不能通过删除能力清单或清空场景来消除缺口。

## 6. 按能力类型的检查清单

| 能力 | 至少检查 |
|---|---|
| 路由 | base/mode、直达刷新、权限重定向、按钮/返回落点、keep-alive 页签 |
| 表单 | 必填/格式/长度/异步校验、清空、重置、重复提交、日期/金额单位 |
| 表格 | 分页、排序、筛选、空态、加载态、行操作、字段格式化 |
| 弹窗 | 打开/关闭/重开、回填、遮罩、销毁后状态、样式污染 |
| 权限 | 菜单/按钮可见性、接口 401/403、退出后缓存清理 |
| 上传 | 类型/大小校验、进度、失败重试、多文件、鉴权头 |
| 下载/导出 | 文件名、编码、空数据、大数据、鉴权与错误提示 |
| 打印 | 打印样式、分页、隐藏控件、图片/表格跨页 |
| 图表/地图 | 首次渲染、数据刷新、空数据、销毁重建、Canvas 截图 |
| 实时 | 连接建立、断线重连、消息更新、离开清理、内存增长 |
| 存储 | 键名/格式兼容、刷新恢复、多页签、退出清理 |
| 定时器 | 创建、暂停、卸载、重进页面不重复 |

## 7. 降级与诚实

- 老工程不可启动：视觉基线缺失，默认阻塞；经用户批准降级后，报告中“视觉维度未验证”，不能宣称 UI 复原度 99%。
- 后端/账号不可用：用固定响应重放验证页面行为，但接口维度与真实集成列为未验收。
- 浏览器不可用：HTTP 巡检可以跑，但 UI/交互/视觉维度未验收，门禁不通过。
- 工具抽取不到的能力（动态菜单、后端生成页面）必须从运行基线或用户确认补充；不能把“工具没扫到”当作不存在。

能力清单和场景是迁移过程资料，留在控制目录；目标工程只保留项目自身测试。新工程里出现的场景/能力清单/验收证据属于越界，`check-boundary.mjs` 会报告。
