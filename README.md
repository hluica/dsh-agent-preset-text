# Agent 预设文本（`@local/dsh-agent-preset-text`）

最后实质性修改于Harness版本：0.2.2-rc.2

在显示层接管 Agent 预设的名称与说明——内置预设来自 `settings.agentPreset` 字典，第三方/自定义预设来自 Host roster——按语言、预设、当前文本、已启用插件和当前工作区应用规则，**不修改预设声明本身**，禁用插件后立即恢复原文。

## 效果

| 界面位置 | 被接管的文本 |
| --- | --- |
| 设置 → Agent 预设 | 内置与自定义预设的卡片名称、说明、悬停气泡全文；查看配置对话框标题；帮助按钮的 aria 文本 |
| 新任务界面预设 chip 的下拉选单 | 每一项的名称与说明 |
| 会话标题旁的预设标签 | 显示名与 `title` 提示 |
| 设置 → 插件 → 插件列表 | 预设切换器与预设分组的显示名 |

接管的只是**显示**：

- 不改 `cordis.patch.yml`、不重装预设、不改会话数据；
- 内置预设改 locale 字典值，自定义预设包装 roster 读取路径；插件停用或卸载时，被写过的字典值恢复原文、被包装的方法还原 descriptor；
- 规则按语言分别生效，默认只改「说明」字段，名称需要显式选择；
- 自定义预设没有原生多语言文本，规则按当前界面语言选择。

## 使用

### 设置页

**设置 → Agent 预设文本**（紧跟官方「Agent 预设」）。

1. **状态条**：内置接管是否生效、当前语言、生效规则数、当前工作区、插件清单、外部改写计数，以及「自定义预设 · 已接管 / 命名空间不可用 / 读取失败」。
   - `已接管`：已找到 `settings.agentPreset` 字典并正在工作。
   - `等待 Agent 预设插件`：字典尚未注册，通常出现在启动早期或官方插件未启用时。
   - `不可用`：当前 DSH 的 locale 服务没有暴露可覆写的字典对象，见「版本契约」。
2. **语言标签**：切换要查看/编辑的语言（内置取字典实际存在的语言；字典不可用时退化为界面语言目录，供自定义规则使用）。
3. **预设卡片**：内置预设一组、自定义预设一组；每个预设一行「名称」、一行「说明」，同时显示原文与生效文本；生效文本不同时打「已改写」标记。点「编辑规则」打开该字符串的规则编辑器。自定义组下方注明其语言语义。
4. **规则编辑器**：
   - 该单元格已有的规则（只列出目标语言/预设/字段**精确等于**本单元格的规则；通配、按 `key` 或组合条件的规则在原始文档里管理）；
   - 操作、文本、查找模式与条件；
   - 保存后立即写回插件配置并生效，无需重启。
5. **原始文档**：整份规则文档的 JSON 文本，可格式化、校验、保存；无法解析的已保存文档不会生效，界面继续使用上一份可用规则并显示错误。

### 规则文档

配置存放在插件自己的 Host 设置命名空间（等同 Loader 条目 id `dsh-agent-preset-text`）的 `document` 字段里，是一份版本化 JSON：

```json
{
  "version": 1,
  "enabled": true,
  "rules": [
    {
      "id": "zh-standard-description",
      "when": {
        "locales": ["zh"],
        "presets": ["standard"],
        "fields": ["description"],
        "text": { "mode": "glob", "pattern": "处理代码、文件和资料*" },
        "plugin": { "id": "dsh-custom-css", "state": "enabled" },
        "workspace": "**/coding-workspace"
      },
      "then": { "op": "append", "text": "\n（本机补充：优先用 bash）" }
    }
  ]
}
```

