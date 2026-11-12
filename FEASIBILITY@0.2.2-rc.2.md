# FEASIBILITY · 0.2.2-rc.2 — `dsh-agent-preset-text`

> 对应 DSH **0.2.2-rc.2**（Desktop 打包版 `@deepseek-ai/dsh@0.2.2-rc.2`，实现位于 `app.asar/dsh/`）。
> 状态：0.2.0（第三方/自定义预设）已实现，待重启 Host 后人工验收。设计记录见下，0.1.x 实施记录见第 8 节，自定义预设设计与实施见第 9 节。

## 0. 结论速览

| 问题 | 结论 |
| --- | --- |
| 能否在不修改预设的前提下接管说明文本？ | **可以**，但只能接管**内置预设**的 `name` / `description`，因为这两串文本在客户端由 `settings.agentPreset` locale 字典折叠得出，而不是来自 Host 的 roster 行 |
| 是否有官方的「显示文本钩子」？ | **没有**。`dsh-agent-preset-registry/display.ts` 的 `presetDisplayText` 是纯函数，没有注册/覆盖点；`settings.agentPreset` 命名空间是**单占者**（重复注册直接抛错） |
| 推荐机制 | **客户端 locale 字典原位覆写**：拿到 `ctx.locale` 内部按命名空间分组的字典对象，读原始文本 → 规则引擎计算 → 原位写回 → 触发一次 locale revision 让已挂载界面重渲染；卸载时恢复原文 |
| 代价 | 依赖 `LocaleRuntime` 的 `dicts` 字段（TS `private`，运行时是普通字段），属于版本敏感的内部面；必须有特征检测、降级与恢复 |
| 自定义预设 | 本版本**不改写**（其文本来自 roster 行，不经 locale 字典）；`README`/GUI 中明确标注；后续版本可评估 roster 层方案 |
| 配置存储 | Host 半声明一个 `.volatile()` 字符串字段，内容是一份 JSON 规则文档；GUI 通过 `ctx.configForms` 读写，改动即时生效、不重启 |
| GUI | 新增一个 `settings.section` 页：按语言列出各内置预设的原文与生效文本，逐字符串编辑规则；另有原始 JSON 编辑与机制状态 |

---

## 1. 目的与范围

### 1.1 需求

按用户给的条件，对「Agent 预设」的**说明文本**（设置 → Agent 预设页面的卡片、以及新任务界面预设下拉选单里的名称与说明）做展示层操作：

- 条件：特定插件已启用/已激活、处于特定工作区、该预设某个语言的当前说明文本匹配（精确/通配/正则）、无条件，以及若干同类条件；
- 操作：首部附加、尾部附加、按匹配替换、整体重写；
- 多语言：每个语言可以有不同的条件与操作；
- 不修改预设本身（不写 `cordis.patch.yml` 的 preset 行、不重装预设），以便跨 DSH 版本长期生效；
- 提供配置语法与 GUI：能看到各预设的国际化字符串，并对不同字符串分别设置。

### 1.2 目标

1. 内置预设（`standard`、`ptc`、`minimal`、`cordis`）的名称/说明在**所有显示位置**都被接管：设置页卡片、悬停气泡、新任务下拉选单、会话标题旁标签的 `title`、插件列表页的预设切换器。
2. 规则按语言区分；规则可匹配「当前文本」以便在 DSH 更新预设文案时**显式失效或继续命中**（这正是跨版本诉求）。
3. 运行期条件（插件启用状态、当前工作区）变化时自动重算并刷新界面。
4. 不修改预设声明、不修改任何 Host 会话数据；插件卸载/禁用后界面立即恢复原文。
5. 配置为可手工审阅的纯文本，GUI 与原始文本两条编辑路径。

### 1.3 非目标与边界

- **不改写自定义预设**（用户或 bundle 通过 preset 行发布 `name`/`description` 的预设）：其文本来自 Host roster 行，不经过客户端 locale 字典。GUI 会列出它们并标注「本版本不可改」。
- **不改写预设的行为**（工具、提示词、插件组合、默认值、选择逻辑）。
- **不改写设置页的其它文案**（`sectionIntro`、按钮、引导对话框等）；`name`/`description` 之外的键只允许通过原始 JSON 的 `key` 选择器触及，GUI 不暴露。
- 不等价于「每个显示面各自一份文本」：字典是全局的，条件在**全局上下文**中求值（见 3.3），不能做到「设置页显示 A、下拉选单显示 B」。

### 1.4 命名与身份

| 项目 | 取值 |
| --- | --- |
| 目录 | `local-plugins/dsh-agent-preset-text/` |
| 包名 | `@local/dsh-agent-preset-text` |
| Loader 条目 id | `dsh-agent-preset-text`（= Host 半 `ENTRY_ID` = 设置命名空间） |
| 客户端 locale 命名空间 | `settings.agentPresetText`（本插件自己的界面文案） |
| 被接管的命名空间 | `settings.agentPreset`（`dsh-client-ui-agent-preset` 所有，**只写值，不注册**） |
| 配置字段 | `document`（字符串，存 JSON 文档） |
| 初始版本 | `0.1.0` |
| 插件页显示名 | zh「Agent 预设文本」/ en「Agent preset text」 |

---

## 2. 本版本的事实基础（可行性）

### 2.1 说明文本从哪里来

内置预设的文案**不在** Host 的 roster 行里。`dsh-agent-preset-registry/src/display.ts` 的 `presetDisplayText(preset, t)`：

```ts
const keys = isBuiltInPreset(preset) ? BUILT_IN_PRESET_KEYS[preset.id] : undefined
if (keys !== undefined) return { name: t(keys.name), description: t(keys.description) }
return { name: preset.name ?? preset.id, ...(preset.description === undefined ? {} : { description: preset.description }) }
```

- `isBuiltInPreset` = `name === undefined && id` 命中内置表；内置表把 4 个 id 映射到 `preset{Standard,Ptc,Minimal,Cordis}{Name,Description}` 八个键。
- `t` 是**绑定了 `settings.agentPreset` 命名空间**的翻译函数，由 slot 渲染器按注册项的 `locale` 字段生成。
- 自定义预设直接使用 roster 行的 `name`/`description`。

`dsh-client-ui-agent-preset/src/client/index.ts` 的 `apply` 中：

```ts
ctx.effect(() => ctx.locale.register('settings.agentPreset', { zh, en, ja, es, fr, de, ru, pt }), '...')
```

八个语言各一份**完整**字典（含上述八个键）。这解释了为什么「改预设行」对本插件无意义：内置文案的最终来源是客户端字典。

### 2.2 显示位置（同一份字典的消费者）

对已安装的客户端 bundle 做过全量检索（`presetStandardDescription` / `presetDisplayText` / `isBuiltInPreset`）：

| 位置 | 包 | 用法 |
| --- | --- | --- |
| 设置 → Agent 预设 | `dsh-client-ui-agent-preset` | `AgentPresetSection`：卡片名称、`CardDescription`（含 `Tooltip` 悬停全文）、默认徽标、查看配置标题、帮助按钮的 aria 文本 |
| 新任务 hero 下拉 | 同上 | `AgentPresetSeat`：菜单项 `itemName` + `itemDesc`（`text.description ?? t('noDescription')`） |
| 会话标题旁标签 | 同上 | `AgentPresetLabel`：显示名 + `title={text?.description}` |
| 设置 → 插件 → 插件列表 | `dsh-client-ui-settings-plugin-inventory` | 预设切换器与预设分组的显示名（`presetName(preset)`） |

因此**一次字典覆写即可覆盖全部显示位置**，包括 Tooltip 与 `title` 属性——这正是 DOM 替换方案做不到的。

