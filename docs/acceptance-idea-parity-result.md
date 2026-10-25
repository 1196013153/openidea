# IDEA 对齐运行验收记录（2026-10-25）

结论：**尚未达到全量验收通过条件**。累计94项中，功能断言通过35项、失败1项、部分验证58项。IN-2与清单外CSS校验异常已修复并经原生应用复测。核心复测27场景的具体范围、修复后27通过/0失败结论见[核心补测报告](acceptance-idea-core-result.md)；不能把本次核心补测当作原94项全部完成。

目标提交为 `1e00ea5`；启动后仓库由外部更新为 `d3feb05 chore: v0.1.14`，仅版本文件变化，实际后续验收运行此版本。首次验收未改动产品源码；随后按用户要求修复IN-2和CSS配置，版本为 `d3feb05` 加工作区改动，未提交。测试均使用 `/tmp/idea-parity-qa/` 下的 fixture 副本。

使用 `pnpm tauri dev` 启动真实 macOS Tauri 应用，桥接操作真实 DOM、注册动作，并读取运行结果。部分设置通过真实 IPC 写入测试项目配置，以核对运行时行为；这不替代 Settings 原始鼠标路径或快捷键验证。热更新造成的旧模块实例问题已识别，相关外部库检查重新使用运行中的模块后重做；以 `libraries-final.log` 为准。

亮/暗主题已抽查 New、查找、运行配置、数据库、工具栏、Cleanup；未做到94项各自双主题全覆盖，主题总要求仍未完成。中文抽查发现可复现漏译。未观察到功能整体缺失；未覆盖项不能据此判定已实现。

辅助检查：`pnpm typecheck` 退出码0；4个相关 Vitest 文件共30个测试通过（libraries、NewPopup、file templates、run-anything）。没有重新运行完整 Rust/前端测试，不沿用清单中旧提交的通过数作为本轮证据。

## 逐项记录

