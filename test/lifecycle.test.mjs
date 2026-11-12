/**
 * Lifecycle harness for the Agent-preset text client half.
 *
 * Run:  node test/lifecycle.test.mjs
 *
 * The real `client.js` runs under stub React / DOM / Cordis surfaces. The
 * browser-only parts (React rendering, the slot renderer) are not exercised;
 * everything the takeover promises is:
 *
 *   - loading reads `ctx.locale.dicts`, captures the shipped copy and writes the
 *     rule result back into the same dictionary objects;
 *   - a configuration write reaches the dictionaries and triggers the locale
 *     revision probe;
 *   - the settings section registers with its identity, order and copy;
 *   - unloading restores the original strings;
 *   - a locale service without `dicts` degrades to `unsupported` instead of
 *     throwing.
 */

// --- stub React -------------------------------------------------------------
const React = {
  Fragment: Symbol.for('react.fragment'),
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: (value) => [typeof value === 'function' ? value() : value, () => {}],
  useMemo: (factory) => factory(),
  useEffect: () => {},
  useRef: (value) => ({ current: value }),
};

// --- stub DOM ---------------------------------------------------------------
globalThis.document = {
  createElement: () => ({ dataset: {}, textContent: '', remove() {} }),
  head: { appendChild() {} },
};

// --- capture the module definition ------------------------------------------
let definition = null;
globalThis.window = {
  __ModuleLoader__: {
    load(module) {
      definition = module;
    },
  },
};

await import(new URL('../client.js', import.meta.url).href);
if (definition === null) throw new Error('client.js did not register a module definition');

const plugin = definition.factory((id) => {
  if (id === 'react') return React;
  throw new Error('unexpected require: ' + id);
});

// --- assertions --------------------------------------------------------------
let failures = 0;
function check(name, condition, detail) {
  if (condition) console.log('  ok   ' + name);
  else {
    failures += 1;
    console.log('  FAIL ' + name + (detail === undefined ? '' : ' — ' + detail));
  }
}

/** Let queued microtasks and the scheduled recompute settle. */
async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

// --- fakes -------------------------------------------------------------------
const SOURCE = 'settings.agentPreset';

/**
 * A locale service with the pieces the plugin reads: the dictionary map, the
 * active snapshot, registration with duplicate refusal, and revision fans-out.
 */
function createLocale(options) {
  const internal = new Map();
  if (options.dictionaries !== null) {
    for (const [namespace, locales] of Object.entries(options.dictionaries)) {
      internal.set(namespace, new Map(Object.entries(locales)));
    }
  }
  const listeners = new Set();
  let revision = 0;
  let active = options.active || 'zh';
  const snapshot = {
    active,
    locales: [{ id: 'zh', label: '中文' }, { id: 'en', label: 'English' }],
    revision: 0,
  };
  function publish() {
    revision += 1;
    snapshot.revision = revision;
    for (const listener of [...listeners]) listener();
  }
  const service = {
    ...(options.dictionaries === null ? {} : { dicts: internal }),
    getLocale() { return snapshot; },
    getSnapshot() { return snapshot; },
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    bind(namespace) {
      return (key) => {
        const locales = internal.get(namespace);
        if (locales === undefined) return key;
        const dictionary = locales.get(snapshot.active);
        return dictionary !== undefined && dictionary[key] !== undefined ? dictionary[key] : key;
      };
    },
    register(namespace, localesOrDict, maybeDict) {
      const pairs = typeof localesOrDict === 'string' ? [[localesOrDict, maybeDict]] : Object.entries(localesOrDict);
      let locales = internal.get(namespace);
      if (locales === undefined) {
        locales = new Map();
        internal.set(namespace, locales);
      }
      for (const [locale] of pairs) {
        if (locales.has(locale)) throw new Error('locale namespace "' + namespace + '" already has locale "' + locale + '"');
      }
      for (const [locale, dictionary] of pairs) locales.set(locale, dictionary);
      publish();
      return () => {
        let removed = false;
        for (const [locale, dictionary] of pairs) {
          if (locales.get(locale) === dictionary) {
            locales.delete(locale);
            removed = true;
          }
        }
        if (removed) publish();
      };
    },
  };
  return { service, internal };
}