需要顺带更正一个位置描述：0.2.2-rc.2 的预设切换入口**不在** composer 输入栏内部，而是新任务界面上、输入区上方的 hero chip（`AgentPresetSeat` 注册到 `conversation.hero.agentPreset`，`conversation.composer` 里只挂权限/计划/模型等控件）。用户所说的「用户输入区域的切换预设下拉选单」在功能上对应这个 chip，机制对两者一视同仁。

### 2.3 为什么没有现成的显示钩子

- `presetDisplayText` 是纯函数，无注册表、无回调参数可替换。
- `settings.agentPreset` 的注册是**单占者**：`dsh-client-locale/src/client/index.ts` 的 `LocaleRuntime.register` 在 `(ns, locale)` 已存在时抛 `locale namespace "…" already has locale "…"`；因此不能「再注册一份覆盖」。
- 语言包机制（`addLanguage` + `register('common','it',…)`）只能新增语言 id，不能覆盖既有语言的既有键；而且它要求用户切换到一个自造语言，属不可接受的副作用。
- 设置页与 hero chip 这两个主要显示面都是既有 slot 的单一占用者（`settings.section` 的 `agent-presets` 单元、`conversation.hero.agentPreset` 单格）。接管它们等于**重写整个设置页与整个 hero chip**（选择暂存、拒绝 Toast、介绍动画、帮助对话框都在原包里且未导出），与「只改文本、避免过度介入」的目标相悖。

### 2.4 客户端 locale 是唯一低介入的显示层

`LocaleRuntime` 的字典对象是**按引用**存放的：

```ts
let locales = this.dicts.get(ns)            // Map<locale, LocaleDict>
for (const [locale, entries] of pairs) locales.set(localeKey(locale), entries)
// lookup: locales?.get(localeKey(locale))?.[key]
```

`dsh-client-locale/lib/client.js`（构建产物）里该字段为普通字段：`dicts=new Map`。类型里的 `private` 只是 TS 编译期修饰，运行时可通过 `ctx.locale.dicts` 取得 `Map<ns, Map<locale, Record<key,string>>>`。

由此可行：

1. 读 `dicts.get('settings.agentPreset')` 拿到八个语言的字典对象；
2. 备份目标键原始值；
3. 把规则计算后的值写回同一对象——`translate()` 每次调用都重新查表，所有显示面下一次渲染即生效；
4. 需要刷新时，用**公开 API** 触发一次 locale revision（见 3.5）。

这是「显示层」的准确落点：没有复制 UI、没有改预设、没有碰会话数据；作用域恰好是「预设相关的那八个键」。

### 2.5 配置与 GUI 的支撑面

工作区里 `dsh-custom-css` 已验证同一套模式：

- Host 半用 `@deepseek-ai/schemastery` 声明 `Config`，字段 `.volatile()`；`ctx.inject(['settings'], …)` + `settings.configure({ auto: false }, ctx.fiber)` 表示该条目不生成自动设置页；
- 客户端用 `ctx.configForms.get('<entry-id>')` 读到 `ConfigForm`（`getSnapshot/subscribe/set/unset/mutate`，见 `dsh-client-ui-settings/src/client/config-form.ts`），写走 `ctx.remote.settings`，`.volatile()` 字段写到即生效、不重启；
- 客户端用 `ctx.slots.inject('settings.section', () => ctx.slots.register({ name:'settings.section', id, order, label, locale }, Page))` 增加一页；`label` 用 thunk 即可跟随语言。

因此「规则文档 + GUI」不需要新的持久化机制：**插件自己的 volatile Config 就是存储**，GUI 只是它的结构化编辑器。

### 2.6 条件所需的数据面

| 条件 | 数据来源 | 证据 |
| --- | --- | --- |
| 语言 | `ctx.locale.getLocale().active`；语言集合 = 字典的 key 集合 | locale Service 契约 |
| 预设 / 字段 | 内置映射表 + 字典键；roster 可通过 `ctx.remote.agentPresets.list()` 读 `{ presets: [{ id, isDefault, name?, description?, broken? }] }` | `dsh-agent-preset-registry/src/types.ts` |
| 当前文本 | 字典原文快照（安装时捕获，见 3.4） | 同上 2.4 |
| 特定插件 | `ctx.remote.pluginInventory.list()` → `entries: [{ entryId, moduleName, enabled, fiberPhase, diagnostic? }]`；`fiberPhase` ∈ `pending/loading/active/failed/unloading/null` | `dsh-host-plugin-inventory/src/types.ts` |
| 特定工作区 | 主视图会话的 `cwd`：`ctx.sessions.list.getSnapshot()` + `ctx.sessions.retainInfo(id)` 的 `retainedBy.mainView`；`SessionSummary` 带 `cwd` | `dsh-api-session-controller/src/client/sessions/service.ts` |

「工作区」的定义要在实现时写死并写进 README：**主视图中显示的那个会话的 `cwd`**（优先空白会话，否则取最近更新的一个）；没有主视图会话时视为没有工作区，工作区条件不成立。这样新任务界面的条件跟当前选择的目录一致；设置页打开时也能得到同一个值。

### 2.7 可行性结论

机制可行，但有一个必须承认的版本风险：**`ctx.locale.dicts` 是内部字段**。它是本版本唯一能在不重写界面的前提下接管内置文案的位置。缓解手段：

- 启动时特征检测（`ctx.locale.dicts instanceof Map`、目标命名空间存在、字典是普通对象），失败则不接管并在 GUI 里显示明确状态；
- 所有读写都走同一份 `originals` 快照，卸载/禁用时恢复；
- 依赖面写进 README 的「版本契约」，DSH 升级后按 FEASIBILITY 的升级流程重新核对；
- 若未来该字段消失，降级路径是第 4 节的方案 B「接管两个 slot」（代价大，但语义相同）。

---

## 3. 核心进路

### 3.1 总览

```
Host 半                                   Client 半
┌─────────────────────────────┐          ┌──────────────────────────────────────────┐
│ Config.document (volatile)  │◄─ set ───│ configForms.get('dsh-agent-preset-text') │
│ settings.configure(auto:    │          │        ▲                                 │
│   false)                    │          │        │ 渲染                         │
└─────────────────────────────┘          │  ┌──────┴───────┐   hooks   ┌──────────┐ │
                                          │  │ 规则引擎      │──────────►│ 设置页 GUI│ │
   ctx.locale.dicts                       │  │ + 状态 store  │◄─────────│ (React)  │ │
   settings.agentPreset                   │  └──────┬───────┘  编辑规则  └──────────┘ │
   ┌───────────────────────────┐          │         │ 读原文/写生效值                     │
   │ zh: {presetStandardDesc…} │◄─────────┼─────────┘  (原位覆写)                        │
   │ en: {…} …                 │          │                                            │
   └───────────────────────────┘          │  条件数据：pluginInventory / sessions /    │
                                          │           locale / current document         │
                                          └────────────────────────────────────────────┘
```

### 3.2 机制：字典原位覆写

安装（`apply` 内，可重入）：

1. 通过 `ctx.locale` 取 `dicts`；取 `dicts.get('settings.agentPreset')`。若不存在（插件未启用或尚未注册），订阅 `ctx.locale` 快照并在每次 revision 变化时重试；找到后继续。
2. 为每个 `(locale, key)` 记录 `originals[locale][key] = dict[key]`；同时记住字典对象身份（locale → object）。
3. 运行规则引擎，计算 `effective[locale][key]`。
4. 与字典当前值不同的才写回；记录写过的键。
5. 若本次有写入或机制状态变化，触发一次 locale revision（3.5），让已挂载的显示面重渲染。