| 字段 | 取值 | 缺省 | 含义 |
| --- | --- | --- | --- |
| `version` | `1` | 必填 | 文档版本；未知版本整体不生效 |
| `enabled` | boolean | `true` | 全局开关；`false` 时所有规则不生效 |
| `rules[].id` | string，文档内唯一 | 自动生成 | GUI 定位用 |
| `when.locales` | string 或 string[] | `"*"` | 语言 id；`"*"` 表示所有语言 |
| `when.presets` | string 或 string[] | `"*"` | 预设 id（内置：`standard`、`ptc`、`minimal`、`cordis`；自定义预设用 roster 行 id） |
| `when.fields` | `name` / `description` / `*`（可数组） | `description`；给了 `key` 时为 `*` | 名称或说明 |
| `when.key` | string | — | 直接指定 `settings.agentPreset` 的字典键（高级；自定义行没有 key，不会匹配） |
| `when.text` | `{ mode, pattern, flags? }` | 不限制 | 对**当前工作文本**匹配：`exact` / `glob` / `regex` |
| `when.plugin` | string 或 `{ id, state }` | 不限制 | `state` 为 `enabled`（默认）/ `active` / `absent`；`id` 是插件 entry id 或模块名 |
| `when.workspace` | string（路径 glob） | 不限制 | 匹配当前工作区路径 |
| `then.op` | `prepend` / `append` / `replace` / `rewrite` | 必填 | 首部附加 / 尾部附加 / 按匹配替换 / 整体重写 |
| `then.text` | 模板字符串 | 必填 | 操作文本 |
| `then.find` | `{ mode, pattern, flags? }` | — | `replace` 的查找式；缺省时等价于重写 |
| `then.count` | `all` / `first` | `all` | `replace` 的替换次数 |

### 条件语义

- **自定义预设的语言**：自定义预设的文本本身不随语言变化；`when.locales` 选择规则在哪个**界面语言**下生效，实际显示跟随当前界面语言。