/** A config form backed by a mutable section. */
function createConfigForm(documentText) {
  let value = { document: documentText };
  let revision = 0;
  const listeners = new Set();
  return {
    getSnapshot() {
      return { status: 'ready', value, base: undefined, user: value, revision, writable: true };
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    async set(field, next) {
      value = { ...value, [field]: next };
      revision += 1;
      for (const listener of [...listeners]) listener();
      return true;
    },
  };
}

/** A sessions service with one blank main-view session in a known workspace. */
function createSessions() {
  const list = {
    ids: ['session-1'],
    byId: {
      'session-1': {
        id: 'session-1', blank: true, cwd: '/Users/me/Documents/coding-workspace', updatedAt: 1,
      },
    },
  };
  return {
    list: {
      getSnapshot: () => list,
      subscribe: () => () => {},
    },
    retainInfo: () => ({
      getSnapshot: () => ({ retainedBy: { mainView: 1 } }),
      subscribe: () => () => {},
    }),
  };
}

/** One namespace service shaped like the Gateway: configurable accessors. */
function createNamespace(methods) {
  const service = {};
  for (const [name, impl] of Object.entries(methods)) {
    Object.defineProperty(service, name, {
      configurable: true,
      enumerable: true,
      get() {
        return (...args) => impl(...args);
      },
    });
  }
  return service;
}

/** A host context that records registrations and effects. */
function createContext(localeService, form, options = {}) {
  const withRemotes = options.withRemotes !== false;
  const roster = options.roster === undefined ? [{ id: 'standard', isDefault: true }] : options.roster;
  const inventoryGroups = options.inventoryGroups === undefined ? [] : options.inventoryGroups;
  const effects = [];
  const registrations = [];
  const remote = {
    $on: () => () => {},
    ...(withRemotes ? {
      agentPresets: createNamespace({
        list: async () => ({ ok: true, value: { presets: roster } }),
      }),
      pluginInventory: createNamespace({
        list: async () => ({ ok: true, value: { entries: [], agentPresets: inventoryGroups } }),
      }),
    } : {}),
  };
  const ctx = {
    effect(callback, label) {
      effects.push({ label, dispose: callback() });
      return () => {};
    },
    locale: localeService,
    configForms: { get: () => form },
    sessions: createSessions(),
    slots: {
      inject(key, callback) { return callback(); },
      register(options, component) {
        registrations.push({ options, component });
        return () => {};
      },
    },
    get(name) {
      if (name === 'remote.agentPresets') return ctx.remote.agentPresets;
      if (name === 'remote.pluginInventory') return ctx.remote.pluginInventory;
      return undefined;
    },
    inject(dependencies, callback) {
      if (dependencies.every((name) => ctx.get(name) !== undefined)) callback(ctx);
      return () => {};
    },
    remote,
    on: () => () => {},
  };
  return { ctx, effects, registrations, remote };
}

/** Read the plugin state out of the registered settings section. */
function stateOf(registrations) {
  const section = registrations.find((entry) => entry.options.id === 'agent-preset-text');
  if (section === undefined) throw new Error('settings section was not registered');
  return section.options.inject().hooks.agentPresetText.getSnapshot();
}

/** A started document: append a suffix to the Chinese standard description. */
const START_DOCUMENT = JSON.stringify({
  version: 1,
  enabled: true,
  rules: [{
    id: 'cell-zh-standard-description',
    when: { locales: ['zh'], presets: ['standard'], fields: ['description'] },
    then: { op: 'append', text: ' [自定义]' },
  }],
});

console.log('\n[1] takeover');
const dictionaries = {
  [SOURCE]: {
    zh: {
      presetStandardName: '标准模式',
      presetStandardDescription: '处理代码、文件和资料。',
      presetPtcDescription: 'PTC 说明。',
      sectionIntro: '选择 Agent 的工具。',
    },
    en: {
      presetStandardName: 'Standard mode',
      presetStandardDescription: 'Work with code.',
    },
  },
};
const zhDictionary = dictionaries[SOURCE].zh;
const enDictionary = dictionaries[SOURCE].en;
const localeA = createLocale({ dictionaries });
const formA = createConfigForm(START_DOCUMENT);
const contextA = createContext(localeA.service, formA);

plugin.apply(contextA.ctx);
await flush();

const stateA = stateOf(contextA.registrations);
check('mechanism is active', stateA.mechanism === 'active', stateA.mechanism + ' — ' + stateA.detail);
check('the rule count is reported', stateA.rulesCount === 1, String(stateA.rulesCount));
check('the active locale is reported', stateA.activeLocale === 'zh', stateA.activeLocale);
check('the workspace is read from the main-view session',
  stateA.workspace === '/Users/me/Documents/coding-workspace', stateA.workspace);
check('the locale catalogue is published', stateA.localeOptions.length === 2);
check('originals are captured', stateA.originals.zh.presetStandardDescription === '处理代码、文件和资料。');
check('effective text is published', stateA.effective.zh.presetStandardDescription === '处理代码、文件和资料。 [自定义]');
check('the dictionary was rewritten in place',
  zhDictionary.presetStandardDescription === '处理代码、文件和资料。 [自定义]', zhDictionary.presetStandardDescription);
check('the name was left alone by a description rule',
  zhDictionary.presetStandardName === '标准模式', zhDictionary.presetStandardName);
check('other keys and locales are untouched',
  zhDictionary.sectionIntro === '选择 Agent 的工具。' && enDictionary.presetStandardDescription === 'Work with code.',
  zhDictionary.sectionIntro + ' / ' + enDictionary.presetStandardDescription);
check('the settings section registers with its identity and order',
  contextA.registrations.some((entry) => entry.options.id === 'agent-preset-text' && entry.options.order === 21));
check('the section label follows the interface dictionary',
  contextA.registrations.find((entry) => entry.options.id === 'agent-preset-text').options.label() === 'Agent 预设文本');
check('no probe dictionary is left behind',
  (() => {
    const probe = localeA.internal.get('agent-preset-text/probe');
    return probe === undefined || probe.size === 0;
  })());
check('the interface dictionaries were registered',
  localeA.internal.get('settings.agentPresetText')?.get('zh')?.nav === 'Agent 预设文本');

console.log('\n[2] configuration changes');
await formA.set('document', JSON.stringify({
  version: 1,
  rules: [{
    id: 'rewrite',
    when: { locales: ['zh'], presets: ['standard'], fields: ['description'] },
    then: { op: 'rewrite', text: '重写后的说明' },
  }],
}));
await flush();
check('a new document reaches the dictionaries',
  zhDictionary.presetStandardDescription === '重写后的说明', zhDictionary.presetStandardDescription);
check('the previous value is restored when its rule disappears',
  zhDictionary.presetStandardName === '标准模式');

await formA.set('document', JSON.stringify({
  version: 1,
  enabled: false,
  rules: [{
    id: 'rewrite',
    when: { locales: ['zh'], presets: ['standard'], fields: ['description'] },
    then: { op: 'rewrite', text: '重写后的说明' },
  }],
}));
await flush();
check('disabling the document restores the original text',
  zhDictionary.presetStandardDescription === '处理代码、文件和资料。', zhDictionary.presetStandardDescription);

await formA.set('document', '{ broken json');
await flush();
check('an invalid stored document keeps the last usable rules and surfaces the error',
  stateOf(contextA.registrations).parseErrors.length > 0
  && zhDictionary.presetStandardDescription === '处理代码、文件和资料。');

console.log('\n[3] unload restores');
await formA.set('document', START_DOCUMENT);
await flush();
check('the rule applies again after a valid write',
  zhDictionary.presetStandardDescription === '处理代码、文件和资料。 [自定义]');
for (let index = contextA.effects.length - 1; index >= 0; index -= 1) {
  if (typeof contextA.effects[index].dispose === 'function') contextA.effects[index].dispose();
}
await flush();
check('unload restores the original description',
  zhDictionary.presetStandardDescription === '处理代码、文件和资料。', zhDictionary.presetStandardDescription);
check('unload restores every locale',
  enDictionary.presetStandardDescription === 'Work with code.', enDictionary.presetStandardDescription);

console.log('\n[4] unsupported locale service');
const localeB = createLocale({ dictionaries: null });
const formB = createConfigForm('');
const contextB = createContext(localeB.service, formB);
let threw = false;
try {
  plugin.apply(contextB.ctx);
  await flush();
} catch (error) {
  threw = true;
}
check('apply does not throw without locale.dicts', !threw);
check('the section reports unsupported',
  stateOf(contextB.registrations).mechanism === 'unsupported', stateOf(contextB.registrations).mechanism);
check('the section still registers in the unsupported state',
  contextB.registrations.some((entry) => entry.options.id === 'agent-preset-text'));

console.log('\n[5] missing remote namespaces');
const dictionariesC = {
  [SOURCE]: {
    zh: {
      presetStandardName: '标准模式',
      presetStandardDescription: '处理代码、文件和资料。',
    },
    en: { presetStandardDescription: 'Work with code.' },
  },
};
const localeC = createLocale({ dictionaries: dictionariesC });
const formC = createConfigForm(START_DOCUMENT);
const contextC = createContext(localeC.service, formC, { withRemotes: false });
let threwC = false;
try {
  plugin.apply(contextC.ctx);
  await flush();
} catch (error) {
  threwC = true;
  console.log(String(error));
}
check('apply does not throw without the Remote namespaces', !threwC);
check('the dictionary takeover still works without them',
  dictionariesC[SOURCE].zh.presetStandardDescription === '处理代码、文件和资料。 [自定义]',
  dictionariesC[SOURCE].zh.presetStandardDescription);
check('the section still registers without them',
  contextC.registrations.some((entry) => entry.options.id === 'agent-preset-text'));
check('the inventory state degrades to an error rather than a throw',
  stateOf(contextC.registrations).inventoryStatus === 'error', stateOf(contextC.registrations).inventoryStatus);


console.log('\n[6] custom preset takeover');
const customRoster = [
  { id: 'standard', isDefault: true },
  { id: 'team-mode', isDefault: false, name: 'Team mode', description: 'Original custom text' },
];
const customDocument = JSON.stringify({
  version: 1,
  rules: [
    {
      id: 'cell-zh-team-mode-description',
      when: { locales: ['zh'], presets: ['team-mode'], fields: ['description'] },
      then: { op: 'append', text: ' [自定义]' },
    },
    {
      id: 'cell-zh-team-mode-name',
      when: { locales: ['zh'], presets: ['team-mode'], fields: ['name'] },
      then: { op: 'rewrite', text: '团队模式' },
    },
  ],
});
const dictionariesD = {
  [SOURCE]: {
    zh: { presetStandardDescription: '标准说明' },
    en: { presetStandardDescription: 'Standard description' },
  },
};
const localeD = createLocale({ dictionaries: dictionariesD });
const formD = createConfigForm(customDocument);
const contextD = createContext(localeD.service, formD, {
  roster: customRoster,
  inventoryGroups: [
    { id: 'team-mode', name: 'Team mode', isDefault: false },
    { id: 'standard', isDefault: true },
  ],
});
const accessorDescriptor = Object.getOwnPropertyDescriptor(contextD.remote.agentPresets, 'list');
plugin.apply(contextD.ctx);
await flush();

const stateD = stateOf(contextD.registrations);
check('custom status is active', stateD.customStatus === 'active', stateD.customStatus);
check('the raw roster keeps the declared copy',
  stateD.roster.find((row) => row.id === 'team-mode').description === 'Original custom text');
check('the custom effective table is computed per language',
  stateD.customEffective.zh['team-mode'].description === 'Original custom text [自定义]'
  && stateD.customEffective.zh['team-mode'].name === '团队模式'
  && stateD.customEffective.en['team-mode'].description === 'Original custom text'
  && stateD.customEffective.en['team-mode'].name === 'Team mode',
  JSON.stringify(stateD.customEffective));
check('the namespace method is wrapped',
  typeof Object.getOwnPropertyDescriptor(contextD.remote.agentPresets, 'list').value === 'function');

const exposed = await contextD.remote.agentPresets.list();
const exposedRow = exposed.value.presets.find((row) => row.id === 'team-mode');
check('a consumer sees the rewritten name and description',
  exposedRow.name === '团队模式' && exposedRow.description === 'Original custom text [自定义]',
  exposedRow.name + ' / ' + exposedRow.description);
check('built-in rows are left to the dictionary',
  exposed.value.presets.find((row) => row.id === 'standard').name === undefined);

const inventory = await contextD.remote.pluginInventory.list();
const customGroup = inventory.value.agentPresets.find((group) => group.id === 'team-mode');
const builtInGroup = inventory.value.agentPresets.find((group) => group.id === 'standard');
check('the plugin inventory custom name is rewritten', customGroup.name === '团队模式', customGroup.name);
check('the plugin inventory built-in group keeps no name', builtInGroup.name === undefined);

await formD.set('document', JSON.stringify({
  version: 1,
  rules: [{
    id: 'cell-zh-team-mode-description',
    when: { locales: ['zh'], presets: ['team-mode'], fields: ['description'] },
    then: { op: 'rewrite', text: '重写后的自定义说明' },
  }],
}));
await flush();
check('the already-exposed row getter follows the live rules',
  exposedRow.description === '重写后的自定义说明', exposedRow.description);

delete contextD.remote.agentPresets.list;
Object.defineProperty(contextD.remote.agentPresets, 'list', accessorDescriptor);
await formD.set('document', JSON.stringify({
  version: 1,
  rules: [{
    id: 'again',
    when: { locales: ['zh'], presets: ['team-mode'], fields: ['description'] },
    then: { op: 'append', text: ' [again]' },
  }],
}));
await flush();
const exposedAgain = await contextD.remote.agentPresets.list();
check('a re-installed namespace method is wrapped again',
  exposedAgain.value.presets.find((row) => row.id === 'team-mode').description === 'Original custom text [again]',
  exposedAgain.value.presets.find((row) => row.id === 'team-mode').description);

for (let index = contextD.effects.length - 1; index >= 0; index -= 1) {
  if (typeof contextD.effects[index].dispose === 'function') contextD.effects[index].dispose();
}
await flush();
const restored = Object.getOwnPropertyDescriptor(contextD.remote.agentPresets, 'list');
check('unload restores the Gateway accessor', typeof restored.get === 'function' && restored.value === undefined);
const plain = await contextD.remote.agentPresets.list();
check('after unload a consumer sees the declared copy again',
  plain.value.presets.find((row) => row.id === 'team-mode').description === 'Original custom text');

console.log('');
if (failures > 0) {
  console.log(failures + ' check(s) failed.');
  process.exitCode = 1;
} else {
  console.log('all checks passed.');
}