重算（规则、条件、字典对象变化时）：始终从 `originals` 出发，而不是从字典现值出发，因此重算是幂等的；若发现字典对象身份变化（`dsh-client-ui-agent-preset` 被重载/HMR，重新注册了字典），则以新对象重建 `originals`（新对象里是原文）。

卸载（效果清理）：把 `originals` 写回仍在 `dicts` 里的对象，触发一次 revision，然后释放订阅。

### 3.3 规则引擎

纯函数核心，与 React/浏览器解耦，便于 `node --test`：

- `parseDocument(text) → { ok, document | errors[] }`：JSON 解析 + 结构校验 + 正则/通配预编译；
- `computeTexts(document, originals, context) → Map<locale, Map<key, string>>`：按文档顺序逐条应用；
- `globToRegExp(pattern, mode)`：文本模式与路径模式两种通配语义；
- `renderTemplate(text, vars)`：`{preset}`、`{field}`、`{locale}`、`{original}`、`{current}` 占位符，`{{` / `}}` 转义。

条件求值一律 **AND**；未给出的条件视为不限制。规则按文档顺序**依次**应用，后一条看到的是前一条的结果（流水线语义），`when.text` 匹配的也是当前工作文本。

### 3.4 配置文档语法

`Config.document` 是一份 JSON 文本（GUI 生成/校验，也可手写）。版本化以便将来迁移：

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
      "then": { "op": "append", "text": "\n（本机补充：优先用 bash 而不是 GUI）" }
    }
  ]
}
```

字段说明：

| 字段 | 取值 | 缺省 | 含义 |
| --- | --- | --- | --- |
| `version` | `1` | 必填 | 文档版本；未知版本整体不生效并在 GUI 报错 |
| `enabled` | boolean | `true` | 全局开关 |
| `rules[].id` | string | 自动生成 | 仅用于 GUI 定位与去重 |
| `when.locales` | string \| string[] | `"*"` | 匹配语言 id；`"*"` 表示所有语言 |
| `when.presets` | string \| string[] | `"*"` | 预设 id；GUI 用内置四个 id |
| `when.fields` | `"name"` \| `"description"` \| `"*"`（可数组） | `"description"` | 字典字段 |
| `when.key` | string（字典键，高级） | — | 直接指定 `settings.agentPreset` 的键；与 `presets`/`fields` 同时给出时取交集 |
| `when.text` | `{mode, pattern, flags?}` | 不限制 | 对**当前工作文本**匹配：`exact` / `glob` / `regex` |
| `when.plugin` | string（entry id 或模块名）\| `{id, state}` | 不限制 | `state`: `enabled`（默认）/ `active` / `absent`；按 `pluginInventory` 判定 |
| `when.workspace` | string（路径 glob） | 不限制 | 匹配 2.6 定义的工作区路径；`**` 跨目录、`*` 段内 |
| `then.op` | `"prepend"` \| `"append"` \| `"replace"` \| `"rewrite"` | 必填 | 首部附加 / 尾部附加 / 按匹配替换 / 整体重写 |
| `then.text` | 模板字符串 | 必填 | 操作文本；支持占位符 |
| `then.find` | `{mode, pattern, flags?}` | — | `replace` 的查找式；缺省时 `replace` 等价于 `rewrite` |
| `then.count` | `"all"` \| `"first"` | `"all"` | `replace` 的替换次数 |

**候选但刻意不纳入 0.1.0 的条件**：`when.activeLocale`（与 `locales` 重叠，没有独立价值）、`when.presetDefault`（只影响设置页徽标旁的文本，收益低）、`when.sessionRunning`/时间窗（与「说明文本」无关，且引入不必要的求值时机）。它们可以在后续版本按同一语法追加，不影响已有文档。

语义细则（实现时写进 README）：

- `prepend` / `append`：`then.text + current` / `current + then.text`；
- `replace`：按 `then.find` 替换；`regex` 模式下 `then.text` 支持 `$1`、`$&` 等替换语法，`glob`/`exact` 模式下替换命中子串；
- `rewrite`：忽略 `current`，直接以模板结果为准（模板里仍可用 `{original}`/`{current}`）；
- 规则可叠加：同一字符串可被多条规则依次处理，GUI 的单元格编辑器支持列出并增删该单元格的规则；
- 非法正则/通配或未知版本：**整份文档拒绝生效**，GUI 报出具体规则 id 与原因，界面保持上一份可用文档的效果。

### 3.5 刷新与恢复

**revision 触发**：locale 服务没有公开的「只 bump revision」方法；`setLocale(同一 id)` 按源码不 publish。使用公开 API 的探针式触发：

```js
const dispose = ctx.locale.register(PROBE_NS, 'en', {})
dispose() // 两次 publish：注册一次、移除一次
```

`PROBE_NS` 为本插件独占、无消费者。只有「确实发生写入/恢复」时才触发，避免无谓重渲染。这是本方案里唯一的「技巧性公开调用」，在 FEASIBILITY 与 README 中标注。

**重算触发源**（合并到一个 microtask 里防抖）：

- `configForms` 快照变化（规则被编辑）；
- `ctx.locale` 快照变化（语言切换、字典晚到或被重新注册——顺带重捕获 `originals`）；
- `ctx.sessions.list` 变化 + 对候选会话 `retainInfo` 的订阅（工作区变化/会话切换）；
- `ctx.remote.$on('plugin-manager/changed')`、`ctx.on('connection/reset')`、`settings/document-updated`：刷新 `pluginInventory` 后再算；
- 本插件设置页打开时主动刷新一次 inventory。

**inventory 的新鲜度**：`pluginInventory/list` 是点位快照（无变更订阅）。带插件条件的规则存在时，重算前按「至少间隔 2 s」刷新一次；失败则保留上次快照并把状态显示在 GUI，不阻塞其它规则。

**卸载恢复**：见 3.2 的「卸载」段。恢复必须只写回「本插件写过且仍是原文被覆盖的值」的键；如果别人在这期间改过同一个键（理论上不会），不覆盖别人的值。

### 3.6 GUI（设置 → Agent 预设文本）

新增 `settings.section` 一页（`order: 21`，紧跟官方「Agent 预设」的 20），自有 CSS 前缀与 `--dsw-alias-*` 主题变量，文案进 `settings.agentPresetText` 字典（zh/en）。

页面结构：

1. **标题 + 说明**：一句话解释「只改显示，不改预设」。
2. **机制状态条**：`已接管 / 等待 Agent 预设插件 / 不可用（内部接口变化）`；当前语言；生效规则数；配置写入失败提示；`pluginInventory` 不可用提示。
3. **语言切换**：字典里出现的语言 id（8 个内置语言）作为标签/下拉。
4. **预设表格**（当前语言）：每个内置预设 → `名称`、`说明` 两行，展示「原文」与「生效文本」（原文可展开/悬停看全），生效文本与原文不同时打「已改写」标记；单元格旁「编辑规则」。
5. **单元格规则编辑器**（行内展开或模态）：该单元格已有的规则列表（增/删/改、上下移），以及添加规则表单：
   - 操作：首部附加 / 尾部附加 / 替换 / 重写；
   - 文本输入（多行 textarea）；
   - 匹配条件：当前文本（精确/通配/正则 + 模式）、要求插件、要求工作区；
   - 保存即写回 `Config.document`，界面按返回值提示成功/失败。
6. **原始文档**：折叠的 textarea，展示格式化后的 JSON；保存时先解析校验，错误逐条显示（行/列或规则 id）。
7. **自定义预设提示**：若 roster 里有自定义预设，列出并注明「本版本只接管内置预设」。

状态全部通过 `inject` 返回的 `hooks`（自写的最小 `getSnapshot/subscribe` store）传给组件；组件不直接持有 `ctx`。

### 3.7 生命周期

- `apply` 里用 `ctx.effect()` 管住：字典订阅、config form 订阅、sessions/retainInfo 订阅、remote 事件监听、revision 探针。
- 所有注册（locale 字典、settings section）都在 `ctx.effect` 内，禁用插件即整体撤销。
- 客户端 `inject`：`['slots', 'locale', 'configForms', 'remote']`；`dsh.client.inject`（包名，仅排激活顺序）暂定 `@deepseek-ai/dsh-client-ui-slots`、`@deepseek-ai/dsh-client-locale`、`@deepseek-ai/dsh-client-ui-settings`、`@deepseek-ai/dsh-api-remotes`、`@deepseek-ai/dsh-client-ui-primitives`。**不**把 `dsh-client-ui-agent-preset` 放进硬依赖：字典晚到时靠 locale 订阅补齐，profile 里缺它时本插件仍可加载并显示「等待 Agent 预设插件」。
- 不写 DOM、不 import 其它 Harness 客户端包的值（React 与图标从平台模块表 `require`，与工作区既有插件一致）。

### 3.8 Host 半

```js
import z from '@deepseek-ai/schemastery'
export const ENTRY_ID = 'dsh-agent-preset-text'
export const CONFIG_FIELD = 'document'
export const Config = z.object({ [CONFIG_FIELD]: z.string().default('').volatile() })
export function apply(ctx) {
  ctx.inject(['settings'], child =>
    child.effect(() => child.settings.configure({ auto: false }, ctx.fiber)))
}
```

- 零业务逻辑：文档的解析/校验/生效全在客户端（文本只在浏览器里显示）。
- 因为 import 了 `schemastery`，必须按 `BUILD-SYSTEM.md` 用 `--pin @deepseek-ai/schemastery@3.18.4` 写 `deps.lock.json`、生成真实文件 `node_modules/`（可直接参考 `dsh-custom-css` 的锁与 vendor 白名单）。
- `cordis.patch.yml` 的 `id` 必须等于 `ENTRY_ID`（verify 会核对）。

---

## 4. 备选方案与取舍

| 方案 | 做法 | 结论 |
| --- | --- | --- |
| **A. 字典原位覆写（选定）** | 见 3.2 | 覆盖全部显示面（含 Tooltip/`title`），代码量小，不改预设；代价是依赖 locale 内部字段 |
| B. 接管两个 slot | 复用相同 id 覆盖 `settings.section#agent-presets` 与 `conversation.hero.agentPreset`，自己重画 | DSH 文档把 `single`/占用的 keyed 单元视为「替换点」，但设置页与 hero chip 的暂存选择、拒绝 Toast、介绍动画、帮助对话框都在原包里且未导出；重写会丢功能、且对 DSH 升级最脆弱。**不采用**（作为字典字段消失时的降级路径） |
| C. Host 侧改 roster | 让 `agentPresets/list` 返回改写后的 `name`/`description` | 内置预设的文案仍在客户端由 locale 字典解析；若强行补 `name`，`isBuiltInPreset` 变假，设置页会把内置预设移入「自定义」分组并失去帮助按钮。**不可行** |
| D. DOM 替换 | 观察 DOM 改写文本节点 | Tooltip 与 `title` 属性改不到；依赖哈希类名/结构；违反宿主「不要读写别的插件 DOM」的规则。**不采用** |
| E. 伪造语言包 | `addLanguage` + 新语言 id 字典，要求用户切换语言 | 覆盖每个语言都要用户切换，且改变整个界面的语言语义。**不可采用** |

