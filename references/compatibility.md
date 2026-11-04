# 版本适配检查

对照源/目标实际安装版本及官方迁移文档，以下是候选风险，不能机械替换。依赖内部行为的结论应有最小复现或源码依据。

## Vue 与构建

- 模板 ref 不与业务数据同名，使用 `xxxRef`；检查父组件调用并用 defineExpose 暴露必要方法。关注 ref 在条件渲染、异步组件及首次打开时的可用时间。
- `<script setup>` 按名字把模板 ref 绑到同名顶层变量，所以与数据同名时会串值：首次渲染 `dataTable.value` 还是 `null`，不报错；挂载时 `ref="dataTable"` 把组件实例写进同一个 ref，触发的那次重渲染才让 `:data="dataTable"` 收到组件实例而不是数组。后果是表格遍历数据时报错（如 `xxx is not iterable`）、该块更新中断，表现为空白、按钮无响应。lint、类型检查和构建通常都发现不了（只有 ref 声明了具体类型且开启模板类型检查时，vue-tsc 才可能发现），只有实际挂载才暴露。迁移时先确认模板 ref 是否有读取点（含动态 `$refs` 访问、父组件调用），死 ref 再删除，要留的改名成 `xxxRef`，并按[验证与交付证据](verification.md)的挂载冒烟确认。
- 删除无指令、无插槽作用的嵌套 template 包装；保留有 v-if/v-for/v-slot 等语义的节点。裸 template 编译成原生元素可能隐藏内容，应以编译结果与实际渲染确认。
- 带作用域插槽的 template 上，若 v-if 引用了插槽参数，把条件移入插槽内部；引用父作用域的条件可能合法，不要一律改写。
- 检查 v-if/v-for 优先级、数组 watch 深度、属性透传与多根节点、emits、v-model/.sync、事件总线、filters、functional/render/JSX、Vue.set/delete、$children、$listeners/$scopedSlots、生命周期与插件安装。
- `<Transition>` 的动画目标需满足元素根约束，`<KeepAlive>` 核对当前活动组件、名称和缓存键；`<TransitionGroup>` 用于带稳定 key 的多个子项，不应强制改成单子项。组件改成多根或插槽透传后，按页面核对过渡、页签缓存和列表动画是否仍在生效。
- Vue 2 class 构造初始化、装饰器默认值、watch immediate/deep、this 上下文不能仅做文本替换。函数型 prop 的默认值必须仍返回调用方预期的类型，补不传 prop 的运行测试。
- webpack alias、require.context、动态资源路径、process.env、Buffer/process 等 Node 垫片逐项迁移。`NODE_ENV === development` 不总与 Vite DEV/MODE 等价，按构建发布方式验证。
- 手动渲染的保留页/多页签：父级 `visibility:hidden` 藏不住 teleport 到 body 的浮层（日期面板、下拉、tooltip），切页后旧页浮层还留在屏幕上，visibility 本身也仍参与绘制。改用独立容器 + `v-show`（display:none）整体停止绘制，并逐页验证切页后无残留、无重复实例。
- 把 `position:absolute; width:100%; height:100%` 这类定位与尺寸放在业务组件上，依赖的是单根 attrs 透传：页面改成多根、或被插槽/过渡包一层后，style 会静默丢失，表现为高度塌陷、滚动条错乱、页脚悬空。定位应落到包装层，并逐页核对根节点。

## UI 库适配（仅在源库与选型命中时）

下列以 Element UI → Element Plus 为例，只在本项目确实选择此路线时使用，不据此安装指定 UI 库。其他 UI 库、无 UI 库或自研组件按源依赖和目标官方指南建立对应检查项。任何具体库名均为条件示例，不是强制依赖表；下列类名、默认值与选择器以目标版本实际 DOM、样式表或源码为准，不照搬其他项目结论。

