# 版本适配检查

对照源/目标实际安装版本及官方迁移文档，以下是候选风险，不能机械替换。依赖内部行为的结论应有最小复现或源码依据。

## Vue 与构建

- 模板 ref 不与业务数据同名，使用 `xxxRef`；检查父组件调用并用 defineExpose 暴露必要方法。关注 ref 在条件渲染、异步组件及首次打开时的可用时间。
- 删除无指令、无插槽作用的嵌套 template 包装；保留有 v-if/v-for/v-slot 等语义的节点。裸 template 编译成原生元素可能隐藏内容，应以编译结果与实际渲染确认。
- 带作用域插槽的 template 上，若 v-if 引用了插槽参数，把条件移入插槽内部；引用父作用域的条件可能合法，不要一律改写。
- 检查 v-if/v-for 优先级、数组 watch 深度、属性透传与多根节点、emits、v-model/.sync、事件总线、filters、functional/render/JSX、Vue.set/delete、$children、$listeners/$scopedSlots、生命周期与插件安装。
- `<Transition>` 的动画目标需满足元素根约束，`<KeepAlive>` 核对当前活动组件、名称和缓存键；`<TransitionGroup>` 用于带稳定 key 的多个子项，不应强制改成单子项。组件改成多根或插槽透传后，按页面核对过渡、页签缓存和列表动画是否仍在生效。
- Vue 2 class 构造初始化、装饰器默认值、watch immediate/deep、this 上下文不能仅做文本替换。函数型 prop 的默认值必须仍返回调用方预期的类型，补不传 prop 的运行测试。
- webpack alias、require.context、动态资源路径、process.env、Buffer/process 等 Node 垫片逐项迁移。`NODE_ENV === development` 不总与 Vite DEV/MODE 等价，按构建发布方式验证。

## UI 库适配（仅在源库与选型命中时）

下列以 Element UI → Element Plus 为例，只在本项目确实选择此路线时使用，不据此安装指定 UI 库。其他 UI 库、无 UI 库或自研组件按源依赖和目标官方指南建立对应检查项。任何具体库名均为条件示例，不是强制依赖表。

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

## Router query 兼容（按需启用）

优先遵循源已有的序列化契约；不要给所有项目全局安装“JSON 自动还原”。确认源依赖是否在内存 query 中放对象，再决定页面显式序列化或项目级兼容层，并记录用户接受的差异。

自定义 parse/stringify 会改变整个路由系统，应先复用选定版本的官方标量编码/解码规则，扩展对象部分；不要直接复制未经测试的简化实现。必须覆盖：

- 普通字符串、数字/布尔输入、空串、null、undefined、重复键与数组。
- 空格与 +、Unicode、百分号、畸形编码、保留字符。
- constructor/toString/__proto__ 等键，用无原型对象及自身属性判断避免继承键干扰。
- JSON 外观的普通字符串与真实对象可区分；数组/嵌套数组不被误当重复键。
- push/replace、resolve、刷新、返回前进、外部直达和路由复用。

刷新恢复对象是新增行为，不能标为零差异。URL 也可能泄露整行数据或超长，避免把秘密、token、敏感业务对象编码进地址。明确全局 Router 类型和边界校验，不用 any 掩盖应用数据类型冲突。

## 绘图库与外部资源

Pixi/ECharts/地图/MQ 升级单列适配：异步初始化取消、资源共享所有权、事件体系、坐标/缩放、销毁、重进页面与错误恢复。不要把某个 Pixi destroy 参数当作普适方案；按所用版本和共享纹理策略验证。图表旧 option 的兼容告警/静默忽略需要截图与数据断言，不能只看构建。