---

## 5. 问题与解决办法

| # | 问题 | 根因 | 办法 |
| --- | --- | --- | --- |
| 1 | `ctx.locale.dicts` 是内部字段 | locale 只提供注册/绑定，没有覆盖/枚举 API | 特征检测 + 失败可见 + 升级核对；卸载恢复；README 写明版本契约 |
| 2 | 命名空间单占者，无法再注册覆盖 | `LocaleRuntime.register` 对 `(ns, locale)` 重复抛错 | 只做原位值覆写，不注册 `settings.agentPreset` |
| 3 | 改完字典界面不刷新 | React 只在 revision 变化时重渲染 | 公开 API 探针：`register(独占 ns, 'en', {})` + 立即 dispose，两次 publish；仅在确有变化时调用 |
| 4 | 内置插件重载/HMR 后字典对象被替换 | 新对象是原文，旧对象已脱离服务 | 订阅 locale revision，比对对象身份；变化则重建 `originals` 并重算 |
| 5 | 语言切换后重新计算是否会读到自己写的值 | 曾写入字典 | 永远从 `originals` 计算；`originals` 只在对象身份变化时重建 |
| 6 | 插件启用状态变化没有订阅 | `pluginInventory/list` 是点位快照 | 事件（`plugin-manager/changed`、连接重置、设置更新）+ 设置页打开时主动刷新 + 2 s 节流；状态在 GUI 可见 |
| 7 | 「当前工作区」没有现成字段 | 没有 `currentWorkspaceId`；`WorkspaceSnapshot` 只有列表 | 取主视图会话（`retainedBy.mainView > 0`）的 `cwd`，空白优先、最近更新兜底；无会话即条件不成立 |
| 8 | 自定义预设改不了 | 文本来自 roster 行，不经 locale | 明示边界；后续版本可评估「客户端包装 `remote.agentPresets.list`」或 Host 侧 roster 层方案（需另写 FEASIBILITY） |
| 9 | 条件只能全局求值 | 字典是全局的 | 明示：不能按显示面分别取文本；条件随全局上下文变化重算 |
| 10 | JSON 字段无 schema 级校验 | Config 只声明字符串 | 客户端解析/校验；非法文档整体不生效并保留上一份；GUI 报错定位 |
| 11 | Host 半 import schemastery | profile 不提供该包 | 按构建系统 pin + vendor（复用 `dsh-custom-css` 的锁） |
| 12 | 与官方插件注册顺序 | 我方可能先加载 | 订阅 locale 快照，字典晚到也能接管；`dsh.client.inject` 只声明基础包（slots/locale/settings/api-remotes/primitives），不硬依赖官方插件 |
| 13 | 文本匹配的「原文」与「当前」歧义 | 规则是流水线 | 规则按序应用；`when.text` 匹配当前工作文本；`{original}` 始终指安装时快照；写进 README |
| 14 | 多写者冲突（另一个插件也改同一字典键） | 字典对象共享 | 后写者胜；本插件恢复时只写回「当前值仍等于本插件写入值」的键，不覆盖别人的写入；GUI 状态里提示「生效文本被外部改写」 |

---

## 6. 实施步骤（下一轮）

### 6.1 文件与清单

```
dsh-agent-preset-text/
├── package.json          # exports[./client], dsh.bundle.patch, dsh.client, files[], scripts
├── cordis.patch.yml      # insert: id: dsh-agent-preset-text
├── index.js              # Host 半：Config.document(.volatile) + settings.configure(auto:false)
├── client.js             # Client 半：字典接管 + 规则引擎 + 设置页
├── icon.svg
├── locale/{zh,en}.json   # 插件页显示名/描述
├── deps.lock.json        # @deepseek-ai/schemastery@3.18.4 + cosmokit（复用 custom-css 的锁）
├── node_modules/         # build.mjs 生成的真实文件树
├── pnpm-workspace.yaml   # 与既有插件一致
├── scripts/              # node build-system/sync.mjs dsh-agent-preset-text 生成
├── test/engine.test.mjs  # 纯函数规则引擎回归（无浏览器）
├── README.md             # 最后写，反映最终实现
└── FEASIBILITY@0.2.2-rc.2.md
```

### 6.2 分阶段

