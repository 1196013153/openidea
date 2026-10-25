# 核心体验运行验收补测（2026-10-25）

本轮按用户缩小后的“核心体验”范围执行，**27个明确场景：修复复测后27通过、0失败**。这不是原94项清单全量完成声明；首轮发现的中文漏译及原清单未完成项仍保留。

实际版本：`d3feb05`（功能提交 `1e00ea5` 加版本更新）。macOS 原生调试应用，使用真实窗口、编辑器、已安装语言服务器、实际子进程与磁盘结果。测试项目是 `fixtures/ts-app` 的 `/tmp/idea-parity-qa/core-ts` 副本；Python调试和终端脚本仅写入该副本。首次验收未修改产品源码；随后按用户要求修复下列两处问题，运行版本为 `d3feb05` 加工作区改动，未在本仓库提交；Git验收仅在独立core-git副本里创建QA提交。

通过判定仅针对表内明确写出的步骤。重点编辑、查找、导航、补全、格式化、项目视图和 npm 运行做了亮/暗复测；调试、启动链等执行逻辑没有逐一覆盖所有主题和语言组合。数据库、Docker部署、复杂Git图/merge/rebase/worktree、设置导入导出、完整书签/布局/宏管理不在这次缩小后的核心范围内，原清单相关待测项仍保留。

## 修复复测（同日）

- IN-2：保留未过滤的服务器诊断；检查方案编辑时重新投影已完成或进行中的结果，同步严重级别和问题计数，保留排除状态。原生应用亮/暗各验证 error → warning → disabled → restored；还验证了禁用时执行检查，再启用无需重跑即恢复2条诊断。[结构化证据](/tmp/idea-parity-qa/fix-IN2-results.json)、[暗色恢复截图](/tmp/idea-parity-qa/fix-IN2-dark-restored.png)。
- CSS：为共享语言服务器的 CSS、SCSS、Less 配置提供默认对象，避免 workspace/configuration 返回 null。三种文件分别打开 `.qa { colr: red; }`，均返回 unknownProperties 警告；新进程日志无 validProperties 异常。[诊断证据](/tmp/idea-parity-qa/fix-css-results.json)、[原生日志](/tmp/idea-parity-qa/fix-app.log)。
- 验证：前端分析相关10项测试、LSP协议26项测试均通过；pnpm typecheck、原生 debug build、cargo clippy -p ide-lsp --all-targets -- -D warnings、cargo fmt 与 git diff --check 通过。新增回归覆盖方案修改、禁用后恢复、流式检查中修改方案、计数和原始严重级别恢复，以及真实内置配置的协议响应。

## 首次失败记录（已修复，保留复现过程）

### A. IN-2：旧 Inspect Code 结果不随检查方案更新

1. 打开 `src/qa-diagnostic.ts`：`const qaNumber: number = "wrong";`。
2. 默认方案执行 Code › Inspect Code，仅检查当前文件，得到2条 TypeScript 错误。
3. 将 TypeScript 检查严重级别设为 warning：编辑器变为黄色波浪线、Problems 显示 warning；旧 Inspection Results 仍是红色错误。
4. 禁用该检查：编辑器无波浪线、Problems 清空；旧 Inspection Results 仍显示“2 problems in 1 file”。

期望：按 IN-2 的“同时变化”要求，三处采用同一有效方案。实际只有前两处即时更新。亮/暗均复现。[暗色截图](/tmp/idea-parity-qa/core-IN2-repro-dark.png)、[亮色截图](/tmp/idea-parity-qa/core-IN2-batch-disabled.png)、[结构化结果](/tmp/idea-parity-qa/core-IN2-repro-dark.json)。

**边界：重新执行 Inspect Code 后确实得到0条结果**，所以不是方案永远无效，而是已有批量结果的实时同步缺失。[重跑结果](/tmp/idea-parity-qa/core-IN2-rerun-disabled.json)。