- Dialog visible.sync 通常映射 v-model；单向 visible + 自定义关闭协议需保留单向语义。before-close、关闭动画、destroy-on-close、Teleport 与首次打开时序实际测试。
- 不可假设旧 Dialog 首次打开前总有子组件 ref；旧库本身也可能懒渲染。迁移应以源组件实现与调用顺序为准。
- slot/slot-scope 改具名及作用域插槽；mini → small；submenu → sub-menu；旧图标类改图标组件，同时核对 CSS。
- input/select 等受控 value 按目标 API 改 model-value，option 的 value 保留；checkbox/radio 的 label/value 语义按精确版本核对。
- DatePicker/TimePicker 的 format/value-format 按格式化引擎分别处理：旧常见 yyyy → YYYY、dd（月内日期）→ DD；Day.js dd 是星期缩写，ddd/dddd 保留。单个 d 语义不同。不改 moment 或其他库的格式串。动态绑定和 JS 配置也必须核对。
- default-time 按目标控件要求转换 Date 或 Date[]，核对时区、范围、清空值和提交串。
- cascader 的 checkStrictly/expandTrigger 迁到 props 前核对源是否已有覆盖配置；不能让旧无效属性突然生效。
- table selection 使用公开 API；校验 prop/rules、validate 返回值、表格布局、分页事件、popover/tooltip、空值和取消行为逐项测试。
- /deep/、>>> 等改 :deep()，所有 .el-* 内部样式覆盖列清单做视觉回归。纯文本按钮转 link/text 按语义与样式选择。
- 按需引入与全量引入二选一并在项目级统一：unplugin-vue-components/unplugin-auto-import 的解析器、生成器文件和 `ElConfigProvider` 用法随引入方式变化，混用会出现样式缺失或重复。样式引入顺序（Element Plus 基础样式在前、项目覆盖在后）与新引入方式一起核对。
- 语言与格式化：locale（如 zh-cn）需通过全局配置或 ElConfigProvider 注入，并同步 Day.js 语言包与页面里手工格式化的部分；旧库默认中文不会自动延续。
- 图标：旧图标类名改图标组件后，同时核对 CSS 尺寸、颜色继承与 aria 标签；`@element-plus/icons-vue` 的按需/全量注册方式与引入方式保持一致。
- 表单控件在 flex 布局里会被压扁，而且不报错：Element Plus 的表单内容区（`.el-form-item__content`）是 `flex + min-width:0`，日期框等固定宽度的控件既可能被输入框的宽度规则覆盖，又会被压到 min-content；结果是日期框只剩一个图标、日期文字被裁掉，看起来像“数据没取到”。只改 CSS 变量往往无效，需要抬选择器优先级（如 `form.el-form .el-date-editor`）并补 `min-width` 兜底；行内表单里的 select/cascader 同样会缩成只剩箭头。在窄列里实测控件宽度，不能只看样式表是否“声明了”。
- 表格的高度契约不同：Element Plus 的 `.el-table` 默认按内容高度（`height:fit-content`）而不是 `flex:1`，放在列向 flex 的页面根容器里不再撑满，页脚浮在中间、下方大片留白。只给“页面根容器直接子项”补 `flex:1`；不要写成全局 `.el-table{flex:1}`——Element Plus 的 `el-row` 自身就是 flex 容器（旧版是浮动），全局补会改变“表格直接放在 el-row 里”的宽度分配。
- 无 type 按钮的修饰类按实际 DOM 核对：Element Plus 的默认按钮不带 `el-button--default`（旧版本带），挂在该类上的主题样式会整体失效。改用 `:not(.el-button--primary, …)` 覆盖默认态，并对全部无 type 按钮做一次样式回归。
- 组件 API 的失效属性逐项清理：`el-radio` 的 `:label` 当值已弃用改 `:value`；`button type="secondary"` 不存在；`rows` 传字符串会持续告警（改 `:rows` 数值）。这类问题不报错，只是静默失效或刷控制台告警，按 lint 与控制台逐条核。
- 给业务弹窗写的样式不要挂通用 `.el-message-box` / `.el-dialog` 类：页面加载后会把宽度、内边距污染到其他确认与提示框；用独立 class 限定作用范围。
- el-menu 的选中态不要直接改子组件内部值：改成 `:default-active` 响应式绑定；切换栏目时用 `:key`（栏目根路径）重建菜单，祖先节点的 `open()` 放到 nextTick 里。`default-active` 变化不会带动祖先展开，只改它会出现“选中项在深层页面上、目录却还是收起”的情况。

## 日期与时间（按需）

- 时间字段常带定长空格补位、8/12/14 位紧凑数字串、秒与毫秒混用：直接 `new Date()` 或格式化会得到 `Invalid Date` 或差 8 小时。统一解析入口先 trim/判空，按位数与量级分支，ISO 的 `Z` 是否换算时区按源契约保留；表格、导出、详情共用同一函数。
- 格式化与解析走同一套入口和 locale（Day.js 或项目选定库），不要在页面里混用 `new Date()`、库格式化和手写拼接；时区按源契约固定，不依赖浏览器本地时区。

## 路由表与跳转目标（有路由时）

只搬页面、漏搬路由不会报任何错：新版路由对未匹配路径不抛异常，若目标工程又带“未匹配路径 → 默认首页”的兜底重定向（管理后台常见），按钮的落点就变成**另一个页面**——现场看到的是“跳错页/路由乱跳”，不是报错。装了兜底之后，开发期本来会打的 `No match found` 警告也一起消失。