1. **骨架**：`sync` 构建系统 → `package.json`/`cordis.patch.yml`/`index.js`/`locale`/`icon` → `npm run build` 通过（Host 半导入 + 清单契约）。
2. **引擎**：`parseDocument` / `globToRegExp` / `computeTexts` / `renderTemplate` + `test/engine.test.mjs`（覆盖条件组合、四种操作、非法规则、占位符、幂等重算）。
3. **接管层**：locale 字典发现/快照/写入/恢复、revision 探针、config 订阅、inventory 与工作区条件、防抖重算；控制台错误一律可见。
4. **GUI**：设置页（状态条、语言切换、预设表格、单元格规则编辑、原始 JSON），自有 CSS/主题变量，zh/en 文案。
5. **文档与验收**：README（含机制边界、条件语义、版本契约、故障排查）+ FEASIBILITY 实施记录；`npm run verify`；重启后人工验收。

### 6.3 验证与验收

- `npm run verify`：真实文件不变量、依赖与锁、清单契约、两个半都可解析、Host 半在全新进程可导入、`ENTRY_ID` 与 patch id 一致。
- `npm test`（也就是 `node test/engine.test.mjs`）：纯函数回归（含幂等、对象身份替换后的重建、非法文档）；`verify` 会按 `package.json` 的 `test` 脚本把它一并跑掉。
- 人工（需重启 Host + 刷新页面）：
  1. 设置 → Agent 预设：卡片说明与悬停气泡按规则变化；名称不变时保持原文；
  2. 新任务 hero 下拉：菜单项说明同步变化；
  3. 会话标题旁标签的 `title` 同步变化；
  4. 切换语言：不同语言的规则分别生效；
  5. 启用/停用条件插件、切换工作区：自动重算；
  6. 清空配置 / 禁用插件：界面恢复原文；
  7. 宿主控制台无 `slot entry crashed` 或未捕获异常。

### 6.4 已知的「必须重启」节点

profile bundle 列表在 Host 启动时合成，安装本插件后必须**重启 DSH** 才能生效；按工作区规则，实施到那一步即停止并提示重启，不尝试绕过。

---

## 7. 证据索引

| 结论 | 位置 |
| --- | --- |
| 内置文案经 `settings.agentPreset` 字典折叠 | `@deepseek-ai/dsh-agent-preset-registry/src/display.ts`（`presetDisplayText`、`BUILT_IN_PRESET_KEYS`、`isBuiltInPreset`） |
| 字典注册（8 语言）与设置页/hero/label 注册 | `@deepseek-ai/dsh-client-ui-agent-preset/src/client/index.ts`（`ctx.locale.register`、`slots.register`） |
| 设置页卡片与 Tooltip 使用折叠结果 | `.../src/client/AgentPresetSection.tsx`（`presetDisplayText(row, t)`、`CardDescription`） |
| hero 下拉菜单项文案 | `.../src/client/AgentPresetSeat.tsx`（`itemName`/`itemDesc`、`presetDisplayText`） |
| 标题标签 `title` | `.../src/client/AgentPresetLabel.tsx` |
| 插件列表页也消费同一字典 | `@deepseek-ai/dsh-client-ui-settings-plugin-inventory/lib/client.js`（`presetDisplayText`、`ctx.locale.bind('settings.agentPreset')`） |
| locale 注册单占者 / 字典按引用存放 / publish 语义 | `@deepseek-ai/dsh-client-locale/src/client/index.ts`（`LocaleRuntime.register`、`dicts`、`publish`、`setLocale`、`bind`） |
| 构建产物中 `dicts` 为普通字段 | `@deepseek-ai/dsh-client-locale/lib/client.js`（`LocaleRuntime`：`dicts=new Map`） |
| `ConfigForm` 读写面 | `@deepseek-ai/dsh-client-ui-settings/src/client/config-form.ts`（`ConfigForms.get`、`ConfigForm.set/mutate`） |
| volatile Config + 隐藏自动页的既有实践 | `@deepseek-ai/dsh-client-locale/src/index.ts`；本工作区 `dsh-custom-css/index.js`、`client.js` |
| 插件 inventory 行形状 | `@deepseek-ai/dsh-host-plugin-inventory/src/types.ts`（`PluginInventoryEntry`） |
| 会话 `cwd` 与 retain 计数 | `@deepseek-ai/dsh-api-session-controller/src/client/sessions/service.ts`（`SessionSummary`、`retainInfo`） |
| slot 基数/优先级/替换语义 | `@deepseek-ai/dsh` 文档 `docs/subsystems/slots.md`；Client Inspect `Slots.listSubTree` |
| 构建系统要求 | 本工作区 `BUILD-SYSTEM.md`；`build-system/scripts/verify.mjs`（清单契约） |

---

## 8. 实施记录（2026-11-12）

### 8.1 已交付

| 文件 | 内容 |
| --- | --- |
| `package.json` | 包身份、`exports`、`dsh.bundle`/`dsh.client`、构建与测试脚本、`schemastery` 依赖 |
| `cordis.patch.yml` | 条目 `dsh-agent-preset-text` |
| `index.js` | Host 半：`document` 字段 `.volatile()`、`settings.configure({ auto: false })` |
| `client.js`（1941 行） | 纯规则引擎、locale 字典接管与恢复、条件求值、设置页 GUI、样式 |
| `locale/{zh,en}.json` | 插件页显示名/描述 |
| `icon.svg` | 插件图标 |
| `deps.lock.json`、`node_modules/`、`pnpm-workspace.yaml` | 复用 `dsh-custom-css` 的 schemastery 锁与物化结果 |
| `scripts/` | `sync` 生成的构建系统副本 + 本插件的 `host-contract.mjs` |
| `test/engine.test.mjs` | 63 项规则引擎检查 |
| `test/lifecycle.test.mjs` | 24 项接管/变更/恢复/降级检查 |
| `README.md` | 使用、语法、机制、边界、故障排查、版本契约 |

构建与自检：`npm run build` 后 `npm run verify` 全部通过（依赖树与锁一致、清单契约、双半解析、Host 半全新进程导入、`ENTRY_ID` 与 patch id 一致、`npm test` 两套回归）。插件已按 README 的步骤接入 `~/.dsh/profiles/desktop`。

### 8.2 实现期的决定（对设计的细化）

1. **文档存储为字符串**：`Config.document` 是普通字符串，客户端解析/校验。结构化保存写规范化 JSON；原始编辑器保存用户输入的原文（先校验）。
2. **默认字段规则**：`when.fields` 缺省为 `['description']`；给出 `when.key` 时缺省为 `['*']`，否则按 key 覆盖其它字典键会被默认字段误挡。
3. **`absent` 的定义**：清单中不存在该 id 的**已启用**实例；不是「进程里完全没有该条目」。
4. **工作区**：主视图会话的 `cwd`；空白会话优先，否则最近更新。无主视图会话时工作区条件不成立。
5. **条件全局求值**：字典是全局的，因此条件在一次重算里统一求值；README 明示不能按显示面分别取文本。
6. **所有权与恢复**：每个 `(locale, key)` 记住「本插件写入的值」；只覆盖原文或本插件自己的值，外部写入计为冲突且不覆盖。卸载时只恢复仍等于本插件写入值的键。
7. **刷新探针**：`register(独占探针 ns, 'en', {})` + 立即 dispose，两次 publish；只在确有写入/恢复时调用。生命周期测试断言探针命名空间不残留。
8. **GUI 范围**：设置页只管理目标语言/预设/字段精确匹配的「单元格规则」；通配、按 `key`、组合条件由原始 JSON 管理（README 与页面内均有说明）。
9. **接口语言**：界面文案只注册 zh/en；其它语言回落到英文，被接管的预设文案仍按各自语言生效。
10. **测试暴露面**：`__test` 额外导出 `AgentPresetTextSection`，用于在无浏览器的 Node 桩下做一次整棵 React 树的渲染冒烟。