实现线索：[inspect.ts](/Users/thomas/repo/kalo/idea/src/features/analysis/inspect.ts:183) 在启动时取得方案，接收事件时过滤一次并保存；[InspectionView.tsx](/Users/thomas/repo/kalo/idea/src/features/analysis/InspectionView.tsx:219) 的树以已有 files 构建，没有将方案变化作为依赖。这与首次运行现象一致；现已按上节修复。

### B. CSS 语言服务器校验抛异常

1. 在副本新建并打开 `src/qa-validation.css`：`.qa { colr: red; }`。
2. 等待已安装的 `vscode-css-language-server` 校验。
3. 日志出现 `TypeError: Cannot read properties of null (reading 'validProperties')`，诊断列表为空，错误属性没有提示。

期望：默认 CSS 校验正常运行并对未知属性给出诊断，不抛异常。新建两个空 CSS 时已出现同一异常；专用错误样例和原生进程重启后再次复现。[运行日志及诊断](/tmp/idea-parity-qa/core-css-validation.json)、[编辑器截图](/tmp/idea-parity-qa/core-css-validation.png)、[重启日志](/tmp/idea-parity-qa/core-app-restart.log)。

首次排查线索为 [handler.rs](/Users/thomas/repo/kalo/idea/crates/ide-lsp/src/handler.rs:119) 的 workspace/configuration：未配置 section 返回 null。现已验证默认配置对象可修复该异常，见上节。

## 完成的核心场景

