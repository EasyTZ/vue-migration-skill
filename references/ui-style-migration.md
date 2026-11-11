# 组件库样式与几何迁移

> 条件章节：仅在源工程与目标工程命中组件库（如 Element UI → Element Plus）时使用。下列类名、默认值来自实测示例，具体以目标版本实际 CSS、DOM 与源码为准；其他组件库按官方指南建立同等检查项。
>
> 这些差异的共同点：**不报错**。lint、类型检查、构建、SFC 编译全绿，页面却变矮、变窄、错位或被裁切；只有几何回归、计算样式或现场验收能发现。

## 0. 原则

- UI 库升级不只是组件 API 与插槽，**几何契约**（控件高/宽、栅格、表格行高、弹窗与抽屉内边距）同样是迁移范围。
- 先建**一个全局样式适配层**，再迁页面；不要把同一组尺寸修正散落到几十个组件的 `<style scoped>` 里。
- 以旧工程**实际渲染出来的有效样式**为基线，不以源码里写了什么为准（见 §5）。
- 允许差异（字体档位、字体图标改 SVG 等）单独登记，不能用来掩盖布局回归。

## 1. 全局样式适配层

- 只在入口引入一次：库基础样式 → 适配层 → 项目既有主题/公用样式。**适配层必须排在库 CSS 之后**，否则同权重覆盖不生效；在构建产物里检查规则先后，而不是只看源码 import 顺序。
- 用 token 管尺寸，不要在各处写魔法数字：

```scss
$control-height: 32px;        // 旧全局 default（如 element-ui 的 small）
$control-height-small: 28px;  // 旧 mini
$control-height-large: 36px;  // 旧 medium
$control-width: 200px;        // 行内表单控件默认宽
$date-width: 220px;
```

- 覆盖规则至少与库规则同权重且更靠后。默认宽度这类“可被页面覆盖”的值，把宽度工具类（`.w160` 等）的规则写在默认规则**之后**（同权重靠顺序胜出）；行内 `style` 天然优先。
- 页面级特殊外观（例如登录页只用下划线的输入框）留在页面；库级尺寸、栅格、弹窗结构放全局层。
- Teleport 的弹窗/抽屉/下拉内容不在页面组件作用域内，内部元素的样式必须放全局层或**不带 scoped** 的样式块，并挂一个唯一类名限定范围。

## 2. 控件尺寸矩阵

只改根尺寸变量通常不够：目标库很多组件把 small/large 写死，或只跟随部分变量。以 Element Plus 实测为例：

| 控件 | default | small | large | 覆盖点 |
|---|---|---|---|---|
| input / date-picker | 32px | 28px | 36px | 跟随 `--el-component-size*`，改变量即可；textarea 是多行控件，不按此固定高度 |
| button | 32px | 28px | 36px | 主题层按三档定义高度 |
| select 触发器 | 32px | **24px** | **40px** | `.el-select--small/.el-select--large .el-select__wrapper` 写死 |
| radio / switch | 32px | **24px** | **40px** | `.el-radio--small` / `.el-switch--small` 等写死 |
| checkbox | 32px | **32px** | **32px** | 高度由内容决定，不随尺寸变（`--el-checkbox-height, 32px`） |
| form-item label/content 行高 | 32px | **24px** | **40px** | `.el-form-item--small/--large` 写死 |

- 按旧版档位统一到同一套高度（常见 32 / 28 / 36），select、单复选、开关、label 行高都要覆盖；否则同一行会出现 24/28/32/36/40 混排。
- large 尺寸常被上下 padding 撑大：例如 select large 默认上下各 8px，`min-height: 36px` 仍会得到 40px，需要压 `padding-top/bottom` 或直接给 `height`。
- 改完逐个控件核对实际高度，不要只改 `:root` 变量就宣布完成。

Element Plus 的一组可直接复用的覆盖示例（数值按旧版档位替换）：

```scss
:root {
  --el-component-size: 32px;
  --el-component-size-small: 28px;
  --el-component-size-large: 36px;
}

.el-select--small .el-select__wrapper { min-height: 28px; }
.el-select--large .el-select__wrapper {
  min-height: 36px;
  padding-top: 5px;      /* 默认上下 8px 会撑到 40px */
  padding-bottom: 5px;
}

.el-radio--small,  .el-checkbox--small,  .el-switch--small  { height: 28px; }
.el-radio--large,  .el-checkbox--large,  .el-switch--large  { height: 36px; }

.el-form-item--small .el-form-item__label   { height: 28px; line-height: 28px; }
.el-form-item--small .el-form-item__content { line-height: 28px; }
.el-form-item--large .el-form-item__label   { height: 36px; line-height: 36px; }
.el-form-item--large .el-form-item__content { line-height: 36px; }
```

## 3. 控件宽度

- 目标库的 input/select 常是 `width:100%`；放在行内表单的自动宽度容器里，select/cascader 会缩到占位文字宽甚至只剩箭头，和旁边的 input 不同宽。
- 给行内表单控件统一默认宽度（示例 200px，日期 220px，范围 350/400px），并让显式宽度类与行内 style 优先。
- 日期控件通常也带 input 类名：先按 input 统一宽度、再用更靠后的日期规则覆盖，或把 `.el-date-editor` 从 input 规则中排除；范围、月份、季度范围分别设宽。
- 窄列、弹窗内、行内表单都要实测宽度；“样式表里声明了”不等于“渲染出来有宽度”。