### 8.3 问题与解决办法（实现中发现）

| 症状 | 根因 | 修法 |
| --- | --- | --- |
| 第二次修改规则后文本不更新；停用 `enabled` 也不恢复 | 幂等重算发现 `actual === want` 时删除了「本插件写入」记录，后续变化被当作外部写入而跳过 | 仅当 `want === original` 时才删除记录；`actual === want` 且仍非原文时保留所有权 |
| 空查找模式会把替换文本插到每个字符之间（`split('')`） | `exact`/`glob` 模式没有空串防护 | 校验拒绝空 `exact`/`glob` 模式；引擎对任何空模式直接返回原文本 |
| 重复规则 id 让 GUI 编辑命中第一条 | 校验未要求 id 唯一 | `normalizeDocument` 检查重复并整体拒绝 |
| 首轮 `npm run verify` 报 `no macOS sidecar files` | 目录里出现 `.DS_Store` | 删除后重跑（构建系统本来就会清理这类文件） |
| `ctx.locale.dicts` 的可达性需要确认 | 服务经 `ctx.provide('locale', runtime)` 注册，`LocaleRuntime` 不是带 tracker 的 Service 子类；`getTraceable` 因此返回原实例 | 已在 cordis 源码与 locale 源码两侧核对；生命周期桩也镜像了该访问面 |
| 配置写入后的乐观状态与表单快照竞争 | `form.set` 在 mirror 接受后才 resolve | `persist` 在成功时同步更新 `lastRaw`/`lastDocument`，`readConfig` 对相同 raw 直接跳过 |
| 写字典触发 locale 订阅造成重算循环 | 每次写入都调用 revision 探针 | 重算幂等：第二次实际值已等于期望值，不再写入、不再触发探针 |

### 8.4 验证结果

- `npm test`：引擎 63 项、生命周期 28 项，全部通过。
- 渲染冒烟：设置页主分支、单元格编辑器分支、原始文档分支、`unsupported` 空状态均能构造出完整 React 树（无未定义引用）。
- `npm run verify`：全部通过。
- **尚未做的**：真实浏览器里的视觉/交互验收。安装已写入 profile，但 bundle 列表在 Host 启动时合成，必须重启 DSH 才能加载本插件；重启后按 6.3 的清单人工验收（设置页、hero 下拉、标题 `title`、插件列表、语言切换、插件/工作区条件、停用恢复、控制台无异常）。

### 8.5 后续可评估

- 自定义预设的接管（roster 层，需另写可行性记录）；
- 更丰富的 GUI（组合条件、按显示面分流、导入/导出）；
- 若 DSH 未来提供正式的显示文本扩展点，把字典覆盖替换为公开 API。


### 8.6 修复记录：Remote 命名空间不能直接读取（2026-11-12，0.1.1）

**症状**：插件首次加载失败，Web boot 报 `1 entry did not activate`，控制台另有两条未处理的 promise 拒绝：

```
@local/dsh-agent-preset-text: failed: Error: cannot get property "remote.pluginInventory" without inject
Uncaught (in promise) Error: cannot get property "remote.agentPresets" without inject
```

**根因**：API Gateway 把每个 Remote 命名空间注册成独立的 Cordis 服务，服务名就是 `remote.<namespace>`；`ctx.remote.<ns>` 的属性读取受 inject 门禁保护，而本插件只声明了 `remote`，没有声明这两个命名空间。Host 半与字典接管本身没有问题，失败发生在 `apply` 里的首次 roster/inventory 读取。

**修法**：

1. 新增 `remoteNamespace(name)`，统一用 `ctx.get('remote.' + name)` 读取：`ctx.get` 不要求 inject，命名空间尚未挂载时返回 `undefined`，由调用方降级；
2. `refreshRoster` / `refreshInventory` 改用该函数；
3. 增加 `ctx.inject(['remote.agentPresets', 'remote.pluginInventory'], …)`：命名空间晚于本插件挂载时，可用后自动补读一次，并随服务消失而卸载；**不**把这两个可选服务放进插件 `inject`，以免 roster/inventory 不可用时整个接管能力（核心功能）无法加载；
4. 生命周期测试新增「没有 Remote 命名空间」场景：`apply` 不抛错、字典接管仍生效、设置页仍注册、清单状态降级为 `error`。

**选择说明**：官方 `dsh-client-ui-agent-preset` / 插件列表页把 `remote.agentPresets`、`remote.pluginInventory` 放进 `inject`，因为它们的核心功能依赖这些服务；本插件的核心是字典接管，roster/inventory 只影响附加信息与条件，因此采用可选读取 + 延迟补读，保留设计中的降级语义。

**验证**：引擎 63 项、生命周期 28 项全部通过；`npm run verify` 全部通过。修复后必须重启 Host（或让加载条目重启）才能重新发布浏览器 bundle，见 README 的安装说明。

---

## 9. 第三方 / 自定义预设的接管（设计，2026-11-12）

> 本节是 0.2.0 的新功能设计，**尚未实现**。第 1–8 节描述的 0.1.x 行为保持有效；本节取代「自定义预设本版本不改写」这一边界。

### 9.1 目的与范围

第三方/自定义预设（由用户或 bundle 通过 preset 行发布 `name` / `description` 的预设）目前完全不经过 `settings.agentPreset` 字典，因此 0.1.x 的字典覆盖对它们无效。目标是让它们与内置预设享受同一套规则能力：

- 条件：语言（按当前界面语言）、预设 id、字段（名称/说明）、当前文本（精确/通配/正则）、插件启用状态、当前工作区；
- 操作：首部附加、尾部附加、替换、重写，规则流水线；
- 多语言：自定义预设本身没有随语言变化的文案，规则按**当前界面语言**选择，从而实现按语言显示不同文本；
- 不修改预设声明，只改显示；禁用插件后恢复原文。

### 9.2 事实基础

**文本来源与消费者**（与内置预设不同）：

- roster 来自 `agentPresets/list`，每行是 `AgentPresetRow { id, isDefault, name?, description?, broken? }`；自定义预设的 `name`/`description` 直接来自 preset 声明（`dsh-agent-preset-registry/src/types.ts`）。
- `presetDisplayText()` 对 `name !== undefined` 或未知 id 的行直接使用行内文本（`display.ts` 的 `isBuiltInPreset`）。
- 消费点：
  - 设置 → Agent 预设：`AgentPresetSectionController` 把 `result.value.presets` **原样存进 store**（`section-store.ts`），组件每次渲染再调 `presetDisplayText`；
  - 新任务 hero chip 与标题标签：`presetOptions()` 在 `load()` 时把每行**复制**成 `{id, name?, description?}`（`settings-store.ts`）；`AgentPresetSeat` 用该快照渲染；
  - 插件列表页：`pluginInventory/list` 的 `agentPresets[]`（`id`、`name?`、`isDefault`、`broken`、`rows`）经 `presetDisplayText` 取名（`PluginInventorySettingsTab.tsx` 的 `presetName`）。
- 刷新时机：hero/标签在挂载时 `load()`；主面板切换会让 Conversation 整棵 keyed main 单元**卸载再挂载**（`AppFrame` 的 `renderSlot('main', {}, { entryKey })`），所以从设置页返回新任务界面会重新读 roster。设置页的行对象是直接引用，渲染时读 `name`/`description`。插件列表页在 tab 首次挂载时读一次快照。

**Remote 方法的真实形状**（决定能否在客户端包装）：