- 所有写出的条件**同时满足**才应用；未写的条件不限制。
- 规则按文档顺序**依次**作用：后一条看到前一条的结果；`when.text` 匹配的也是当前工作文本。
- **文本通配**：`*` 匹配任意字符（含换行），`?` 匹配一个字符，`\` 转义；整串匹配（自动加锚点）。
- **路径通配**：`*` 不跨 `/`，`**` 跨目录，`**/` 可匹配零段；`\` 转义。
- **插件条件**：`enabled` = 清单里存在该 id 且已启用；`active` = 还要求根 fiber 处于 `active`；`absent` = 清单里没有已启用实例。`pluginInventory` 不可用时，写了插件条件的规则视为不满足。
- **工作区**：取**主视图中显示的会话的 `cwd`**（有空白会话时优先空白会话，否则取最近更新的一个）。主视图没有会话时不成立。
- 条件在**全局上下文**中求值：同一个字符串在设置页、下拉选单、标题标签里得到同一份文本（不能按显示面分别取文本）。

### 操作语义

- `prepend` / `append`：`文本 + 当前` / `当前 + 文本`；
- `rewrite`：忽略当前文本，直接使用模板结果；
- `replace`：按 `then.find` 替换。`regex` 模式的替换文本支持 `$1`、`$&` 等；`exact` / `glob` 的替换是字面插入（`$` 不转义）；查找模式为空时规则不生效；
- `then.count`：`all` 替换所有命中，`first` 只替换第一处。

### 占位符

`then.text` 支持：

| 占位符 | 含义 |
| --- | --- |
| `{preset}` | 预设 id；目标不是内置预设字段时为空串 |
| `{field}` | `name` 或 `description`；同上 |
| `{locale}` | 当前字典条目的语言 id |
| `{original}` | 安装时捕获的原文（规则流水线的起点） |
| `{current}` | 本规则执行前的工作文本 |
| `{{` / `}}` | 字面花括号 |

## 工作原理

### 文本从哪里来

DSH 0.2.2 有两条文本来源，`presetDisplayText()` 按行决定用哪条：

- **内置预设**：客户端 locale 命名空间 `settings.agentPreset`。`presetDisplayText()` 把 `standard` / `ptc` / `minimal` / `cordis` 映射到 `preset{Standard,Ptc,Minimal,Cordis}{Name,Description}` 八个键，再用注册时绑定的 `t` 解析。
- **自定义预设**：Host roster 行自带的 `name` / `description`。行自带名称或 id 不在内置表时，折叠函数直接使用行内文本。

设置页、hero 下拉、标题标签和插件列表页都走同一个折叠函数，因此本插件有两条接管路径：内置预设覆写 locale 字典，自定义预设包装 roster 读取。

### 接管与恢复

1. 客户端启动后取 `ctx.locale.dicts`（`Map<命名空间, Map<语言, 字典对象>>`），找到 `settings.agentPreset`；
2. 首次见到某个语言的字典对象时，记下所有字符串键的原文（`originals`）；
3. 规则引擎只从 `originals` 出发计算，结果与原值不同的才写回同一对象，并记下「本插件写过的值」；
4. 字典对象被官方插件重新注册（例如 HMR/重载）时，对象身份变化，重新捕获原文并重算；
5. 停用/卸载时把仍属于本插件的值写回原文；
6. 写回后触发一次 locale revision，让已经挂载的界面重渲染。

第 6 步用公开 API：注册一个本插件独占、没有任何消费者的探针命名空间（空字典）并立即释放，`LocaleRuntime` 在注册与移除时各发布一次 revision。槽位渲染器订阅 LocaleFace，因此已挂载的设置页、下拉选单和标签会重新读取 `t`。

### 自定义预设的接管

1. 包装 `remote.agentPresets.list` / `read` 与 `remote.pluginInventory.list` 三个只读方法。Gateway 把命名空间方法安装成可配置 accessor，包装保存原 descriptor，调用时按调用方 `this` 生成原调用，保持远程访问与取消语义；
2. 自定义行返回浅拷贝，`name` / `description` 用 getter 按当前界面语言与条件实时计算；`pluginInventory` 的预设分组只改写 `name`；内置行不装饰，继续走字典与既有分组；
3. 本插件自己的 roster 读取绕过包装，保留声明原文供 GUI 显示；
4. 重算时预计算「语言 × 预设 × 字段」生效表，签名变化触发一次 locale revision；
5. 卸载时按保存的 descriptor 还原；Gateway 重装方法后，下一次重算会重新包装。

### 条件刷新

- 配置写入：`configForms` 订阅即时重算；
- 语言切换、字典晚到/重注册：locale 订阅重算；
- 工作区：订阅会话列表与每个会话的 retain 信息；
- 插件启用状态：`pluginInventory/list` 是点位快照（无变更订阅），插件条件的规则存在时按 2 秒节流刷新，并在 `plugin-manager/changed`、连接重置、打开设置页刷新时主动读取；
- 自定义预设：生效表签名变化时触发 revision；hero chip / 标题标签在 `load()` 时复制字段，离开设置页返回会重新挂载并刷新（见「适用边界」）；
- 写配置失败或文档解析失败都会在设置页状态区显示，不会静默吞掉。

## 安装

插件需要接入 profile 才能生效：

1. `~/.dsh/profiles/desktop/package.json`：
   - `dependencies` 增加 `"@local/dsh-agent-preset-text": "link:/Users/hanluica/Documents/deepseek-harness/local-plugins/dsh-agent-preset-text"`；
   - `dsh.profile.bundles` 数组加入 `"@local/dsh-agent-preset-text"`。
2. 在 profile 目录执行 `pnpm install`。

装载条目由本插件 `cordis.patch.yml` 的 `insert` 提供，bundle 机制自动叠加。

> **必须重启 Host**：profile 的 bundle 列表在 Host 启动时合成，无法在进程内重试；重启后刷新 GUI。已接入本机 `desktop` profile。

## 依赖与构建

- Host 半 import `@deepseek-ai/schemastery@3.18.4`（profile 不提供），由构建系统按 `deps.lock.json` 物化为真实文件 `node_modules/`；
- Client 半只从平台模块表 `require('react')`，不 import 其它 Harness 客户端包的值；
- `package.json` 的 `peerDependencies["@deepseek-ai/dsh"]` 为 `^0.2.2-rc.2`，`dsh.client.inject` 声明 `dsh-client-ui-slots`、`dsh-client-locale`、`dsh-client-ui-settings`、`dsh-api-remotes`（仅排激活顺序）。

### 命令

| 命令 | 作用 |
| --- | --- |
| `npm run verify` | 一个命令回答「这插件现在健康吗」：真实文件不变量、依赖与锁、清单契约、两个半都可解析、Host 半在全新进程里真的能导入、`ENTRY_ID` 与 patch id 一致，并跑 `npm test` |
| `npm test` | `test/engine.test.mjs`（规则引擎）+ `test/lifecycle.test.mjs`（字典接管、配置变更、卸载恢复、降级） |
| `npm run build` | 物化依赖并跑 `verify` |
| `npm run rebuild` | 强制重新物化依赖 |
| `npm run clean` | 删除 `node_modules/` 与 `.cache/` |

### `verify` 检查什么

- 整个插件目录没有符号连接、Finder 替身、`.DS_Store` / `._*`；
- `node_modules/` 与 `deps.lock.json` 逐字节一致；
- 清单契约：`exports`、`dsh.bundle.patch`、`dsh.client`、locale 锚点、图标、`files[]`；
- `index.js` 与 `client.js` 可解析；
- Host 半在一个全新进程里导入，`ENTRY_ID` 等于 patch id，`document` 字段默认空串且原样往返；
- `npm test` 通过；
- `scripts/` 的 5 个共享文件与根目录 `build-system/` 参考副本逐字节一致。

### 构建系统与参考副本

本插件的 `scripts/` 是工作区构建系统的一份完整副本（依赖物化 + 不变量检查），目录单独拷走仍能构建与自检；整体说明见 [`BUILD-SYSTEM.md`](../BUILD-SYSTEM.md)。

除 `scripts/host-contract.mjs` 外，`build.mjs`、`verify.mjs`、`lib/fsx.mjs`、`lib/tar.mjs`、`lib/probe-runner.mjs` 是根目录 [`build-system/scripts/`](../build-system/scripts) 参考副本的逐字节副本。改构建系统要改参考副本，再 `node build-system/sync.mjs`。

## 适用边界与已知限制

- **两条接管路径。** 内置预设改字典值；自定义预设包装 `agentPresets.list`/`read` 与 `pluginInventory.list` 的读路径。两者都只改显示，卸载即恢复。
- **自定义预设没有原生多语言文本。** 规则按当前界面语言选择；GUI 表格按所选语言预览。
- **复制字段的刷新窗口。** hero chip 与标题标签在 `load()` 时把 `name`/`description` 复制进 options；停留在同一会话期间条件变化不会自动重载，离开设置页返回会重新挂载。插件列表页在 tab 装载时取快照。
- **包装依赖 Gateway 方法形态。** 依赖方法为可配置 accessor 与固定的结果形状，见「版本契约」。
- **只改显示。** 不改变预设的工具、提示词、插件组合、默认值与会话记录。
- **条件全局求值。** 字典是全局的，不能做到「设置页显示 A、下拉选单显示 B」。
- **接口文案只有 zh / en。** 其它界面语言回落到英文（locale 服务的 fallback 链）。被接管的预设文案仍按各自语言生效。
- **依赖 locale 服务的内部字段。** 见「版本契约」；字段缺失时插件进入「不可用」并在设置页说明，不做猜测。
- **原始文档的结构化保存会规范化。** 在 GUI 里改单元格规则会以规范化 JSON 重写整份文档；未知字段不会保留。手写文档请用原始编辑器保存原文。
- **插件清单是快照。** 插件条件的刷新有节流，Host 插件变化到界面生效可能延迟数秒；重新打开设置页或点「刷新插件清单」可立即刷新。
- **多写者。** 如果另一个插件也改写同一批字典键，后写者生效；本插件只恢复仍属于自己的值，并在状态条显示「被外部改写」计数。
- **不合并预设。** 一个预设的完整文案由同一单元格的规则流水线决定；规则顺序即文档顺序。

## 故障排查

| 现象 | 排查 |
| --- | --- |
| 设置页显示「等待 Agent 预设插件」 | 官方 `dsh-client-ui-agent-preset` 未启用或尚未加载；到「设置 → 插件」确认它已启用，再重新打开设置页。 |
| 设置页显示「不可用」 | 当前 DSH 的 `ctx.locale.dicts` 不存在（版本变化）。看浏览器控制台是否有 `[agent-preset-text]` 前缀的错误；按「版本契约」核对并更新插件。 |
| 规则不生效 | 依次检查：语言标签是否对应、预设/字段是否选对、`when.text` 是否匹配**当前**文本、插件条件（清单里 id/模块名与状态）、工作区（主视图会话的 `cwd`）、文档 `enabled`、设置页是否显示解析错误。 |
| 保存失败 | 状态条或操作结果会显示；确认 profile 设置文档可写（GUI 的原始文档写入走 `configForms`）。 |
| 停用后文本变回原文 | 预期行为：本插件只在运行时改写显示文本。 |
| 控制台出现 `locale revision probe failed` | 本插件独占的探针命名空间被占用（理论上不会）；重启 Host 后恢复。 |
| 文本被外部改写 | 另一个插件写入了同一字典键；本插件不再覆盖，状态条计数增加。移除冲突来源后重新编辑规则。 |
| 自定义预设文本不变化 | 看状态条的「自定义预设」：`命名空间不可用` 表示 `remote.agentPresets` 未挂载；`读取失败` 表示 roster 读取被拒。重新打开设置页或插件列表；控制台应有 `[agent-preset-text]` 前缀的错误。 |
| 改了自定义规则，hero 下拉仍是旧文本 | hero 在 `load()` 时复制字段；离开设置页再返回新任务界面会重新挂载并读取。 |
| 客户端插件重载后自定义文本恢复原文 | 包装随插件卸载还原；下一次重算/命名空间重新可用时会自动重新包装。若持续不生效，重启 Host。 |

## 版本契约

- 面向 DSH **0.2.2-rc.2**。
- 依赖以下 DSH 内部事实（升级时需核对）：
  1. `LocaleRuntime` 的 `ctx.locale.dicts` 字段（`Map<ns, Map<locale, Record<key,string>>>`），字典对象按引用存放、按引用读取；
  2. `settings.agentPreset` 命名空间由 `dsh-client-ui-agent-preset` 注册，含 `preset{Standard,Ptc,Minimal,Cordis}{Name,Description}` 八个键，每语言一份；
  3. `presetDisplayText` 仍从该字典解析内置预设文案，且设置页/hero/标题标签/插件列表仍消费同一折叠；
  4. `LocaleRuntime.register(ns, locale, dict)` 的发布语义（注册与移除各触发一次 revision）；
  5. `remote.agentPresets.list` / `read` 与 `remote.pluginInventory.list` 由 Gateway 安装为**可配置 accessor**，结果是 `{ ok, value }`，roster 行含 `{ id, isDefault, name?, description?, broken? }`，inventory 的 `agentPresets[]` 含 `{ id, name?, isDefault, broken? }`；
  6. 自定义行的判定等价于 `name !== undefined || id 不在内置表`，内置行不能被装饰（否则会改变设置页分组）。
- 升级到新 DSH 后：先运行 `npm run verify`；若设置页显示「不可用」或文本不再变化，按最新源码核对上述四点，更新 `client.js` 的 `acquireDictionaries()` 与 `bumpLocale()`，并提升插件版本号。

## 文件与命名

```
dsh-agent-preset-text/
├── package.json          # exports["./client"]、dsh.bundle、dsh.client、构建脚本
├── cordis.patch.yml      # 装载条目：id = dsh-agent-preset-text
├── index.js              # Host 半：document 字段（volatile）+ 隐藏自动设置页
├── client.js             # Client 半：规则引擎 + 字典接管 + 设置页 GUI
├── icon.svg
├── locale/{zh,en}.json   # 插件页显示名/描述
├── deps.lock.json        # schemastery + cosmokit 的物化锁
├── node_modules/         # build 生成的真实文件树
├── pnpm-workspace.yaml
├── scripts/              # 构建与不变量检查（共享文件是参考副本的逐字节副本）
├── test/engine.test.mjs      # 规则引擎回归
├── test/lifecycle.test.mjs   # 接管/恢复/降级回归
├── README.md
└── FEASIBILITY@0.2.2-rc.2.md
```

命名沿用工作区约定：包名 `@local/<目录名>`，Loader 条目 id 与设置命名空间、Host 半 `ENTRY_ID` 同为 `dsh-agent-preset-text`；客户端界面文案命名空间为 `settings.agentPresetText`。

## 静态验证状态

`npm run verify` 全部通过（真实文件、依赖树、清单契约、双半解析、Host 半导入、`npm test` 两套回归）。

`npm test` 当前为引擎 **75** 项、生命周期 **40** 项。

`npm test` 当前覆盖：

- 文档校验（非法 JSON/版本/规则/操作/正则、空模式、重复 id、默认字段）；
- 通配（文本跨行、路径分段）、模板、正则替换与字面替换、替换次数；
- 选择条件（语言/预设/字段/`key`）、流水线顺序、`{original}`/`{current}`、停用文档、幂等；
- 插件条件（entry id/模块名/enabled/active/absent/清单缺失）；
- 工作区条件（路径 glob、单星不跨段、无工作区不成立）；
- 自定义预设 subject（语言过滤、缺失字段、`when.key` 不匹配、占位符、文本/插件/工作区条件、批量编译、停用文档）；
- roster 包装：accessor 方法包装、消费者看到改名/改说明、内置行不装饰、插件列表分组改名、已暴露行的 live getter、方法重装后自动重包装、卸载还原 descriptor；
- GUI 规则构造与 `isCellRule`；
- 真实 `client.js` 的接管生命周期：原地改写、其它键与语言不受影响、设置页注册、探针命名空间不残留、配置变更/停用/非法文档、卸载恢复、`dicts` 缺失时降级为「不可用」、`remote.agentPresets`/`remote.pluginInventory` 缺失时仍能接管并降级。