| 编号 | 结果 | 场景 | 实际验证 | 证据 |
|---|---|---|---|---|
| C01 | 通过 | 编辑与保存 | 输入、撤销、重做、保存磁盘、外部写入自动重载；亮/暗各复测。 | [记录](/tmp/idea-parity-qa/core-edit-confirm-results.json) |
| C02 | 通过 | 常用编辑命令 | 同一行注释/取消注释、复制行，验证实际文档结果；亮/暗各复测。注释命令会移动到下一行，复测时重新定位原行。 | [记录](/tmp/idea-parity-qa/core-edit-commands-final-dark.json) |
| C03 | 通过 | 项目视图与恢复 | 五种视图均切换；Open Files 成目录树；All Changed Files 仅包含被修改的已跟踪 index.ts。结束并重新启动原生进程后仍为 Open Files，23个打开路径与重启前完全一致。 | [记录](/tmp/idea-parity-qa/core-persist-after.json) |
| C04 | 通过 | New 搜索和创建 | 项目树焦点下 ⌘N 出现 Search for file type；css 能找到 Stylesheet。CSS/SCSS/Less、Dockerfile、EditorConfig、gitignore、JSON/YAML/TOML/Shell/HTTP 的磁盘结果沿用首轮实际创建证据。 | [记录](/tmp/idea-parity-qa/core-NF1-dark.png) |
| C05 | 通过 | ⌘N 上下文路由 | Python/Markdown 打开 New，并实际在当前文件的 src 目录创建 CSS；Java/Kotlin/TS 的动作轨迹为 code.generate，未打开 New。Kotlin 只验证路由，未声称生成代码可用。 | [记录](/tmp/idea-parity-qa/core-lastkeys.log) |
| C06 | 通过 | 项目树文件操作 | 从选中的 src 目录 New › File 创建 qa-tree-created.txt；Rename 后旧路径消失、新路径存在；确认移至 Trash 后新路径消失。 | [记录](/tmp/idea-parity-qa/core-tree-deleted.json) |
| C07 | 通过 | 文件内上下文查找 | In Comments 仅选中三个注释内的 shared（含 shared_history），Next/Previous 在位置3/38/78间导航，不命中代码和字符串；亮/暗各复测。 | [记录](/tmp/idea-parity-qa/core-find-final.log) |
| C08 | 通过 | 替换大小写与排除 | Preserve Case 实际得到 bar/Bar/BAR；排除项出现删除线，Replace All 保留该项、替换其余项；亮/暗重新验证。 | [记录](/tmp/idea-parity-qa/core-FB4-final-dark.png) |
| C09 | 通过 | 多行及搜索历史 | ⇧⌘↵ 输入跨行 alpha/beta 后计数1/1并选中完整跨行文本；⌥↓ 能打开编辑器历史，Find in Files 也显示新增 QA_shared_history。 | [记录](/tmp/idea-parity-qa/core-FB5-dark-confirm.png) |
| C10 | 通过 | 自定义搜索范围 | 三个文件同一标记：不限定时3个文件；file:src//*.ts&&!file:*test* 仅命中 qa_scope.ts；Inspect Code 的 Custom scope 可选同一 Core TS Scope。 | [记录](/tmp/idea-parity-qa/core-FF3-final.png) |
| C11 | 通过 | 跨文件替换与预览 | 两个文本文件6处替换，预览显示 Bar/BAR/bar，确认后磁盘一致；多行搜索可命中多个文件。保留大小写在亮/暗分别确认。 | [记录](/tmp/idea-parity-qa/core-FF4-dark-final.json) |
| C12 | 通过 | 搜索排除归档 | 在项目内放入含唯一标记的 zip、jar，Find in Files 返回 No matches；不是只根据代码推断。 | [记录](/tmp/idea-parity-qa/core-FF5-archive.png) |
| C13 | 通过 | 文件/类型/符号导航 | Go to File 打开 money.ts，Go to Class 打开 Cart，Go to Symbol 打开 formatMoney；调用点转到 Cart 定义，Back/Forward 正确返回和前进；亮/暗各复测。 | [记录](/tmp/idea-parity-qa/core-navigation.log) |
| C14 | 通过 | Search Everywhere 筛选 | Files 排除 TypeScript、Classes 排除 Classes、Symbols 排除 Functions、Text 设 *.py，结果分别被过滤；切换页后各页值独立保留；亮/暗各复测。 | [记录](/tmp/idea-parity-qa/core-filters-final.log) |
| C15 | 通过 | Actions 跳转设置 | 复选框为 Include disabled actions；搜索 code completion 有 Settings: Editor | General，选中后回车打开原生 Settings 的 Code Completion 页。 | [记录](/tmp/idea-parity-qa/core-NV2-target-final.png) |
| C16 | 通过 | 重命名与 Generate | ⇧F6 原地重命名，第二次 ⇧F6 打开名称对话框；qaOriginalName 的声明和引用一起改为 qaRenamed。TS ⌘N 对缺失接口方法执行 Generate，生成 run() 实现。 | [记录](/tmp/idea-parity-qa/core-rename-clean.log) |
| C17 | 通过 | LSP 补全 | 单候选自动插入开关实际改变行为；字母排序有效；函数补全插入()，有参数时光标在括号内且显示参数提示；无参光标在括号后；已有(不重复。亮/暗各复测。 | [记录](/tmp/idea-parity-qa/core-completion.log) |
| C18 | 通过 | 格式化保护区 | 手动 Reformat 与保存时格式化都格式化保护区外的代码，@formatter:off/on 中间保持逐字不变；亮/暗各复测。 | [记录](/tmp/idea-parity-qa/core-IN7-save-dark.json) |
| C19 | 通过 | 检查结果同步（IN-2） | 修复后亮/暗均验证严重级别、禁用和恢复即时同步，禁用时运行后重新启用也可恢复旧结果，无需重跑。 | [记录](/tmp/idea-parity-qa/fix-IN2-results.json) |
| C20 | 通过 | 运行与测试反馈 | npm start 输出购物车合计 $134.97、退出0；正常测试通过；开启 opt-in 失败测试后树显示1 failed/4 passed、断言和源文件行、退出1。亮/暗各复测。 | [记录](/tmp/idea-parity-qa/core-runactual-final.log) |
| C21 | 通过 | Current File 与调试 | Current File 直接运行 TS 输出 QA_CURRENT_FILE_OK；Python Current File 调试命中断点，显示 number=21，进入 double、越过后 answer=42，求值返回42，跳出、恢复后输出42、退出0。TS 调试器另列环境阻塞。 | [记录](/tmp/idea-parity-qa/core-debug-final-console.png) |
| C22 | 通过 | Before launch 执行链 | 先运行子配置，再成功 Build，再 shell，最后主进程；记录 child/shell/main，Build 成功且主子退出0。额外验证非0步骤阻止启动并通知、循环引用被拒绝。 | [记录](/tmp/idea-parity-qa/core-RC6-success.json) |
| C23 | 通过 | Compound | 两个成员17ms间隔启动并同时处于 running；选择 compound、从编辑器触发 Stop 后两个成员均 finished/130。 | [记录](/tmp/idea-parity-qa/core-RC7-stopped.json) |
| C24 | 通过 | 交互终端 | PTY 输入 hello 得到回显；QA_RED 在亮/暗为红色；窗口缩放使子进程收到尺寸233→89列，恢复后120列；输入exit正常退出0，另一次Stop退出130。 | [记录](/tmp/idea-parity-qa/core-RC9-resize.png) |
| C25 | 通过 | Power Save 核心行为 | 正常模式自动补全弹出；开启后同样输入不弹出，编辑器有横幅；有效配置同时关闭 usages Code Vision 等后台提示。随后关闭并确认重启后 false；未把这等同于全部后台任务性能验证。 | [记录](/tmp/idea-parity-qa/core-WB7-enabled.json) |
| C26 | 通过 | CSS 校验集成 | 修复后重新编译并启动原生应用，CSS/SCSS/Less 均对 colr 返回 unknownProperties 警告，日志无原异常。 | [记录](/tmp/idea-parity-qa/fix-css-results.json) |
| C27 | 通过 | Git常用流程 | 独立Python副本中查看HEAD与工作区diff，显示唯一QA标记差异；Commit先报告已有2个警告，选择Commit Anyway后实际提交，git diff为空，Git Log显示新提交。未推送。 | [记录](/tmp/idea-parity-qa/core-git-final.json) |

## 环境和验证边界

- Python debugpy 1.8.22 已安装，断点、变量、求值、三种单步和正常退出都实际验证。`js-debug` 未安装，**TypeScript/Node 调试没有通过判定**，没有拿 Python 的结果替代它。
- Kotlin 两个语言服务器和 Marksman 缺失。Kotlin 的 ⌘N 仅确认路由到 Generate；未声称 Kotlin 代码生成/补全/重构已通过。
- 部分配置通过真实 settings IPC 写入副本，运行配置执行链通过真实注册动作启动；没有把这些视作配置编辑器每个鼠标流程都已验收。
- 第一次应用运行经过热更新，产生过状态模块/焦点残留；已关闭该调试进程、单独启动Vite和编译好的原生二进制后复测快捷键。干净启动后重命名和 Generate 正常，因此不列为产品失败。
- `document.execCommand` 在终端缩放后的第二次注入没有发送文本；改用 textarea 的 InputEvent 后回显与正常退出均成功。这是驱动差异，不列为产品键入失败。使用的桥接输入均未被等同于人工键盘全矩阵验证。
- 已结束并重启原生进程，Open Files 模式和23个打开路径完整恢复。[重启前](/tmp/idea-parity-qa/core-persist-before.json)、[重启后](/tmp/idea-parity-qa/core-persist-after.json)。记录中的 `/tmp` 与 `/private/tmp` 双路径是测试脚本先后用两种路径打开同一文件造成，没有将其直接列为正常用户路径问题。
- 本轮没有应用崩溃；没有做量化卡顿测试。故意失败的测试、Before launch失败和Stop后的130通知均为测试输入产生；独立异常是上面的CSS服务器错误。
- 本轮无产品代码改动，因此没有重复运行完整构建测试；首轮的 typecheck 与30个相关Vitest结果仍单独记录，不作为运行场景的替代。
- 测试进程已停止；Power Save 恢复为false；全局语言/主题未新增改动。副本和截图保留供复核。