- API Gateway 把每个命名空间注册成 Cordis 服务 `remote.<namespace>`（`remoteServiceKey`）。
- `RemoteNamespaceService.install()` 用 `Object.defineProperty(this, method, { configurable: true, enumerable: true, get: () => (...args) => invokeRemote(...) })` 安装方法；每次读取 getter 时按**调用方 context** 生成调用闭包。
- 网关卸载贡献时 `remove()` 会 `delete` 该方法；重新挂载时再装回 accessor。
- 因此：方法属性**可配置、可覆盖**；包装必须保存原 descriptor 并在卸载/替换时恢复；网关重装后需要重新包装。

### 9.3 核心进路：客户端 roster 包装

在 Client 半里包装 `remote.agentPresets` 的 `list` / `read` 与 `remote.pluginInventory` 的 `list`，对**自定义行**做显示层改写：

1. **安装包装**：`ctx.get('remote.agentPresets')` 取到命名空间服务；对每个方法：
   - 记录原 property descriptor；
   - 捕获原调用（getter 形态或 data 形态）；
   - 用 `Object.defineProperty` 安装一个可配置的 data property 包装函数；
   - 包装内部用 `descriptor.get.call(this)`（`this` 是调用方经 traceable 代理拿到的 shadow）获取**按调用方 context** 绑定的原方法，保证远程访问控制/取消语义不因包装改变；data 形态则用原函数。
2. **行装饰与惰性 getter**：对自定义行返回浅拷贝，`name` / `description` 用 `getter` 从当前生效表读取（运行时 `locale` 的当前语言）。这样：
   - 设置页直接持有行对象 → 每次重渲染都读到最新文本；
   - `presetOptions` 这类复制字段的消费者在 `load()` 时取值，之后由重新挂载刷新（见 9.6）。
3. **插件列表页**：装饰 `pluginInventory.list()` 结果里的 `agentPresets[].name`（同样用 getter），内置分组保持 `name === undefined`，继续走字典。
4. **`read`**：同步装饰 `name` / `description`，覆盖查看配置标题的兜底路径。
5. **生效表**：重算时对每个自定义行 × 字段 × 语言计算一次，发布 `customEffective[locale][presetId][field]`（无文本用 `null`）；getter 与 GUI 都读它。全语言签名变化时触发一次 locale revision，让已挂载界面重渲染。
6. **恢复**：插件卸载时按保存的 descriptor 还原方法；网关若已重装，跳过已不存在的包装。重新安装/重算前先 `ensurePatches()` 检查当前 descriptor 是否仍是自己的包装，不是则重装。

规则引擎需要一次小重构：把「给定 subject（locale、显式 target、original）应用规则」抽成独立函数；字典路径从 key 推导 target，自定义路径直接用 `{preset: row.id, field}`。`when.key` 只匹配字典 subject；自定义行没有字典 key。

### 9.4 规则语义（增量）

- `when.locales`：自定义文本按**当前界面语言**匹配；同样一份文本可在不同语言下显示不同结果。
- `when.presets`：自定义预设的行 id。
- `when.fields`：`name` / `description`；缺省仍是 `description`。
- `when.text`：匹配当前工作文本；原始文本是该行声明的 `name`/`description`（缺省为空串）。
- `when.plugin` / `when.workspace`：与内置一致；自定义文本使其同样可条件化。
- `when.key`：不匹配自定义行。
- 操作、占位符、流水线顺序、`{original}` / `{current}` 全部复用。
- 新增语义：对缺省字段（行没有 `description`）应用 `append` / `prepend` / `rewrite` 时以空串为起点；无任何规则命中时保持"没有该字段"（不是空串），消费者仍走 `noDescription`。

### 9.5 GUI

设置页新增「自定义预设」分组：

- 每个 roster 行一张卡：行 id、原始名称/说明、当前所选语言下的生效文本、「已改写」标记、破损失败标记；
- 复用现有单元格编辑器（`isCellRule` 已按 locale/preset/field 工作）；预览按语言标签所选语言计算，并注明「自定义预设没有内置多语言文本，实际显示跟随当前界面语言」；
- 状态条增加「自定义预设 · 已接管 / 命名空间不可用 / 无自定义预设」与行数；
- 内置预设卡片保持不变；若某个自定义行覆盖了内置 id 且自带名称，两张卡片都编辑同一个 `(locale, preset, field)` 单元，语义一致（规则同时作用于该 id 的两种表示）。

### 9.6 刷新与不一致窗口

| 界面 | 自定义文本何时更新 |
| --- | --- |
| 设置 → Agent 预设 | 行对象直接持有，重渲染即读 getter；规则/条件变化后由 revision bump 刷新 |
| 我们的设置页 | 读生效表，store 更新即刷新 |
| 新任务 hero chip / 标题标签 | `presetOptions` 在 `load()` 时复制；离开设置页返回会话会重新挂载并 load，因此实际操作路径上是新的；停留在同一会话期间条件变化不会自动重载 |
| 插件列表页 | 快照在 tab 装载时取一次；重新打开 tab 时刷新（component 用的是 getter，若 tab 保持挂载，渲染时会重新取值） |

不采用伪造 `connection/reset` 或写别的插件设置来强制刷新——副作用大于收益。README 会明确写出这个窗口。

### 9.7 备选方案与取舍

| 方案 | 结论 |
| --- | --- |
| **A. 客户端 roster 包装（选定）** | 条件完整、改动集中在读路径、可恢复；代价是依赖 Remote 方法的可配置 accessor 形态 |
| B. Host 侧改 roster | 机制最简单，但 Host 不知道客户端当前语言与主视图工作区，只能支持「当前文本 / 插件 / 无条件」子集；与内置预设行为不一致。**不采用** |
| C. 接管 hero/label/settings 槽位 | 等于重写官方 UI，维持原判断（否决） |
| D. 改 `presetDisplayText` / 模块表 | 各 bundle 内联了该纯函数，模块表冻结；不可行 |
| E. 自定义行写入 locale 字典 | 折叠函数只对「无 name 且已知内置 id」用字典，机制上不可行 |
| F. 让 Host 在 roster 里把自定义行伪装成内置/自定义切换 | 会改变分组、默认标记与选择语义；不可接受 |

### 9.8 问题与解决办法

| # | 问题 | 办法 |
| --- | --- | --- |
| 1 | 包装后网关重装方法会丢掉包装 | `ensurePatches()` 在每次重算/事件时检查 descriptor；`ctx.inject` 在命名空间重新可用时重装 |
| 2 | 包装丢失调用方 context | 用原 accessor descriptor 的 getter + 调用的 `this` 生成原调用；data 形态用原函数；若该 `this` 无法提供 `ctx`（非 traceable 调用路径），退回补丁时捕获的原调用，只影响调用方 context 归属，只读端点语义不变 |
| 3 | 两个插件同时包装 | 后装者生效；卸载时只在「当前 descriptor 仍是自己的包装」时恢复；README 记录 |
| 4 | 复制字段的消费者不刷新 | 见 9.6；靠主面板/会话重新挂载；文档写明 |
| 5 | getter 在展开/序列化时被求值 | getter 是可枚举、可配置的纯读取；展开得到当时的值，属预期 |
| 6 | 内置行被误装饰导致分组变化 | 装饰条件严格用 `isBuiltInPreset` 的等价判断：`name !== undefined || !内置 id` |
| 7 | 自定义行没有 name/description | 保持 undefined 直到规则命中；GUI 显示「（无名称）/（无说明）」 |
| 8 | 被覆盖的内置 id 出现两张卡 | 语义一致（同一 cell 的规则同时生效），GUI 注明；不改变官方分组 |
| 9 | 生效表多语言计算成本 | 行数通常个位数，8 语言 × 2 字段 × 规则数，重算触发已防抖 |
| 10 | 包装泄露到其它客户端 | 只在浏览器半、只包装三个只读方法；卸载恢复；不影响 Host |
| 11 | 远程访问控制变化 | 包装始终委派原调用，不提升权限；失败原样返回 `RemoteResult` |
| 12 | 自定义文本的语言语义易混 | GUI/README 明示「按当前界面语言」，并区分预览语言与实际语言 |

