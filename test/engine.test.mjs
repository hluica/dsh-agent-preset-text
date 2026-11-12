/**
 * Engine harness for the Agent-preset text client half.
 *
 * Run:  node test/engine.test.mjs
 *
 * The dictionary takeover and the settings surface need a browser, so this file
 * exercises the part that does not: the pure rule engine the bundle exposes as
 * `__test`. It loads the real `client.js` under a stub module loader and covers
 * validation, matching, operations, templates, conditions, idempotence and the
 * GUI rule helpers.
 */

// --- stub React (the factory only needs the value; no component is rendered) --
const React = {
  Fragment: Symbol.for('react.fragment'),
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: (value) => [typeof value === 'function' ? value() : value, () => {}],
  useMemo: (factory) => factory(),
  useEffect: () => {},
  useRef: (value) => ({ current: value }),
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

const CLIENT_URL = new URL('../client.js', import.meta.url).href;
await import(CLIENT_URL);

if (definition === null) throw new Error('client.js did not register a module definition');

const plugin = definition.factory((id) => {
  if (id === 'react') return React;
  throw new Error('unexpected require: ' + id);
});

if (plugin.__test === undefined) throw new Error('client.js does not export __test');

const {
  parseDocument,
  normalizeDocument,
  normalizeRule,
  computeTexts,
  computePresetText,
  compileRules,
  globToRegExp,
  renderTemplate,
  applyOperation,
  replaceWith,
  compileMatcher,
  isCellRule,
  draftFromRule,
  ruleFromDraft,
  BUILT_IN_PRESETS,
} = plugin.__test;

// --- assertions --------------------------------------------------------------
let failures = 0;
function check(name, condition, detail) {
  if (condition) console.log('  ok   ' + name);
  else {
    failures += 1;
    console.log('  FAIL ' + name + (detail === undefined ? '' : ' — ' + detail));
  }
}

/** Build an originals map: `{ zh: { key: text }, en: { ... } }`. */
function originalsOf(byLocale) {
  const out = new Map();
  for (const locale of Object.keys(byLocale)) out.set(locale, new Map(Object.entries(byLocale[locale])));
  return out;
}

/** Parse a raw document and fail loudly when the fixture itself is invalid. */
function parsed(raw) {
  const result = parseDocument(JSON.stringify(raw));
  if (!result.ok) throw new Error('fixture document invalid: ' + JSON.stringify(result.errors));
  return result.document;
}

function sameTexts(left, right) {
  if (left.size !== right.size) return false;
  for (const [locale, keys] of left) {
    const other = right.get(locale);
    if (other === undefined || other.size !== keys.size) return false;
    for (const [key, value] of keys) if (other.get(key) !== value) return false;
  }
  return true;
}

console.log('\n[1] factory contract');
check('returns an inject list', Array.isArray(plugin.inject));
check('injects slots, locale, configForms, remote and sessions',
  plugin.inject.join(',') === 'slots,locale,configForms,remote,sessions', plugin.inject.join(','));
check('returns apply', typeof plugin.apply === 'function');
check('exposes the rule engine', typeof computeTexts === 'function' && typeof parseDocument === 'function');
check('knows four shipped presets', BUILT_IN_PRESETS.length === 4);

console.log('\n[2] document validation');
check('empty text is the empty document',
  (() => { const result = parseDocument(''); return result.ok && result.document.rules.length === 0 && result.document.enabled === true; })());
check('invalid JSON is refused',
  (() => { const result = parseDocument('{'); return !result.ok && result.errors.length > 0; })());
check('unknown version is refused',
  (() => { const result = parseDocument(JSON.stringify({ version: 2 })); return !result.ok; })());
check('rules must be an array',
  (() => { const result = parseDocument(JSON.stringify({ version: 1, rules: {} })); return !result.ok; })());
check('a rule without then is refused',
  (() => { const result = parseDocument(JSON.stringify({ version: 1, rules: [{}] })); return !result.ok; })());
check('an unknown operation is refused',
  (() => { const result = parseDocument(JSON.stringify({ version: 1, rules: [{ then: { op: 'explode', text: 'x' } }] })); return !result.ok; })());
check('an invalid regex is refused',
  (() => { const result = parseDocument(JSON.stringify({ version: 1, rules: [{ when: { text: { mode: 'regex', pattern: '(' } }, then: { op: 'append', text: 'x' } }] })); return !result.ok; })());
check('an empty exact pattern is refused',
  (() => { const result = parseDocument(JSON.stringify({ version: 1, rules: [{ when: { text: { mode: 'exact', pattern: '' } }, then: { op: 'append', text: 'x' } }] })); return !result.ok; })());
check('defaults: description field, any preset, any locale',
  (() => {
    const document = parsed({ version: 1, rules: [{ then: { op: 'append', text: 'x' } }] });
    const when = document.rules[0].when;
    return when.fields[0] === 'description' && when.presets[0] === '*' && when.locales[0] === '*';
  })());
check('a key selector drops the description default',
  (() => {
    const document = parsed({ version: 1, rules: [{ when: { key: 'sectionIntro' }, then: { op: 'append', text: 'x' } }] });
    return document.rules[0].when.fields[0] === '*' && document.rules[0].when.key === 'sectionIntro';
  })());
check('normalizeRule reports its own path',
  (() => {
    const errors = [];
    normalizeRule({ when: { text: { mode: 'regex', pattern: '(' } }, then: { op: 'append', text: 'x' } }, 2, errors);
    return errors.length > 0 && errors[0].path.startsWith('rules[2].when.text');
  })());
check('duplicate rule ids are refused',
  (() => {
    const result = parseDocument(JSON.stringify({ version: 1, rules: [
      { id: 'same', then: { op: 'append', text: 'a' } },
      { id: 'same', then: { op: 'append', text: 'b' } },
    ] }));
    return !result.ok && result.errors.some((error) => error.message.includes('id'));
  })());
check('normalizeDocument is idempotent',
  (() => {
    const first = parsed({ version: 1, enabled: false, rules: [{ id: 'a', then: { op: 'rewrite', text: 'x' } }] });
    const second = normalizeDocument(JSON.parse(JSON.stringify(first)));
    return second.ok && JSON.stringify(second.document) === JSON.stringify(first);
  })());

console.log('\n[3] wildcard and template helpers');
check('text glob spans newlines',
  globToRegExp('a*b').test('a\nb'));
check('text glob is anchored',
  !globToRegExp('foo*').test('x foo'));
check('a question mark matches one character',
  globToRegExp('a?c').test('abc') && !globToRegExp('a?c').test('ac'));
check('an escaped star is literal',
  globToRegExp('a\\*b').test('a*b') && !globToRegExp('a\\*b').test('axb'));
check('path star stays inside one segment',
  globToRegExp('/work/*', { pathMode: true }).test('/work/a') && !globToRegExp('/work/*', { pathMode: true }).test('/work/a/b'));
check('path double star crosses segments',
  globToRegExp('/work/**', { pathMode: true }).test('/work/a/b'));
check('a leading double-star may match zero segments',
  globToRegExp('**/coding-workspace', { pathMode: true }).test('coding-workspace')
  && globToRegExp('**/coding-workspace', { pathMode: true }).test('/Users/me/coding-workspace'));
check('templates fill known placeholders',
  renderTemplate('{preset}/{field}/{locale}', { preset: 'standard', field: 'description', locale: 'zh' }) === 'standard/description/zh');
check('templates leave unknown placeholders alone',
  renderTemplate('{nope}', {}) === '{nope}');
check('templates keep doubled braces literal',
  renderTemplate('{{preset}}', { preset: 'x' }) === '{preset}');
check('templates expose the working text',
  renderTemplate('[{current}]', { current: 'a' }) === '[a]');
check('replace uses regex captures',
  replaceWith(compileMatcher({ mode: 'regex', pattern: '(\\d+)' }, false), 'a1b22', '[$1]', 'all') === 'a[1]b[22]');
check('glob replacement inserts dollar signs literally',
  replaceWith(compileMatcher({ mode: 'glob', pattern: 'ba?' }, false), 'bar', 'X$Y', 'all') === 'X$Y');
check('exact replacement respects the first-only count',
  replaceWith(compileMatcher({ mode: 'exact', pattern: 'a' }, false), 'aaa', 'b', 'first') === 'baa');
check('an empty find pattern leaves the text alone',
  replaceWith(compileMatcher({ mode: 'exact', pattern: '' }, false), 'abc', 'x', 'all') === 'abc');
check('prepend and append order the result',
  applyOperation({ op: 'prepend', text: '<' }, null, 'x', {}) === '<x'
  && applyOperation({ op: 'append', text: '>' }, null, 'x', {}) === 'x>');
check('rewrite ignores the current text',
  applyOperation({ op: 'rewrite', text: 'new' }, null, 'old', {}) === 'new');

console.log('\n[4] selection defaults');
const baseOriginals = originalsOf({
  zh: {
    presetStandardName: '标准模式',
    presetStandardDescription: '处理代码、文件和资料。',
    sectionIntro: '选择 Agent 的工具。',
  },
  en: { presetStandardDescription: 'Work with code.' },
});
check('default rules touch the description only',
  (() => {
    const document = parsed({ version: 1, rules: [{ then: { op: 'append', text: '!' } }] });
    const result = computeTexts(document, baseOriginals, {});
    return result.get('zh').get('presetStandardDescription') === '处理代码、文件和资料。!'
      && result.get('zh').get('presetStandardName') === '标准模式'
      && result.get('zh').get('sectionIntro') === '选择 Agent 的工具。';
  })());
check('a locale filter limits the rule',
  (() => {
    const document = parsed({ version: 1, rules: [{ when: { locales: ['en'] }, then: { op: 'append', text: '!' } }] });
    const result = computeTexts(document, baseOriginals, {});
    return result.get('zh').get('presetStandardDescription') === '处理代码、文件和资料。'
      && result.get('en').get('presetStandardDescription') === 'Work with code.!';
  })());
check('a preset filter limits the rule to that preset',
  (() => {
    const document = parsed({ version: 1, rules: [{ when: { presets: ['ptc'] }, then: { op: 'append', text: '!' } }] });
    const result = computeTexts(document, baseOriginals, {});
    return result.get('zh').get('presetStandardDescription') === '处理代码、文件和资料。';
  })());
check('a name filter skips the description',
  (() => {
    const document = parsed({ version: 1, rules: [{ when: { fields: ['name'] }, then: { op: 'append', text: '!' } }] });
    const result = computeTexts(document, baseOriginals, {});
    return result.get('zh').get('presetStandardName') === '标准模式!'
      && result.get('zh').get('presetStandardDescription') === '处理代码、文件和资料。';
  })());
check('a key selector reaches keys outside the preset table',
  (() => {
    const document = parsed({ version: 1, rules: [{ when: { key: 'sectionIntro' }, then: { op: 'rewrite', text: 'overridden' } }] });
    const result = computeTexts(document, baseOriginals, {});
    return result.get('zh').get('sectionIntro') === 'overridden';
  })());
check('an unknown key ignores a preset selector',
  (() => {
    const document = parsed({ version: 1, rules: [{ when: { presets: ['standard'] }, then: { op: 'rewrite', text: 'x' } }] });
    const result = computeTexts(document, baseOriginals, {});
    return result.get('zh').get('sectionIntro') === '选择 Agent 的工具。';
  })());

console.log('\n[5] text conditions and pipeline order');
check('a text condition matches the working text',
  (() => {
    const document = parsed({ version: 1, rules: [
      { id: 'a', when: { text: { mode: 'glob', pattern: '处理*' } }, then: { op: 'append', text: 'X' } },
      { id: 'b', when: { text: { mode: 'exact', pattern: '处理代码、文件和资料。X' } }, then: { op: 'rewrite', text: 'second' } },
    ] });
    const result = computeTexts(document, baseOriginals, {});
    return result.get('zh').get('presetStandardDescription') === 'second'
      && result.get('en').get('presetStandardDescription') === 'Work with code.';
  })());
check('a text condition can skip a rule on the original',
  (() => {
    const document = parsed({ version: 1, rules: [
      { when: { text: { mode: 'regex', pattern: '^无' } }, then: { op: 'append', text: 'X' } },
    ] });
    const result = computeTexts(document, baseOriginals, {});
    return result.get('zh').get('presetStandardDescription') === '处理代码、文件和资料。';
  })());
check('rules compose in document order',
  (() => {
    const document = parsed({ version: 1, rules: [
      { when: { locales: ['zh'] }, then: { op: 'append', text: ' [A]' } },
      { when: { locales: ['zh'] }, then: { op: 'prepend', text: '[B] ' } },
    ] });
    const result = computeTexts(document, baseOriginals, {});
    return result.get('zh').get('presetStandardDescription') === '[B] 处理代码、文件和资料。 [A]';
  })());
check('templates see the original and the current text',
  (() => {
    const document = parsed({ version: 1, rules: [
      { when: { locales: ['en'] }, then: { op: 'rewrite', text: '{original} / {current}' } },
    ] });
    const result = computeTexts(document, baseOriginals, {});
    return result.get('en').get('presetStandardDescription') === 'Work with code. / Work with code.';
  })());
check('disabled documents restore the originals',
  (() => {
    const document = parsed({ version: 1, enabled: false, rules: [{ then: { op: 'rewrite', text: 'x' } }] });
    const result = computeTexts(document, baseOriginals, {});
    return result.get('zh').get('presetStandardDescription') === '处理代码、文件和资料。';
  })());
check('computing twice from the originals is idempotent',
  (() => {
    const document = parsed({ version: 1, rules: [{ then: { op: 'append', text: '!' } }] });
    return sameTexts(computeTexts(document, baseOriginals, {}), computeTexts(document, baseOriginals, {}));
  })());

console.log('\n[6] plugin inventory condition');
const enabledEntry = { entryId: 'dsh-custom-css', moduleName: '@local/dsh-custom-css', enabled: true, fiberPhase: 'active' };
const disabledEntry = { entryId: 'dsh-font-settings', moduleName: '@local/dsh-font-settings', enabled: false, fiberPhase: null };
const inventory = [enabledEntry, disabledEntry];
function pluginDoc(plugin) {
  return parsed({ version: 1, rules: [{ when: { plugins: undefined, plugin }, then: { op: 'append', text: '!' } }] });
}
check('enabled by entry id',
  computeTexts(pluginDoc({ id: 'dsh-custom-css', state: 'enabled' }), baseOriginals, { plugins: inventory }).get('zh').get('presetStandardDescription').endsWith('!'));
check('active requires the active phase',
  computeTexts(pluginDoc({ id: 'dsh-custom-css', state: 'active' }), baseOriginals, { plugins: inventory }).get('zh').get('presetStandardDescription').endsWith('!'));
check('enabled by module name',
  computeTexts(pluginDoc({ id: '@local/dsh-custom-css', state: 'enabled' }), baseOriginals, { plugins: inventory }).get('zh').get('presetStandardDescription').endsWith('!'));
check('a disabled plugin does not satisfy enabled',
  !computeTexts(pluginDoc({ id: 'dsh-font-settings', state: 'enabled' }), baseOriginals, { plugins: inventory }).get('zh').get('presetStandardDescription').endsWith('!'));
check('absent is satisfied by a disabled plugin',
  computeTexts(pluginDoc({ id: 'dsh-font-settings', state: 'absent' }), baseOriginals, { plugins: inventory }).get('zh').get('presetStandardDescription').endsWith('!'));
check('absent fails for an enabled plugin',
  !computeTexts(pluginDoc({ id: 'dsh-custom-css', state: 'absent' }), baseOriginals, { plugins: inventory }).get('zh').get('presetStandardDescription').endsWith('!'));
check('a missing inventory fails an asserted condition',
  !computeTexts(pluginDoc({ id: 'dsh-custom-css', state: 'enabled' }), baseOriginals, {}).get('zh').get('presetStandardDescription').endsWith('!'));

console.log('\n[7] workspace condition');
function workspaceDoc(pattern) {
  return parsed({ version: 1, rules: [{ when: { workspace: pattern }, then: { op: 'append', text: '!' } }] });
}
check('a path glob matches the current workspace',
  computeTexts(workspaceDoc('**/coding-workspace'), baseOriginals, { workspace: '/Users/me/Documents/coding-workspace' }).get('zh').get('presetStandardDescription').endsWith('!'));
check('another workspace does not match',
  !computeTexts(workspaceDoc('**/coding-workspace'), baseOriginals, { workspace: '/Users/me/Documents/other' }).get('zh').get('presetStandardDescription').endsWith('!'));
check('a missing workspace fails the condition',
  !computeTexts(workspaceDoc('**'), baseOriginals, {}).get('zh').get('presetStandardDescription').endsWith('!'));
check('a single star does not cross segments',
  !computeTexts(workspaceDoc('/Users/me/*'), baseOriginals, { workspace: '/Users/me/a/b' }).get('zh').get('presetStandardDescription').endsWith('!'));


console.log('\n[8] custom preset subjects');
function presetDoc(rules) {
  return parsed({ version: 1, rules });
}
const customContext = { plugins: inventory, workspace: '/Users/me/Documents/coding-workspace' };
const customSubject = { locale: 'zh', preset: 'team-mode', field: 'description', original: '原始自定义说明' };
check('a custom description rule applies in the matching locale',
  computePresetText(presetDoc([{
    when: { locales: ['zh'], presets: ['team-mode'], fields: ['description'] },
    then: { op: 'append', text: '!' },
  }]), customSubject, {}) === '原始自定义说明!');
check('the same rule is skipped in another locale',
  computePresetText(presetDoc([{
    when: { locales: ['zh'], presets: ['team-mode'], fields: ['description'] },
    then: { op: 'append', text: '!' },
  }]), { ...customSubject, locale: 'en' }, {}) === '原始自定义说明');
check('a name rule leaves the description alone',
  computePresetText(presetDoc([{
    when: { presets: ['team-mode'], fields: ['name'] },
    then: { op: 'rewrite', text: '团队模式' },
  }]), customSubject, {}) === '原始自定义说明');
check('a missing description stays missing without a rule',
  computePresetText(presetDoc([]), { ...customSubject, original: undefined }, {}) === undefined);
check('a missing description can be created by a rule',
  computePresetText(presetDoc([{
    when: { presets: ['team-mode'], fields: ['description'] },
    then: { op: 'append', text: '新增说明' },
  }]), { ...customSubject, original: undefined }, {}) === '新增说明');
check('a key selector never matches a custom subject',
  computePresetText(presetDoc([{
    when: { key: 'presetStandardDescription' },
    then: { op: 'rewrite', text: 'x' },
  }]), customSubject, {}) === '原始自定义说明');
check('templates see the custom preset and field',
  computePresetText(presetDoc([{
    when: { presets: ['team-mode'], fields: ['description'] },
    then: { op: 'rewrite', text: '{preset}/{field}/{locale}' },
  }]), customSubject, {}) === 'team-mode/description/zh');
check('a text condition matches the custom original',
  computePresetText(presetDoc([{
    when: { presets: ['team-mode'], fields: ['description'], text: { mode: 'glob', pattern: '原始*' } },
    then: { op: 'append', text: '!' },
  }]), customSubject, {}) === '原始自定义说明!'
  && computePresetText(presetDoc([{
    when: { presets: ['team-mode'], fields: ['description'], text: { mode: 'glob', pattern: '别的东西*' } },
    then: { op: 'append', text: '!' },
  }]), customSubject, {}) === '原始自定义说明');
check('custom rules compose in document order',
  computePresetText(presetDoc([
    { when: { presets: ['team-mode'], fields: ['description'] }, then: { op: 'append', text: ' A' } },
    { when: { presets: ['team-mode'], fields: ['description'] }, then: { op: 'prepend', text: 'B ' } },
  ]), customSubject, {}) === 'B 原始自定义说明 A');
check('plugin and workspace conditions apply to custom text',
  computePresetText(presetDoc([{
    when: {
      presets: ['team-mode'],
      fields: ['description'],
      plugin: { id: 'dsh-custom-css', state: 'active' },
      workspace: '**/coding-workspace',
    },
    then: { op: 'append', text: '!' },
  }]), customSubject, customContext) === '原始自定义说明!'
  && computePresetText(presetDoc([{
    when: { presets: ['team-mode'], fields: ['description'], workspace: '**/other' },
    then: { op: 'append', text: '!' },
  }]), customSubject, customContext) === '原始自定义说明');
check('one compilation can serve a batch of custom subjects',
  (() => {
    const document = presetDoc([{
      when: { presets: ['team-mode'], fields: ['description'] },
      then: { op: 'append', text: '!' },
    }]);
    const compiled = compileRules(document);
    return computePresetText(document, customSubject, {}, compiled) === '原始自定义说明!'
      && computePresetText(document, { ...customSubject, locale: 'en' }, {}, compiled) === '原始自定义说明!';
  })());
check('a disabled document leaves custom text alone',
  computePresetText(parsed({ version: 1, enabled: false, rules: [{
    when: { presets: ['team-mode'] },
    then: { op: 'rewrite', text: 'x' },
  }] }), customSubject, {}) === '原始自定义说明');

console.log('\n[9] GUI rule helpers');
const cell = { locale: 'zh', preset: 'standard', field: 'description' };
const draft = {
  op: 'replace', text: '[$1]', findMode: 'regex', findPattern: '(\\d+)', findFlags: '',
  matchMode: 'glob', matchPattern: '处理*', matchFlags: '',
  plugin: 'dsh-custom-css', pluginState: 'active', workspace: '**/coding-workspace',
};
const built = ruleFromDraft(cell, 'rule-x', draft);
check('a cell rule carries exact locale/preset/field selectors',
  isCellRule(built, cell)
  && built.when.locales[0] === 'zh' && built.when.presets[0] === 'standard' && built.when.fields[0] === 'description');
check('a cell rule carries conditions',
  built.when.text.mode === 'glob' && built.when.plugin.id === 'dsh-custom-css'
  && built.when.plugin.state === 'active' && built.when.workspace === '**/coding-workspace');
check('a wildcard rule is not a cell rule',
  !isCellRule(parsed({ version: 1, rules: [{ when: { locales: ['zh'], presets: ['*'], fields: ['description'] }, then: { op: 'append', text: 'x' } }] }).rules[0], cell));
check('draft round-trips through a rule',
  (() => {
    const again = draftFromRule(built);
    return again.op === draft.op && again.text === draft.text
      && again.findMode === draft.findMode && again.findPattern === draft.findPattern
      && again.matchMode === draft.matchMode && again.matchPattern === draft.matchPattern
      && again.plugin === draft.plugin && again.pluginState === draft.pluginState
      && again.workspace === draft.workspace;
  })());
check('a built and normalized cell rule is valid',
  (() => {
    const document = parsed({ version: 1, rules: [built] });
    return document.rules.length === 1 && document.rules[0].id === 'rule-x';
  })());

console.log('');
if (failures > 0) {
  console.log(failures + ' check(s) failed.');
  process.exitCode = 1;
} else {
  console.log('all checks passed.');
}