- 不在菜单里的子页面（表单、详情、日志、类型管理等）最容易被漏登记。逐个核对按钮来源：`push({ path })`、`push({ name })`、`<router-link>`、返回封装、菜单项，目标都必须能在目标路由表里解析，且指向同一个业务页面。
- 命名路由要显式登记 `name`。搬运或生成路由时只留 `path`、丢掉 `name`，用 `{ name }` 跳转的按钮会解析不到目标（落到兜底页或空白），症状与路径未登记相同。
- 相对路径本身两版都按当前路径的父级目录解析（当前 `/user/1` 时 `push('edit')` 落到 `/user/edit`），真正变的是选项：Vue Router 4 移除了 `append`，旧代码 `push({ path: 'edit', append: true })` 或 `<router-link append>` 会拼到当前路径后（`/user/1/edit`），新版忽略 append 后落到 `/user/edit`，正好差一层。用 `resolve(目标, currentRoute)` 按目标版本复算落点，不要靠字符串拼接推算；能写绝对路径或命名路由时优先写绝对路径。
- 迁后路径可能多出或少掉一段（同名层级被展开、模块目录调整）。所有与当前路径比较的硬编码字符串（返回后刷新、埋点、页签高亮）都要跟着改：不相等不会报错，只是逻辑永久不生效，还常让“刚返回过”这类全局标志一直停在 true，影响后续导航。
- 路由项存在不等于页面存在：批量生成时可能整页漏搬。补齐路由前先确认 `component` 指向的文件真实存在且不是占位页，缺页回到源工程补写，否则按钮要么没反应、要么落到兜底页。
- 未知路径兜底要留下可观测信号（警告、404 页或埋点），不要静默重定向到首页：开发期路由自带的 `No match found` 警告在装了兜底重定向后就不再出现，漏登记的路由会彻底静默。
- 兜底本身会和默认页打转：默认页取自后端菜单、而前端还没有对应路由时，“未匹配 → 默认页 → 仍未匹配”会一直自跳，表现为白屏且退不出去。落地页要先用静态路由表过滤，一个都解析不到就提示并退出登录，不能再 `next` 到同一地址。
- 目录型路由（只有 children、没有 component）在直接访问父路径时能匹配但没有组件可渲染，菜单允许点进栏目时主区域就是空白。给目录补 redirect 到默认子页（或空组件），并确认侧栏与面包屑仍正常。
- 菜单高亮、面包屑按完整路径前缀匹配，不要拿 URL 段数去对齐菜单层级：迁移时嵌套路由常被展开成一级记录，层级已经不一致，按段数匹配会错位或丢高亮。
- 把这套核对沉淀成项目测试：展平路由表 + 扫描导航调用 + 断言目标可解析，交给构建门禁跑。未匹配时 `resolve()` 不抛异常，断言要看 `matched.length` 或 `hasRoute(name)`，不能用 try/catch；动态路由（`addRoute`、后端菜单下发）要在注册完成后展平，或分别断言静态表与菜单来源。别只断言“路由总数”这类计数——计数挡不住漏登记，只会在新增页面时误报。

## Router query 与参数

直达、刷新或从外部链接进入时，`route.query` 可能整个为空，参数也可能只带一部分：渲染期直接读 `route.query.row.id` 会抛 TypeError，表现为白屏且错误只在控制台。读取前兜底；“缺参”与“空串”语义不同——补空串可能被后端当成过滤条件，缺参应保持 undefined 或不发送该字段。

优先遵循源已有的序列化契约；不要给所有项目全局安装“JSON 自动还原”。确认源依赖是否在内存 query 中放对象，再决定页面显式序列化或项目级兼容层，并记录用户接受的差异。

自定义 parse/stringify 会改变整个路由系统，应先复用选定版本的官方标量编码/解码规则，扩展对象部分；不要直接复制未经测试的简化实现。必须覆盖：

- 普通字符串、数字/布尔输入、空串、null、undefined、重复键与数组。
- 空格与 +、Unicode、百分号、畸形编码、保留字符。
- constructor/toString/__proto__ 等键，用无原型对象及自身属性判断避免继承键干扰。
- JSON 外观的普通字符串与真实对象可区分；数组/嵌套数组不被误当重复键。
- push/replace、resolve、刷新、返回前进、外部直达和路由复用。
- 自定义 stringify/parse 要与官方默认行为逐条对齐：数组展开成重复 key；重复 key 读回时聚成数组而不是后者覆盖；`null` 输出成只有 key、不带 `=`；不要自己加前导 `?`，否则会拼成 `??a=1`。

刷新恢复对象是新增行为，不能标为零差异。URL 也可能泄露整行数据或超长，避免把秘密、token、敏感业务对象编码进地址。明确全局 Router 类型和边界校验，不用 any 掩盖应用数据类型冲突。

## 绘图库与外部资源

Pixi/ECharts/地图/MQ 升级单列适配：异步初始化取消、资源共享所有权、事件体系、坐标/缩放、销毁、重进页面与错误恢复。不要把某个 Pixi destroy 参数当作普适方案；按所用版本和共享纹理策略验证。图表旧 option 的兼容告警/静默忽略需要截图与数据断言，不能只看构建。

- Pixi 8 起用 `eventMode` 控制命中测试：覆盖层、装饰层（告警光晕、通行箭头等）默认参与交互，叠在设备上会导致设备点不动、拖不动，需显式 `eventMode="none"`；旧版本对应 interactive/hitArea 开关，按所用版本核对。
- 文字纹理按最终显示比例超采样：用 `1/min(scaleX, scaleY)` 与渲染器分辨率取较大值，只在比例变化时重建；否则画布整体缩小时文字会被降采样发糊，按实际缩放区间截图核对清晰度。
