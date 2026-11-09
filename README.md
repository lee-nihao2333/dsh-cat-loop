# cat-loop

`@marvinlee2011/dsh-cat-loop` 是 [DeepSeek Harness](https://www.npmjs.com/package/@deepseek-ai/dsh)（dsh）的插件：
**一个对话 = Plan 团队**，旁边自动带出 Build、Review 两个**独立的 Agent Team**，
三个团队之间的文件 / 命令权限边界由插件**强制执行**（不是只写在提示词里）。

- npm：<https://www.npmjs.com/package/@marvinlee2011/dsh-cat-loop>
- GitHub：<https://github.com/lee-nihao2333/dsh-cat-loop>

## 它解决什么问题

用多个 Agent 协作时，常见做法是让一个「总控」Agent 用 `subagent` 派活。但这有三个问题：

1. 子智能体只是父会话的子对话，**当不了 Team Lead**，也无法拥有自己的队友；
2. 三个角色挤在同一个上下文里，权限只能靠提示词约束；
3. 你无法直接点进某个角色的对话里看它在干什么、直接接管。

cat-loop 的做法：

- 在 dsh 里新开一个 preset 为 **`cat-loop`** 的对话，这个对话本身就是 **Plan 团队**（真实 Agent Team Lead，
  可以 `spawn_teammate` 拉自己的队员）；
- 插件同时在工作区里创建 **Build**、**Review** 两个独立的 Agent Team 会话（同样是真实 root 会话 / Team Lead）；
- 这三个会话在侧边栏里显示成「一个对话 + 它的子对话」的树：Plan 那一行左侧有 ▸，点开就是
  `plan / build / review` 三个子对话，点任意一行直接进入对应团队；
- 三个团队的权限边界由 Host 半的守卫强制：Plan 只能写 `.cat-prompt/` 且无 shell，Build 不能写
  `.cat-test/`，Review 只能写 `.cat-test/` 且 shell 命令限制在该目录内。

工作流：

```
用户需求 → Plan 写 .cat-prompt/*.md 任务文档
        → cat_send 派发给 Build + Review
        → Build 实现；Review 同时在 .cat-test/ 写检查代码
        → Build 完成 → cat_send(code-ready) → Review 跑检查 + 审查
        → cat_send(report) 回 Plan → 通过则下一个任务，不通过则写修复 brief 再来一轮
```

## 安装

要求：Node `^22.19.0 || >=24.0.0`，dsh `>=0.2.1-rc.2 <0.3.0`。

**方式一：插件管理器（推荐）**

在 dsh Web 的「插件」页安装 `@marvinlee2011/dsh-cat-loop`（bundle），或在本机 profile
（`$DSH_HOME/profiles/<profile>/package.json`）里加：

```json
{
  "dependencies": { "@marvinlee2011/dsh-cat-loop": "^1.0.0" },
  "dsh": { "profile": { "bundles": ["@marvinlee2011/dsh-cat-loop"] } }
}
```

然后重启 dsh（Host 半的改动只在重启后生效，Client 半刷新页面即可）。

**方式二：本地开发（link）**

```json
{
  "dependencies": { "@marvinlee2011/dsh-cat-loop": "link:/path/to/dsh-cat-loop" },
  "dsh": { "profile": { "bundles": ["@marvinlee2011/dsh-cat-loop"] } }
}
```

## 使用

1. **新建对话**：工作区选你的项目目录，preset 选 **`cat-loop`**。
   你进入的就是 Plan 团队对话——直接说需求即可。
2. **看子对话**：左侧边栏里这个对话行左边有 **▸**，点开即展开 `plan / build / review` 三个子对话；
   点任意一行切换到对应团队。右侧栏的「子对话 / Sub-conversations」面板同样列出三队状态。
3. **团队协作**：Plan 写任务文档后用 `cat_send` 派发，Build / Review 完成后回传。
   每个团队内部还可以用 Agent Teams 自带工具（`spawn_teammate`、`send_message`、`team_task_*`）
   拉自己的队员；队员会以子智能体形式挂在各自团队对话下，并继承队长的 preset 与权限边界。
4. **继续/切换**：三个团队会话都持久化，随时点进去继续聊；Plan 是唯一可见的根对话，Build / Review
   的原生侧边栏行由插件隐藏并以子对话形式展示。

> 侧边栏列表的「子对话」是插件渲染的：dsh 原生列表只支持工作区缩进，因此 Build / Review 的会话行
> 会被隐藏，改用 Plan 行下的展开面板呈现，点击后照常打开真实的独立团队会话。

## 权限边界（`lib/guard.js` 强制执行）

| 团队 | preset | 文件边界 | shell |
|---|---|---|---|
| Plan | `cat-plan` | 只可写 `.cat-prompt/`，其他文件只读 | 无 shell 工具 |
| Build | `cat-build` | 可读写任意文件，**除 `.cat-test/`** | 有 |
| Review | `cat-review` | 只可写 `.cat-test/`，其他文件只读 | 有，命令中只能出现 `.cat-test/` 下的路径 |

实现是两层：

- `fs/write-intent` / `fs/edit-intent` 前置判定：按解析后的真实路径判断（`..`、符号链接不绕过），
  命中边界直接拒绝；放行后 `next()` 交还内置的「先读后写 / 版本守卫」；
- 只增不减的 `ctx.tools.guard()`：
  - Plan：没有任何 shell 工具；
  - Build：`bash` / `terminal_read` 等命令不得出现 `.cat-test`；
  - Review：命令中出现的路径必须落在 `.cat-test/` 内，且不得使用 `sandbox_permissions` 放宽沙箱。

### 如何验证权限确实生效

新建一个 cat-loop 对话，然后：

1. **Plan 无 shell**：在 plan 对话里让它执行 `ls` / `bash`，应得到「没有该工具」之类的回复，
   工具列表里不存在 `bash`。
2. **Plan 写不了源码**：让 Plan 把内容写到 `src/x.txt` 或直接 `echo > README.md`，应被拒绝；
   写 `.cat-prompt/test.md` 应成功。
3. **Build 写不了 `.cat-test/`**：在 build 对话里让它写 `.cat-test/check.sh`，应被拒绝；
   写源码文件应成功；执行命令时命令里带 `.cat-test` 也会被拒绝。
4. **Review 只能写 `.cat-test/`**：在 review 对话里让它改 `src/` 或写项目根文件，应被拒绝；
   写 `.cat-test/check.mjs` 应成功；执行 `node .cat-test/check.mjs` 应成功，
   执行 `cat README.md` 这类命令中路径不在 `.cat-test/` 的命令应被拒绝。
5. 项目根不应出现 `$DSH_HOME` 之外的副作用；三个团队消息通过 `cat_send` 传递，用
   `cat_status` 可以看到三队的会话与状态。

（以上每条在 `test/policy.test.mjs` 与 `test/plugin.test.mjs` 里都有对应的自动化用例。）

## 架构

```
dsh 进程
├── Host 半（index.js + lib/）
│   ├── ctx.catLoop：会话快照 / 团队管理 / cat_send / cat_status
│   ├── 权限守卫（fs write/edit intent + ctx.tools.guard）
│   ├── 只读快照路由：GET /api/cat-loop/peek?session=、/api/cat-loop/state?session=
│   └── cordis.patch.yml：声明 3 个团队 preset + cat-loop 的 preset 入口
└── Client 半（client.js）
    ├── 侧边栏「子对话」展开面板（sidebar.session.row.leading 槽位）
    ├── 隐藏 Build / Review 原生会话行（注入一条按 data-row-key 的样式规则）
    └── 对话头部的「子对话」按钮 + 右侧面板
```

- 你在 preset 选择器里看到的 **`cat-loop`** 就是 Plan 团队会话（内部 preset id 为 `cat-plan`）；
  容器壳 `cat-root` 与 Build / Review 的 preset 都从选择器隐藏，由插件创建。
- Plan / Build / Review 都是**无父会话的 root 会话**，因此 `tool-agent-team` 会为它们安装 Team 工具；
  三者互相独立、各自可 `spawn_teammate`。
- 三个会话都在你的工作区目录下（cwd = 项目根），不会创建额外工作区。
- 插件状态保存在 `$DSH_HOME/cat-loop/state.json`；快照路由只监听本机回环地址。
- 旧的「对话文件夹」布局仍可通过 `structure: folder` 配置启用（三队放进一个独立 workspace 文件夹）。

## 配置

Host 行（`cordis.patch.yml` 的 `id: cat-loop`）可配置：

| 配置项 | 默认 | 说明 |
|---|---|---|
| `promptDir` | `.cat-prompt` | Plan 的任务文档目录 |
| `testDir` | `.cat-test` | Review 的检查代码目录 |
| `presets` | `{root: cat-root, plan: cat-plan, build: cat-build, review: cat-review}` | 角色到 preset id 的映射 |
| `structure` | `nested` | `nested`：一个对话 + 两个团队子对话；`folder`：三队放进独立文件夹 workspace |
| `hiddenPresets` | `[cat-root, cat-build, cat-review]` | preset 选择器里隐藏的 id |
| `stateFile` | `$DSH_HOME/cat-loop/state.json` | 插件状态文件 |

## 开发

```sh
node --check index.js && node --check client.js
npm test            # 纯逻辑 / 组装测试
# 真实 Cordis 运行时集成测试（可选）：
DSH_CORDIS_FILE=<dsh>/node_modules/@deepseek-ai/cordis/lib/index.js node --test test/runtime.integration.test.mjs
```

测试文件在 `test/`，不包含在 npm 包里。

## 目录

```
index.js              Host 插件入口（ctx.catLoop、守卫、路由、preset 可见性）
client.js             Client 插件入口（子对话展开、隐藏原生行、右侧面板）
lib/bridge.js         会话快照 / 团队物化 / cat_send / 状态文件
lib/guard.js          权限守卫
lib/policy.js         角色 → preset、路径边界判定（纯函数）
lib/role.js           cat_send / cat_status 工具
lib/http.js           本机回环快照路由
cordis.patch.yml      preset 声明 + Agent Teams 运行时行 + cat-loop 行
locale/               界面文案
test/                 自动化测试
```

## License

MIT