| 编号 | 结果 | 现象、范围和证据 |
|---|---|---|
| PV-1 | 通过 | 真实 Project 标题下拉列出五种要求的模式；[证据](/tmp/idea-parity-qa/PV-1-menu.png) |
| PV-2 | 通过 | 核心复测：五种模式已操作；Open Files 成树、All Changed Files 仅显示修改的已跟踪文件；原生进程重启后 Open Files 和23个打开路径恢复。[证据](/tmp/idea-parity-qa/core-persist-after.json) |
| PV-3 | 通过 | Open Files 中定位未打开的 README.md，自动回到 Project 并选中 |
| PV-4 | 部分 | Python 副本已建 .venv，External Libraries 注册标准库、venv 库和 site-packages；.venv 下逐级展开对照未完成；[证据](/tmp/idea-parity-qa/PV-6-python-app.png) |
| PV-5 | 部分 | 在副本 site-packages 新建 qa_library.py，经编辑器插入文字后内容和磁盘均不变，readOnly=true，横幅正常；节点重命名/删除/新建/拖拽未逐项操作；[证据](/tmp/idea-parity-qa/PV-5-blocked-input.png) |
| PV-6 | 部分 | Rust stdlib、Go SDK、JDK/src.zip、Gradle junit-jupiter 源码 jar、TS 的 typescript/vitest 直接依赖均已识别并注册到树；Cargo 依赖、Go 模块和 Maven 分组未完整覆盖；[证据](/tmp/idea-parity-qa/libraries-final.log) |
| PV-7 | 部分 | JDK src.zip!/java.base/java/lang/String.java 实际打开，语法高亮、readOnly=true；树内逐级浏览及另一个 jar 未完整操作；[证据](/tmp/idea-parity-qa/PV-7-archive.png) |
| PV-8 | 通过 | TS 副本 package.json 添加已在 node_modules 中的 qa-dep；857ms 后 External Libraries 已出现该依赖，随后恢复清单；[证据](/tmp/idea-parity-qa/PV-8-refresh.json) |
| NF-1 | 通过 | 核心复测：项目树选中src，⌘N 打开带搜索框的 New；css 找到 Stylesheet。随后 New › File 实际在src创建文件。[证据](/tmp/idea-parity-qa/core-tree-new-parent.json) |
| NF-2 | 通过 | 实际创建 CSS、SCSS、Less、Dockerfile、.editorconfig、.gitignore、JSON、YAML、TOML、Shell 和 HTTP 文件；核对磁盘扩展名及模板内容；[证据](/tmp/idea-parity-qa/templatesactual.log) |
| NF-3 | 通过 | 核心复测：Python/Markdown 的 ⌘N 均打开 New，实际创建的CSS都在当前文件的src目录。[证据](/tmp/idea-parity-qa/core-lastkeys.log) |
| NF-4 | 通过 | 核心复测：Java/Kotlin/TS 的 ⌘N 动作轨迹为 code.generate，均不打开 New；TS 实际生成缺失接口方法。Kotlin只验证路由，语言服务器缺失。[证据](/tmp/idea-parity-qa/core-NF4-generate.png) |
| NF-5 | 部分 | 动作能弹出 New 并在当前 worker 目录创建文件；任意焦点和 ⌃⌥N 按键矩阵未完整验证；[证据](/tmp/idea-parity-qa/NF-5.png) |
| NF-6 | 通过 | 创建 /tmp/idea-parity-qa/qa-new-project，勾选 Git，磁盘 .git 存在，出现独立 project-1 窗口；[证据](/tmp/idea-parity-qa/NF-6-created.json) |
| NF-7 | 部分 | 重命名为 QA renamed project 后原生窗口标题更新，polyglot 磁盘目录保持原名；最近项目列表未单独检查；[证据](/tmp/idea-parity-qa/NF-7-renamed.png) |
| FB-1 | 通过 | 漏斗列出 Search In Selection 和清单中的六种上下文范围；[证据](/tmp/idea-parity-qa/FB-1-filter.png) |
| FB-2 | 通过 | 核心复测：In Comments 计数3；Next/Previous在三个注释位置间跳转，不命中代码/字符串；亮暗均验证。[证据](/tmp/idea-parity-qa/core-find-final.log) |
| FB-3 | 通过 | 9 处 foo/Foo/FOO 替换为 bar/Bar/BAR，磁盘副本编辑内容符合预期；[证据](/tmp/idea-parity-qa/FB-3-result.png) |
| FB-4 | 通过 | 排除第一处匹配后显示删除线，Replace All 保留该处 bar，其余变为 baz；[证据](/tmp/idea-parity-qa/FB-4-result.png) |
| FB-5 | 通过 | 核心复测：⇧⌘↵ 后跨行输入alpha/beta，计数1/1、选择完整跨行内容；亮暗均确认。[证据](/tmp/idea-parity-qa/core-FB5-dark-confirm.png) |
| FB-6 | 通过 | 核心复测：⌥↓ 打开编辑器最近搜索，新增QA_shared_history同时出现在 Find in Files 的最近搜索。[证据](/tmp/idea-parity-qa/core-find-final.log) |
| FF-1 | 通过 | 真实窗口显示 In Project/Module/Directory/Scope，polyglot Module 下拉含根模块及 api、web；[证据](/tmp/idea-parity-qa/FF-1-options.json) |
| FF-2 | 通过 | 新建并保存自定义 scope；!(file:src//* 实时显示 Missing `)` 错误，合法表达式出现在下拉；[证据](/tmp/idea-parity-qa/FF-2-real-invalid.png) |
| FF-3 | 通过 | 核心复测：自定义Scope将3个标记文件缩至唯一qa_scope.ts；Inspect Code的Custom scope也能选Core TS Scope。[证据](/tmp/idea-parity-qa/core-FF3-final.png) |
| FF-4 | 通过 | 核心复测：跨文件多行搜索命中；6处替换的保留大小写预览与磁盘Bar/BAR/bar一致；亮暗均确认。[证据](/tmp/idea-parity-qa/core-FF4-dark-final.json) |
| FF-5 | 通过 | 核心复测：项目内jar/zip包含唯一标记，Find in Files不命中。[证据](/tmp/idea-parity-qa/core-FF5-archive.png) |
| NV-1 | 通过 | 核心复测：四页分别过滤文件类型/类种类/符号种类/文件掩码，结果变化且各页保留独立选择；亮暗均验证。[证据](/tmp/idea-parity-qa/core-filters-final.log) |
| NV-2 | 通过 | 核心复测：文案正确；Settings: Code Completion结果回车打开原生设置的对应页面。[证据](/tmp/idea-parity-qa/core-NV2-target-final.png) |
| NV-3 | 部分 | 未执行：动作快捷键录入、生效与三种冲突解决 |
| NV-4 | 部分 | 未执行：书签列表新建/重命名/删除/默认列表/移动矩阵 |
| NV-5 | 部分 | 书签弹窗入口存在且空状态正常；文件、文件夹、行书签及按列表分组跳转未执行；[证据](/tmp/idea-parity-qa/NV-5.png) |
| NV-6 | 部分 | 未执行：Structure 字段/非公开成员/可见性排序 |
| NV-7 | 部分 | 未执行：支持 typeHierarchy 的 TS/Java 继承成员及跳转 |
| NV-8 | 部分 | Recent Locations 有相对时间和代码片段；类/方法面包屑和片段高亮未完整核对；[证据](/tmp/idea-parity-qa/NV-8.png) |
| NV-9 | 部分 | 已提交 fixture 的 Python 函数出现 Thomas Hong 作者；Settings 有 Code author；多人 +N 及关闭效果未验证 |
| ED-1 | 通过 | 核心复测：关闭单候选自动插入时保留一个候选，开启后实际自动插入；亮暗均确认。[证据](/tmp/idea-parity-qa/core-completion.log) |
| ED-2 | 通过 | 核心复测：打开Sort suggestions alphabetically后真实候选按名称排序，popup含Sort by name；通过设置开关路径验证。[证据](/tmp/idea-parity-qa/core-ED2-sorted-dark.png) |
| ED-3 | 通过 | 核心复测：有参/无参函数自动括号、光标落点和参数提示符合要求；已有(不重复；亮暗均验证。[证据](/tmp/idea-parity-qa/core-completion.log) |
| ED-4 | 部分 | Top/Bottom/Left/Right/None 均切换并截图，左右为竖排，None 隐藏标签；滚动、拖拽和菜单一致性未逐项验证；[证据](/tmp/idea-parity-qa/ED-4-none.png) |
| ED-5 | 部分 | Editor Tabs 的相关设置项齐全；每种选项实际行为未逐项验证；[证据](/tmp/idea-parity-qa/settings-Editor-Tabs.png) |
| ED-6 | 部分 | Inline Completion 设置页存在；未配置支持 inlineCompletion 的服务，运行预览及快捷键跳过，不能视为通过；[证据](/tmp/idea-parity-qa/settings-Inline-Completion.png) |
| IN-1 | 部分 | Inspections 页面有方案、搜索、按语言树和描述区域；三态与 Severity 的编辑操作未完成；[证据](/tmp/idea-parity-qa/IN-1-settings.png) |
| IN-2 | 通过 | 修复复测：亮/暗下编辑器和旧Inspect Code结果随严重级别、禁用、恢复即时同步，计数同步；禁用时运行后也能重新启用恢复诊断，无需重跑。[证据](/tmp/idea-parity-qa/fix-IN2-results.json) |
| IN-3 | 部分 | 未执行：检查方案 Duplicate/Copy/Rename/Delete 和内置方案保护 |
| IN-4 | 部分 | 测试副本已写入 recieve；注释/字符串/声明和调用名的诊断对照未完成 |
| IN-5 | 部分 | Spelling 设置页面存在；Typo 上下文候选及保存两类词典未执行；[证据](/tmp/idea-parity-qa/settings-Spelling.png) |
| IN-6 | 部分 | Code Style 页面有 Default (IDE) Scheme 与 Copy to Project；语言子页面联动未完整操作；[证据](/tmp/idea-parity-qa/settings-Code-Style.png) |
| IN-7 | 通过 | 核心复测：手动及保存格式化都格式化保护区之外，formatter:off/on之间逐字保持；亮暗均验证。[证据](/tmp/idea-parity-qa/core-IN7-save-dark.json) |
| IN-8 | 通过 | 项目配置 Do not format 为 *.json，执行 Reformat Code 出现明确跳过提示；[证据](/tmp/idea-parity-qa/IN-8-excluded.png) |
| IN-9 | 部分 | Cleanup 范围及 fix/import/format 选项存在，可取消；实际清理结果和中途取消未执行；[证据](/tmp/idea-parity-qa/IN-9.png) |
| FT-1 | 部分 | 打开 x.foo 后添加 YAML 关联，现有 editor context 立即变为 yaml/YAML；图标及 Go to File 未独立核对；[证据](/tmp/idea-parity-qa/FT-1-yaml.png) |
| FT-2 | 部分 | 调用同名注册动作使 YAML→JSON→YAML，现有编辑器立即更新；右键菜单路径及撤销未操作；[证据](/tmp/idea-parity-qa/FT-2-revert.json) |
| FT-3 | 通过 | 无扩展名 qa-hashbang 带 #!/usr/bin/env python3，实际 editor context 为 python/Python；[证据](/tmp/idea-parity-qa/FT-3-hashbang.png) |
| PS-1 | 部分 | 添加外部 extra-root 后树出现根，Find in Files 命中 extra.ts；Go to File 和外部文件修改刷新未完整验证；[证据](/tmp/idea-parity-qa/PS-1-search.png) |
| PS-2 | 部分 | 即时设置 *.log;tmp* 后 Find in Files 不再命中 qa.log 中的唯一标记；树与索引侧未独立核对；[证据](/tmp/idea-parity-qa/PS-2-search.png) |
| TP-1 | 部分 | File and Code Templates 页面包含 Includes，说明支持 #parse；编辑 File Header 后新建 Java/Kotlin 未执行 |
| TP-2 | 部分 | 模板页有 Code 标签；修改测试方法模板并生成测试未执行 |
| TP-3 | 部分 | Reformat according to style 默认已勾选；$END$ 光标及格式化效果未单独验证；[证据](/tmp/idea-parity-qa/settings-File-and-Code-Templates.png) |
| RC-1 | 通过 | 核心复测：Current File保持可选，直接运行TS输出正确；Python Current File调试命中断点并可单步/求值/正常退出。Node调试器缺失单独记为环境阻塞。[证据](/tmp/idea-parity-qa/core-debug-final-console.png) |
| RC-2 | 通过 | + 菜单列出所有要求类型，含 Compound 与 Docker 三种子类型，搜索输入存在；[证据](/tmp/idea-parity-qa/RC-2-types.png) |
| RC-3 | 部分 | 实际新建 Shell/Program，Program env 运行成功，检测配置正常；其余每种类型执行及旧配置兼容未覆盖；[证据](/tmp/idea-parity-qa/RC-8-process-output.png) |
| RC-4 | 部分 | 表单支持复制/分组/排序/Templates；对话框 Run 成功，local TOML 已落盘且 git check-ignore 命中 .openidea/.gitignore；其余子流程未逐项执行 |
| RC-5 | 部分 | Modify options 显示各类可选项；移除控件与各选项的运行效果未完整验证；[证据](/tmp/idea-parity-qa/RC-5.json) |
| RC-6 | 通过 | 核心复测：实际子配置→Build→Shell→主进程；Build成功，记录child/shell/main；失败步骤中止并通知，循环被拒绝。[证据](/tmp/idea-parity-qa/core-RC6-success.json) |
| RC-7 | 通过 | 核心复测：两成员17ms间隔启动并同时running，选中compound从编辑器触发Stop后都结束、退出130。[证据](/tmp/idea-parity-qa/core-RC7-stopped.json) |
| RC-8 | 部分 | A=1;B=2 输入后对话框拆成两行，关闭系统环境后 /usr/bin/env 仅输出 A/B，退出码 0；独立 Paste 按钮未操作；[证据](/tmp/idea-parity-qa/RC-8-process-output.png) |
| RC-9 | 通过 | 核心复测：PTY回显、亮暗ANSI颜色、resize传到子进程（233→89列）均正常；输入exit退出0，另次Stop退出130。[证据](/tmp/idea-parity-qa/core-RC9-resize.png) |
| RC-10 | 部分 | 空 Run 显示三条提示及 run configuration 链接；点击链接未操作 |
| RC-11 | 部分 | 本机 Docker 可用，但未运行/停止 fixture Docker 和 Compose，不能视为通过 |
| GT-1 | 部分 | Graph Options 所列排序和分支选项齐全；复杂分支图下的效果未执行；[证据](/tmp/idea-parity-qa/GT-1-options.png) |
| GT-2 | 部分 | View Options 所列显示项和 Highlight 存在；开关效果及重启持久化未完整验证；[证据](/tmp/idea-parity-qa/GT-2-options.png) |
| GT-3 | 部分 | 未执行：Log 焦点 ⌘F、补全、跳转及自动加载更多 |
| GT-4 | 部分 | 未执行：设置 Date 过滤后图仍保留 |
| GT-5 | 部分 | 七种对话框均实际打开，选项可见；未执行 pull/merge/rebase/worktree/clone 的磁盘变化；[证据](/tmp/idea-parity-qa/gitcheck.log) |
| SV-1 | 部分 | Add Service 菜单有三类要求入口；⌘N 和无连接空状态未完整验证；[证据](/tmp/idea-parity-qa/SV-1.png) |
| SV-2 | 部分 | 实际 Program/Run Anything/PTY 均已启动；Services 中运行配置分组与停止/重跑/输出跳转未验证 |
| SV-3 | 部分 | 自动连接 orbstack，显示容器、镜像、卷和网络；新建多个连接及绑定操作路由未执行；[证据](/tmp/idea-parity-qa/SV-1.png) |
| TD-1 | 部分 | TODO 有 Scope Based、Changes，显示7条 fixture TODO/FIXME；自定义范围和多个 changelist 下拉未验证；[证据](/tmp/idea-parity-qa/TD-1.png) |
| CV-1 | 部分 | LCOV 导入显示 app.ts 50%(1/2)，管理弹窗列出报告；Go/JaCoCo、多报告切换和 gutter 未完整验证；[证据](/tmp/idea-parity-qa/CV-1-import.png) |
| DB-1 | 部分 | Driver 下拉按字母列出 CockroachDB/Redshift/TiDB 等；逐种默认端口未核对；[证据](/tmp/idea-parity-qa/DB-1-list.png) |
| DB-2 | 通过 | 指定 JDBC URL 解析出 h、5432、db，SSL 页为 Verify Full；[证据](/tmp/idea-parity-qa/DB-2-ssl.png) |
| DB-3 | 部分 | Options/Schemas/Advanced 页签存在；未连 SQLite/Postgres 验证只读/启动脚本/时区/过滤/驱动属性 |
| DB-4 | 部分 | 颜色和 Add comment 控件存在；树节点、console 标签及 hover 效果未验证 |
| WB-1 | 部分 | Run Anything 执行 pwd，输出进入 Run，cwd 为 fixture，退出码0，并列出检测配置；双 Ctrl、Maven/Gradle 和新历史未完整验证；[证据](/tmp/idea-parity-qa/WB-1-output.png) |
| WB-2 | 部分 | Customize Main Toolbar 可打开并显示增删/排序/恢复控件；实际保存和重启持久化未执行；[证据](/tmp/idea-parity-qa/WB-2.png) |
| WB-3 | 部分 | Save Current Layout as 弹出命名输入；另存、恢复、重命名、删除完整流程未执行；[证据](/tmp/idea-parity-qa/WB-3-save.json) |
| WB-4 | 部分 | 未执行：原生 View › Tool Windows 与注册表的一一核对 |
| WB-5 | 部分 | Quick Switch Scheme 弹出四类选项；其余菜单命令及所有效果未完整验证；[证据](/tmp/idea-parity-qa/WB-5.png) |
| WB-6 | 部分 | 无可用重构位置弹出 Nothing here；原生菜单上下文置灰未验证；[证据](/tmp/idea-parity-qa/WB-6.png) |
| WB-7 | 部分 | Power Save Mode 切换后编辑器出现横幅，随后关闭恢复；后台高亮与自动弹出抑制未完整验证；[证据](/tmp/idea-parity-qa/WB-7-real.png) |
| WB-8 | 部分 | 未执行：完整 Export/Import 设置与快捷键、模板、宏、布局恢复 |
| WB-9 | 部分 | 录制 QA macro 后回放，内容为 QA macroQA macro；保存命名和 Keymap 绑定未执行；[证据](/tmp/idea-parity-qa/WB-9-replay-result.png) |
| WB-10 | 部分 | Coverage 导入的信息通知显示 Don’t Show Again；点击后同类通知抑制未验证 |
| I18N-1 | 失败 | 复现：切换中文，打开 Code › Code Cleanup。实际 Whole project、Module or directory、Uncommitted files 和底部说明仍为英文；打开 Customize Main Toolbar 后 Project Widget/VCS Widget/Build Project/Run Widget 仍为英文；Services 的 Containers/Images/Volumes/Networks 仍为英文。期望这些新增界面文案均翻译；均不属于清单已知例外；[证据](/tmp/idea-parity-qa/IN-zh-dark.png) |

## 独立问题与环境说明

- 崩溃：已执行流程中未观察到应用崩溃。版本更新引起的 dev 自动重编译不是崩溃。
- 控制台：有自动化自身造成的错误（错误 action id、首次尝试不存在的文件、带换行注入脚本的 Unexpected EOF）和手动 reload 后 Tauri callback 警告；不归为产品功能失败。尚不能声明控制台全量无错误。应用日志在 [/tmp/idea-parity-qa.log](/tmp/idea-parity-qa.log)。
- 卡顿：未观察到已执行操作中的明显持续卡顿；没有完成量化性能验收。桥接脚本等待用户输入对话框导致的超时不按应用卡顿计。
- 核心补测新增的CSS语言服务器validProperties空值异常已修复；CSS/SCSS/Less真实校验均返回未知属性警告，见核心报告修复复测。
- Python REPL 的 Stop 先发中断（出现 KeyboardInterrupt），随后超时强制结束，最终137/SIGKILL；这是本轮观察结果，未仅凭此判失败。
- 首轮安装TS依赖时pnpm提示esbuild脚本未批准；核心补测已实际运行npm start及正常/故意失败测试。Build通过专用最小TS目标验证，未据此宣称所有原始QA文件能通过类型检查。
- 全量放行前仍需完成表中的未执行子项，包括所有语言/运行类型、Docker、复杂Git图与合并/变基、数据库、设置导入导出、完整书签/布局管理等；双主题逐项与中文复测也未全覆盖。Before launch、Compound、补全和基础运行/调试已有核心复测证据，见对应行。

截图和结构化证据目录：[/tmp/idea-parity-qa](/tmp/idea-parity-qa)。验收期间使用的全局主题、语言和 Power Save Mode 已恢复；最后录制宏为 QA 样例，测试项目仍保留供复核。


核心补测：新增真实编辑、导航、补全、重命名、检查同步、运行/调试、Before launch/Compound、PTY和原生重启验证；详情见[核心补测报告](acceptance-idea-core-result.md)。原表中其他待测子项仍保留，不因核心补测而自动变绿。