```scss
.el-form--inline .el-form-item__content > .el-input,
.el-form--inline .el-form-item__content > .el-select,
.el-form--inline .el-form-item__content > .el-cascader { width: 200px; }

/* 日期框也带 el-input 类，放在后面把宽度改回来 */
.el-form--inline .el-form-item__content > .el-date-editor { width: 220px; }
.el-form--inline .el-form-item__content > .el-date-editor--daterange,
.el-form--inline .el-form-item__content > .el-date-editor--timerange { width: 350px; }
.el-form--inline .el-form-item__content > .el-date-editor--datetimerange { width: 400px; }

/* 显式宽度工具类放最后（同权重靠顺序胜出；行内 style 仍然优先） */
@each $w in 110, 130, 150, 160, 180, 200, 230, 250, 260, 300, 400 {
  .el-form--inline .el-form-item__content > .w#{$w} { width: #{$w}px; }
}
```

## 4. DOM 结构差异清单

### 4.1 输入框

- 目标库可能把背景、边框、圆角、内边距移到外层 wrapper，`input` 本身只剩原生属性（Element Plus：`.el-input__wrapper` vs `.el-input__inner`）。旧工程写在 `.el-input__inner` 上的边框/底色/圆角会静默失效，只留下高度和 padding，表现为“旧样式没生效，但框变高了”。
- prefix/suffix 可能从绝对定位改成 flex 子项：只写 `left:0` 不再生效，图标与文字的间距、眼睛图标位置都会变；需要时把 prefix 改回绝对定位并固定宽度，或改用目标库的 padding 方案。
- 焦点/错误态的整圈描边常由 wrapper 的 `box-shadow` 提供，下划线式输入框要用更高权重清掉，否则聚焦/校验时冒出方框。
- 检查模板里所有覆盖 `.el-input__inner` 的页面级样式，逐条判断该挂到 wrapper 还是 input。

```scss
/* 下划线式输入框：外观挂 wrapper，文字仍在内层 input */
.login-field :deep(.el-input__wrapper) {
  height: 3.4em;
  padding: 0;
  border-radius: 0;
  background: transparent;
  box-shadow: none;
  border-bottom: 1px solid rgba(0, 0, 0, 0.1);
}
.login-field :deep(.el-input__inner) {
  height: 100%;
  line-height: 3.4em;
  padding-left: 34px;
}
/* prefix 在 Element Plus 是 flex 子项，旧版是绝对定位 */
.login-field :deep(.el-input__prefix) {
  position: absolute;
  left: 0;
  top: 0;
  width: 25px;
  height: 100%;
  justify-content: center;
}
```

### 4.2 栅格

- 旧库常用 float 栅格（`[class*=el-col-]{float:left}` + 百分比宽度），新库可能改成 flex（`.el-row{display:flex}` + `.el-col-*{flex:0 0 x%; max-width:x%; display:block}`）。
- 新库下 `el-col` 没有 `el-row` 父级时只是被 `max-width` 限宽的普通块：多个列会**上下堆叠**，窄列内容或图表被挤到下方，外层固定高度 + `overflow:hidden` 时还会被裁掉。
- 判断某处是否真的坏：最近祖先是 flex 容器（`el-row`、`el-form-item__content`、`el-radio-group` 等）时列仍能并排；祖先是块级容器或列向 flex 容器（`el-form`、`div`、`el-col`、`el-card` 等）时就是坏的。不要因为局部能用就跳过。
- 修复优先补 `el-row` 包裹，把原来挂在外层 `el-col` 上的 margin/height 移到 row；不要给全局 `el-col` 加 float 兜底——float 对 flex 子项无效，但仍会改变块级父容器下的浮动/高度/清除行为，属于用全局副作用掩盖页面结构问题。
- 用模板 AST 做一次全量扫描：列出 `el-col` 的直接父级，非 `el-row` 且包含多个列或 span<24 的逐个确认，避免只修用户报的那一页。

### 4.3 表格

- 单元格上下留白决定行高：目标库默认值可能与旧库不同，源工程页面覆盖还可能因权重不足从未生效。实测示例：旧库全局 small 表格实际 8px（页面写的 4px 被 `.el-table--small .el-table__cell` 的更高权重覆盖），mini 6px、medium 10px；迁移时按 4px 收会让每行矮 8px。目标库默认若已是 8px，优先删掉源页面那条无效的 4px；需要给 small/large 一并定契约时再显式写 8/6/10。
- 左右留白同样要核（示例旧 10px；新库 default 12 / small 8 / large 16）；单元格内 checkbox/radio 若自带 32px 行高，会把行撑高，需要改回内容高度。
- 行高回归要连带表头一起看；表格 `size` 与旧 `mini/small/medium` 的映射要逐表确认。

