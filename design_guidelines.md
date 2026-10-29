# design_guidelines.md — AI 智能课堂签到助手

> 本文件是**视觉规范 + 组件选型原则**，不是组件实现文档。通用 UI 一律复用 `@/components/ui/*`。

## 1. 品牌定位

- 应用定位：面向高校课堂的场景化签到 + AI 智能助理工具。
- 设计风格：安静、可信、有温度（晨光米白纸 + 墨字 + 黑板绿）。
- 目标用户：教师（发起/管理签到）、学生（绑定/签到）。

## 2. 配色方案（Tailwind 类名）

| 语义 | Tailwind 类名 |
| --- | --- |
| 主色/强调 | `bg-green-600` `text-green-600` `border-green-600` |
| 主色按下 | `bg-green-700` |
| 危险/缺勤 | `bg-red-600` `text-red-600` |
| 警示/补签 | `bg-amber-600` `text-amber-600` |
| 页面背景 | `bg-stone-50` |
| 卡片 | `bg-white` |
| 主文字 | `text-stone-900` |
| 次文字 | `text-stone-500` |
| 边框 | `border-stone-200` |

语义色（成功/失败/提示）：`text-green-600` / `text-red-600` / `text-amber-600`。

## 3. 字体规范

- 标题 H1：`text-2xl font-bold text-stone-900`
- 区块标题：`text-base font-semibold text-stone-900`
- 正文：`text-sm text-stone-700`
- 辅助/Caption：`text-xs text-stone-500`
- 数字（倒计时/统计）：`tabular-nums font-semibold`

## 4. 间距系统

- 页面边距：`px-4`；页面顶部留白：`pt-4`
- 卡片内边距：`p-4`
- 列表项间距：`gap-3`；区块之间：`gap-4`
- 使用 Tailwind `gap-*`，不用 `margin` 堆叠。

## 5. 组件使用原则（组件选型约束）

**通用 UI 组件必须优先来自 `@/components/ui/*`，禁止用 `View/Text` 手搓。**

新页面实现前，先拆分 UI 单元并映射到组件库：

| UI 单元 | 组件来源 |
| --- | --- |
| 按钮（提交/确认/取消/主次入口） | `@/components/ui/button` |
| 单行输入（学号/姓名/口令/课程名） | `@/components/ui/input` |
| 多行输入（名单粘贴） | `@/components/ui/textarea` |
| 弹窗（发布签到确认、补签、二次确认） | `@/components/ui/dialog` |
| 危险操作确认（取消任务等） | `@/components/ui/alert-dialog` |
| 卡片/分组容器 | `@/components/ui/card` |
| 状态标签（进行中/已截止/已签到/缺勤） | `@/components/ui/badge` |
| 分段切换（去签到/历史） | `@/components/ui/tabs` |
| 加载骨架屏 | `@/components/ui/skeleton` |
| 空状态 | 用 `@/components/ui/card` + 文案，不自造 |
| 结果轻提示 | `@/components/ui/toast` / `sonner` |
| 分割线 | `@/components/ui/separator` |

仅当组件库确实缺失时（如 `Camera/Canvas` 等原生能力）才直接使用 `@tarojs/components`。

## 6. 导航结构

- 无 TabBar（角色驱动：学生端 / 教师端）。
- 身份入口 `pages/index/index`：根据角色 `redirectTo` 学生端或教师端。
- 普通跳转用 `navigateTo`，登录/退出用 `redirectTo` / `reLaunch`。

## 7. 状态展示原则

- 加载态：`Skeleton` 骨架屏。
- 空态：`Card` 内居中展示「暂无数据」+ 引导文案。
- 统计数字：`tabular-nums` 保持等宽对齐。

## 8. 小程序约束

- 静态图片/视频走 TOS 对象存储；仅 TabBar 图标可放本地（本项目无 TabBar）。
- 避免硬编码 `px`；用 Tailwind 预设类名与相对单位。
- 跨端：垂直 `Text` 加 `block`；原生 `Input/Textarea` 用 `View` 包裹样式；`fixed+flex` 用 inline `style`。