### 9.9 实施步骤（下一轮）

1. **引擎重构**：抽出 `applyRulesToSubject(document, subject, context)`；新增 `computePresetText`；字典路径行为不变；补显式 target 的单元测试（含 `when.key` 不匹配、无 description 的行、`{preset}`/`{field}` 占位符）。
2. **Remote 包装层**：descriptor 捕获/安装/恢复/ensure；`agentPresets.list`/`read`、`pluginInventory.list` 三个包装；行/分组装饰器；原始 roster 读取（绕过包装）；生命周期测试用带 accessor 的 fake namespace 验证：外部调用被装饰、getter 随规则变化、原始读取不受影响、卸载恢复、方法重装后自动重包装。
3. **状态与重算**：`customOriginals`、`customEffective`、`customStatus`；重算路径与字典路径解耦（字典缺失时自定义仍可工作）；签名变化触发 revision；GUI 状态与卡片数据。
4. **GUI**：自定义预设卡片、语言提示、状态芯片、编辑器复用；zh/en 文案。
5. **文档与验收**：README 的自定义预设章节、刷新窗口、版本契约（新增「Remote 命名空间方法是可配置 accessor」）；FEASIBILITY 实施记录；版本 0.2.0；`npm run verify`；重启后人工验收。

### 9.10 验收要点

- 一个自定义预设（例如本机安装的第三个插件自带的 preset）在设置页、hero 下拉、标题 `title`、插件列表页显示规则改写后的名称/说明；
- 同一自定义文本在 zh/en 下按 `when.locales` 显示不同结果；
- 当前文本精确/通配/正则匹配、插件条件、工作区条件对自定义文本生效；
- 断开/重载 agent-preset 客户端插件后包装仍生效（或在下一次重算时恢复）；
- 禁用本插件后自定义文本恢复原文，未包装的方法描述符完全还原；
- 内置预设的既有行为不回归（第 8 节的回归全部通过）。

### 9.11 证据索引（本节新增）

| 结论 | 位置 |
| --- | --- |
| 自定义行文本来自 roster | `@deepseek-ai/dsh-agent-preset-registry/src/types.ts`（`AgentPresetRow`） |
| 折叠函数对自定义行的分支 | `@deepseek-ai/dsh-agent-preset-registry/src/display.ts`（`presetDisplayText`、`isBuiltInPreset`） |
| 设置页直接存行 | `@deepseek-ai/dsh-client-ui-agent-preset/src/client/section-store.ts`（`readRoster`） |
| hero/标题复制字段 | `.../src/client/settings-store.ts`（`presetOptions`）、`seat-store.ts`（`load`） |
| 主面板按 key 挂载/切换 | `@deepseek-ai/dsh-client-ui-layout/src/client/AppFrame.tsx`（`renderSlot('main', {}, { entryKey })`） |
| Remote 方法为可配置 accessor | `@deepseek-ai/dsh-api-gateway/src/client/index.ts`（`RemoteNamespaceService.install`/`remove`、`remoteServiceKey`） |
| 插件列表页取名 | `@deepseek-ai/dsh-client-ui-settings-plugin-inventory/src/client/index.ts`（`presetName`）、`PluginInventorySettingsTab.tsx` |
| 命名空间 mount 生命周期 | `@deepseek-ai/dsh-api-gateway/src/client/index.ts`（`installNamespace`、`$mount`） |


### 9.12 实施记录（0.2.0，2026-11-12）

**已交付**

| 区域 | 内容 |
| --- | --- |
| 规则引擎 | `ruleMatches` 改用显式 `subject.target`；新增 `compileRules` / `applyCompiledRules` / `computePresetText`；`computeTexts` 委托同一路径；批量编译一次供多 subject 复用 |
| Remote 包装 | `ensureRemotePatch` 捕获 descriptor、安装可配置 data property、按调用方 `this` 取原 accessor 调用；`ensureRemotePatches` 处理命名空间/方法重装与多写者；`restoreRemotePatches` 卸载还原；`rawNamespaceMethod` 供本插件读取原文 |
| 行装饰 | `isCustomRow` 提到工厂作用域；自定义行浅拷贝 + `name`/`description` live getter；`pluginInventory` 分组只装饰 `name`；`read` 仅对自定义预设生效；内置行不装饰 |
| 状态与重算 | `rosterRows`、`customStatus`、`customEffective`（语言 × 预设 × 字段，缺省字段用 `null`）；签名变化触发 revision；字典路径与自定义路径在同一 `recompute` 中独立发布，字典不可用时自定义仍工作 |
| GUI | 自定义预设分组卡片（原文/生效、破损标记、规则编辑）；状态条「自定义预设」芯片；无字典时语言标签退化为界面语言目录；zh/en 文案与 warn 徽标 |
| 测试 | 引擎新增 12 项（共 75）；生命周期新增 16 项（共 40），其中场景 [6] 用 accessor 形态的 fake 命名空间覆盖包装、live getter、插件列表改名、方法重装补装、卸载还原 |

**实现期的决定**

1. 自定义生效表对**全部界面语言**预计算，getter 与 GUI 各自按活动/所选语言读取；整表签名变化才 bump，避免每帧重渲染。
2. 包装只改显示读路径；本插件自己的 roster/inventory 读取一律绕过包装，保留声明原文。
3. `when.key` 只匹配字典 subject；自定义 subject 没有 key。
4. 自定义文本的规则语言 = 当前界面语言；GUI 的语言标签是**规则预览语言**，与实际显示语言分开说明。
5. 自定义支持不依赖 `settings.agentPreset` 字典；字典缺失时内置状态为 `unsupported`，自定义仍可接管。

**实现期问题与修复**

| 症状 | 根因 | 修法 |
| --- | --- | --- |
| 生命周期断言读取内置行 `name` descriptor 时抛错 | fake roster 的内置行没有 `name` 属性，descriptor 为 undefined | 断言改为 `row.name === undefined`（产品行为正确） |
| 无字典时设置页没有语言标签，自定义单元格无法编辑 | 语言标签只来自字典语言 | `state.locales` 为空时退化为 `localeOptions`（界面语言目录） |
| 方法重装后包装丢失 | Gateway `remove()` 会删除我们的 data property | 每次重算/读取前 `ensureRemotePatches()`；lifecycle 场景 [6] 显式模拟重装并验证补装 |
| `read` 对内置预设误改 | 规则可能命中内置 id 的 read 结果 | `decorateReadResult` 只处理自定义行，内置继续走字典 |
| 包装调用方 context 丢失 | 直接调用捕获的原函数会绑定本插件 context | 包装内用原 accessor descriptor 的 getter + 调用方 `this`；失败退回捕获调用 |

**验证**

- `npm test`：引擎 75 项、生命周期 40 项，全部通过；
- `npm run verify`：全部通过；
- 渲染冒烟：自定义卡片、无字典时的语言目录、unsupported 空状态均能构造完整 React 树；
- **待重启后人工验收**：自定义预设在设置页/hero 下拉/标题 `title`/插件列表页显示改写文本；按语言与条件变化；方法重装后仍生效；禁用插件后恢复原文且 descriptor 还原；内置预设行为不回归。

**遗留风险**

- Gateway 方法形态（可配置 accessor、结果形状）是新的版本契约项；
- hero/标题的复制字段只在 `load()` 时刷新（离开设置页返回会重新挂载）；
- 多个插件同时包装同一方法时后装者生效，卸载只还原自己的包装。