```scss
.el-table .el-table__cell       { padding: 8px 0; }  /* 旧全局 small 的实际值 */
.el-table--small .el-table__cell { padding: 6px 0; }  /* 旧 mini */
.el-table--large .el-table__cell { padding: 10px 0; } /* 旧 medium */
.el-table .cell {
  padding-left: 10px;
  padding-right: 10px;
}
```

### 4.4 弹窗

- 新库可能把内边距从“头/体/脚各自 padding”改成“根节点统一 padding、头/体/脚为零”。源工程自定义弹窗按旧模型给头/体/脚铺底色和分割线时，新模型会在灰底外多出一圈白边；需要根节点 `padding:0` 并恢复各段内边距。
- 关闭按钮几何也会变（示例 48×48 贴 0/0 vs 16×16 贴 20/20）；自定义弹窗里按旧尺寸写的 top/right 会让图标明显偏移。
- 页面 `<style scoped>` 里直接写 `.el-dialog__header` 会被编译成 `.el-dialog__header[data-v-x]`，目标库内部元素没有该 scope 属性，规则静默失效；弹窗内部样式放全局层或非 scoped 样式块，并用唯一类名限定。

```scss
/* Element Plus 2.14：根节点统一 padding，头/体/脚自身没有内边距 */
.el-dialog { padding: 0; }
.el-dialog__header { padding: 20px 20px 10px; }
.el-dialog__body   { padding: 30px 20px; }
.el-dialog__footer { padding: 10px 20px 20px; }
.el-dialog__headerbtn { width: 16px; height: 16px; top: 20px; right: 20px; }
```

### 4.5 抽屉

- 内容区可能新增默认内边距（示例 20px），而源工程内容自己带 padding；双层留白会让检索区和表格整体缩进一圈。

### 4.6 上传

- 可点击的上传区可能从 inline-block 改成 inline-flex 横排，图标和提示文字并排；旧样式按“大图标在上、文字在下”的 360×180 虚线框设计，需要恢复竖排并给图标补目标库的图标类（如 `el-icon--upload`），否则图标退回 1em 小图标。
- 不要只凭“类名不在库 CSS 里”就判定失效：目标库可能仍在 DOM 上生成该类（示例 `.el-upload--text` 仍由 `listType` 生成，只是没有样式）。

### 4.7 行内表单

- 项间距与对齐会变（示例旧 10px + `vertical-align:top`，新 32px + 居中）；全站检索区会变松散、窄屏提前换行。
- 行内表单里控件的宽度与高度要一起核，不能只改高度。

### 4.8 失效类名与图标

- 字体图标类（`el-icon-*`）在新库通常不再生成，相关选择器要删或改成 SVG 组件类。
- 默认按钮修饰类（`el-button--default`）、`el-form-item--mini`、`el-submenu*` 等类名会消失或改名，挂在上面的主题样式会整体失效；按实际 DOM 核对，不要凭旧源码记忆。
- “类名不在目标库 CSS 中”不等于“DOM 里没有”：先查组件渲染代码/DOM，再决定删规则。

## 5. 用“有效样式”而不是源码意图做基线

- 源工程里的覆盖不一定生效：先比权重与先后，再比数值。典型例子：

```css
/* 源工程页面样式 */
.el-table--small td { padding: 4px 0; }        /* (0,1,1) */
/* 旧库自身样式 */
.el-table--small .el-table__cell { padding: 8px 0; } /* (0,2,0) —— 实际生效 */
```

  旧版真实行高按 8px 算；迁移时按源码里的 4px 还原，行高会矮 8px。类似情况还有：旧库后续版本改了内部类名，导致旧页面覆盖失效；页面覆盖用了已被移除的修饰类。
- 能取到旧版截图/实际页面时以实际为准；取不到时按旧库 CSS 的权重推演，并在迁移规范里登记“有效值 + 依据”。
- 目标库的内部 DOM 不要求逐字一致，但控件外框高度、宽度、行高、间距必须可解释；把接受的视觉差异（字体 13→14、字体图标→SVG 等）与回归分开登记。

## 6. 验证

- 构建产物顺序检查：在最终 CSS 中确认适配层规则排在库规则之后；同权重覆盖尤其要看。
- 计算样式探针：把构建 CSS 注入 jsdom，挂载一组代表性控件，读取 `min-height`/`width`/`padding`/`line-height`，断言 select、input、radio、checkbox、switch、form-item、表格单元格与目标值一致。探针只能验证级联，最终高度仍需按盒模型核算并配合现场验收。
- 页面样式回归清单：登录页、行内查询栏（small 与 default 两档）、列表/表格页、带自定义头体脚色的弹窗、抽屉、上传区，以及所有使用裸 `el-col` 的页面。
- 现场截图/人工验收与新旧对拍；样式差异按“允许差异”单独列，不混进功能回归。

## 7. 修复顺序

1. 全局适配层：尺寸 token、控件高度/宽度、结构差异。
2. 全站同类扫描：模板 AST 找裸 `el-col`，grep 找 `.el-input__inner`/`.el-dialog__header`/表格 padding 等失效覆盖，逐条登记。
3. 页面级特殊外观。
4. 门禁 + 计算样式探针 + 页面样式回归 + 人工验收。
