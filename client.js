/**
 * Client half of the Agent-preset text bundle.
 *
 * Purpose: take over the *displayed* names and descriptions of Agent presets
 * without touching the presets themselves. DSH 0.2.2 resolves the copy for the
 * shipped presets (`standard`, `ptc`, `minimal`, `cordis`) from the client
 * locale namespace `settings.agentPreset`; custom presets keep the copy their
 * declaration published. This bundle rewrites the shipped dictionaries in
 * place, from a rule document stored in the Host half's volatile config, and
 * restores the original strings when it unloads.
 *
 * Why the dictionaries and not the slots: the settings page, the new-task
 * preset menu, the session-header tooltip and the plugin-list preset switcher
 * all consume that one dictionary through `presetDisplayText`. Rewriting the
 * dictionaries covers every one of them (tooltips and `title` attributes
 * included) without reimplementing shipped UI; replacing the slots would mean
 * copying the whole settings page and hero chip.
 *
 * The dictionary objects belong to the locale service and are stored by
 * reference (`LocaleRuntime.dicts`), so mutating the objects changes what
 * `translate()` returns on the next render. A render is triggered by bumping
 * the locale revision through a public call: registering an empty dictionary
 * under this plugin's own probe namespace and immediately disposing it.
 *
 * Rule document: a versioned JSON object stored as a string in the Host's
 * `document` config field. Its grammar, matching semantics and operations live
 * in the `engine` section below; the GUI is a structural editor for it.
 *
 * Conditions are evaluated globally (the dictionaries are global), from four
 * sources: the active locale, the dictionary's current text, the Host plugin
 * inventory, and the main-view session's working directory. They are ANDed.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-agent-preset-text',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /* ------------------------------------------------------------------ *
     * identity and vocabulary
     * ------------------------------------------------------------------ */

    /** Settings namespace owned by the Host half; equals this bundle's Loader entry id. */
    const SETTINGS_NAMESPACE = 'dsh-agent-preset-text';
    /** Field inside the settings namespace holding the JSON rule document. */
    const CONFIG_FIELD = 'document';
    /** Locale namespace whose preset copy this plugin rewrites. */
    const SOURCE_NAMESPACE = 'settings.agentPreset';
    /** Locale namespace carrying this plugin's own interface copy. */
    const COPY_NAMESPACE = 'settings.agentPresetText';
    /** Namespace used only to bump the locale revision; no consumer binds it. */
    const PROBE_NAMESPACE = 'agent-preset-text/probe';
    /** Settings section identity and position (the shipped Agent-presets section is 20). */
    const SECTION_ID = 'agent-preset-text';
    const SECTION_ORDER = 21;

    /** Only version this bundle understands. */
    const DOCUMENT_VERSION = 1;
    /** Document used when nothing is stored and when the stored document is unusable. */
    const EMPTY_DOCUMENT = Object.freeze({ version: DOCUMENT_VERSION, enabled: true, rules: [] });

    const MATCH_MODES = ['any', 'exact', 'glob', 'regex'];
    const OPERATIONS = ['prepend', 'append', 'replace', 'rewrite'];
    const FIELD_NAMES = ['name', 'description'];
    const PLUGIN_STATES = ['enabled', 'active', 'absent'];

    /** Shipped presets and the dictionary keys their display copy lives under. */
    const BUILT_IN_PRESETS = Object.freeze([
      { id: 'standard', nameKey: 'presetStandardName', descriptionKey: 'presetStandardDescription' },
      { id: 'ptc', nameKey: 'presetPtcName', descriptionKey: 'presetPtcDescription' },
      { id: 'minimal', nameKey: 'presetMinimalName', descriptionKey: 'presetMinimalDescription' },
      { id: 'cordis', nameKey: 'presetCordisName', descriptionKey: 'presetCordisDescription' },
    ]);

    /** Dictionary key to `{ preset, field }`, used by the rule selectors. */
    const KEY_TO_TARGET = new Map();
    for (const preset of BUILT_IN_PRESETS) {
      KEY_TO_TARGET.set(preset.nameKey, { preset: preset.id, field: 'name' });
      KEY_TO_TARGET.set(preset.descriptionKey, { preset: preset.id, field: 'description' });
    }

    /* ------------------------------------------------------------------ *
     * engine: pure JSON-in / text-out
     * ------------------------------------------------------------------ */

    /** @param {unknown} value @returns {value is Record<string, unknown>} */
    function isPlainObject(value) {
      return value !== null && typeof value === 'object' && !Array.isArray(value);
    }

    /** Escape one literal for use inside a RegExp source. */
    function escapeRegExp(text) {
      return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    /**
     * Compile a wildcard pattern.
     * Text mode: `*` spans any characters (newlines included), `?` is one character.
     * Path mode: `*` stays inside one path segment, `**` crosses segments, and
     * `**​/` may match zero segments. `\` escapes the next character.
     * @param {string} pattern
     * @param {{ pathMode?: boolean, anchored?: boolean }} [options]
     * @returns {RegExp}
     */
    function globToRegExp(pattern, options) {
      const settings = options === undefined ? {} : options;
      const pathMode = settings.pathMode === true;
      const anchored = settings.anchored !== false;
      const many = pathMode ? '[^/]*' : '[\\s\\S]*';
      const one = pathMode ? '[^/]' : '[\\s\\S]';
      let source = anchored ? '^' : '';
      for (let index = 0; index < pattern.length; index += 1) {
        const character = pattern[index];
        if (character === '\\' && index + 1 < pattern.length) {
          source += escapeRegExp(pattern[index + 1]);
          index += 1;
        } else if (character === '*') {
          if (pathMode && pattern[index + 1] === '*') {
            index += 1;
            while (pattern[index + 1] === '*') index += 1;
            if (pattern[index + 1] === '/') {
              index += 1;
              source += '(?:.*/)?';
            } else {
              source += '.*';
            }
          } else {
            source += many;
          }
        } else if (character === '?') {
          source += one;
        } else {
          source += escapeRegExp(character);
        }
      }
      if (anchored) source += '$';
      return new RegExp(source);
    }

    /** @param {unknown} value @param {string} path @param {Array<{path: string, message: string}>} errors */
    function normalizeList(value, allowed, path, errors) {
      if (value === undefined) return undefined;
      const list = Array.isArray(value) ? value : [value];
      if (list.length === 0) {
        errors.push({ path, message: '列表不能为空' });
        return undefined;
      }
      const out = [];
      for (const item of list) {
        if (typeof item !== 'string' || item === '') {
          errors.push({ path, message: '必须是字符串' });
          continue;
        }
        if (allowed !== undefined && item !== '*' && !allowed.includes(item)) {
          errors.push({ path, message: '不支持的值：' + item });
          continue;
        }
        if (!out.includes(item)) out.push(item);
      }
      return out;
    }

    /**
     * Validate and normalize one matcher (`when.text` or `then.find`).
     * Absent, or `{ mode: 'any' }`, means "no constraint".
     * @param {unknown} value
     * @param {string} path
     * @param {Array<{path: string, message: string}>} errors
     * @returns {{ mode: 'exact'|'glob'|'regex', pattern: string, flags?: string } | undefined}
     */
    function normalizeMatcher(value, path, errors) {
      if (value === undefined) return undefined;
      if (!isPlainObject(value)) {
        errors.push({ path, message: '必须是对象' });
        return undefined;
      }
      const mode = value.mode === undefined ? 'glob' : value.mode;
      if (!MATCH_MODES.includes(mode)) {
        errors.push({ path: path + '.mode', message: '不支持的模式：' + String(mode) });
        return undefined;
      }
      if (mode === 'any') return undefined;
      if (typeof value.pattern !== 'string') {
        errors.push({ path: path + '.pattern', message: '必须是字符串' });
        return undefined;
      }
      if (mode !== 'regex' && value.pattern === '') {
        errors.push({ path: path + '.pattern', message: '模式不能为空' });
        return undefined;
      }
      const flags = value.flags === undefined ? '' : value.flags;
      if (typeof flags !== 'string') {
        errors.push({ path: path + '.flags', message: '必须是字符串' });
        return undefined;
      }
      if (mode === 'regex') {
        try {
          new RegExp(value.pattern, flags);
        } catch (error) {
          errors.push({ path: path + '.pattern', message: '正则无效：' + (error instanceof Error ? error.message : String(error)) });
          return undefined;
        }
      }
      return flags === '' ? { mode, pattern: value.pattern } : { mode, pattern: value.pattern, flags };
    }

    /**
     * Validate and normalize one rule.
     * @param {unknown} raw
     * @param {number} index
     * @param {Array<{path: string, message: string}>} errors
     * @returns {object | undefined}
     */
    function normalizeRule(raw, index, errors) {
      const base = 'rules[' + index + ']';
      const reportedBefore = errors.length;
      if (!isPlainObject(raw)) {
        errors.push({ path: base, message: '规则必须是对象' });
        return undefined;
      }
      const rawId = raw.id === undefined ? 'rule-' + (index + 1) : raw.id;
      if (typeof rawId !== 'string' || rawId === '') {
        errors.push({ path: base + '.id', message: '必须是非空字符串' });
      }
      let when = raw.when;
      if (when === undefined) when = {};
      else if (!isPlainObject(when)) {
        errors.push({ path: base + '.when', message: '必须是对象' });
        when = {};
      }
      const locales = normalizeList(when.locales, undefined, base + '.when.locales', errors) || ['*'];
      const presets = normalizeList(when.presets, undefined, base + '.when.presets', errors) || ['*'];
      let key;
      if (when.key !== undefined) {
        if (typeof when.key !== 'string' || when.key === '') errors.push({ path: base + '.when.key', message: '必须是非空字符串' });
        else key = when.key;
      }
      const fields = normalizeList(when.fields, FIELD_NAMES, base + '.when.fields', errors)
        || (key === undefined ? ['description'] : ['*']);
      const text = normalizeMatcher(when.text, base + '.when.text', errors);
      let plugin;
      if (when.plugin !== undefined) {
        if (typeof when.plugin === 'string') {
          if (when.plugin === '') errors.push({ path: base + '.when.plugin', message: '必须是非空字符串' });
          else plugin = { id: when.plugin, state: 'enabled' };
        } else if (isPlainObject(when.plugin)) {
          if (typeof when.plugin.id !== 'string' || when.plugin.id === '') {
            errors.push({ path: base + '.when.plugin.id', message: '必须是非空字符串' });
          } else {
            const state = when.plugin.state === undefined ? 'enabled' : when.plugin.state;
            if (!PLUGIN_STATES.includes(state)) errors.push({ path: base + '.when.plugin.state', message: '不支持的状态：' + String(state) });
            else plugin = { id: when.plugin.id, state };
          }
        } else {
          errors.push({ path: base + '.when.plugin', message: '必须是字符串或对象' });
        }
      }
      let workspace;
      if (when.workspace !== undefined) {
        if (typeof when.workspace !== 'string' || when.workspace === '') {
          errors.push({ path: base + '.when.workspace', message: '必须是非空字符串' });
        } else {
          try {
            globToRegExp(when.workspace.replace(/\\/g, '/'), { pathMode: true });
            workspace = when.workspace;
          } catch (error) {
            errors.push({ path: base + '.when.workspace', message: '通配符无效：' + (error instanceof Error ? error.message : String(error)) });
          }
        }
      }
      const then = raw.then;
      if (!isPlainObject(then)) {
        errors.push({ path: base + '.then', message: '必须提供操作对象' });
        return undefined;
      }
      const op = then.op;
      if (!OPERATIONS.includes(op)) errors.push({ path: base + '.then.op', message: '不支持的操作：' + String(op) });
      if (typeof then.text !== 'string') errors.push({ path: base + '.then.text', message: '必须是字符串' });
      const find = normalizeMatcher(then.find, base + '.then.find', errors);
      const count = then.count === undefined ? 'all' : then.count;
      if (count !== 'all' && count !== 'first') errors.push({ path: base + '.then.count', message: '只能是 all 或 first' });

      if (errors.length !== reportedBefore) return undefined;
      return {
        id: rawId,
        when: {
          locales,
          presets,
          fields,
          ...(key === undefined ? {} : { key }),
          ...(text === undefined ? {} : { text }),
          ...(plugin === undefined ? {} : { plugin }),
          ...(workspace === undefined ? {} : { workspace }),
        },
        then: {
          op,
          text: then.text,
          ...(find === undefined ? {} : { find }),
          ...(count === 'all' ? {} : { count }),
        },
      };
    }

    /**
     * Validate a whole document object.
     * @param {unknown} raw
     * @returns {{ ok: boolean, document: object | null, errors: Array<{path: string, message: string}> }}
     */
    function normalizeDocument(raw) {
      const errors = [];
      if (!isPlainObject(raw)) {
        return { ok: false, document: null, errors: [{ path: '$', message: '文档必须是 JSON 对象' }] };
      }
      if (raw.version !== DOCUMENT_VERSION) {
        return {
          ok: false,
          document: null,
          errors: [{ path: '$.version', message: '不支持的文档版本：' + String(raw.version) + '（当前为 ' + DOCUMENT_VERSION + '）' }],
        };
      }
      let enabled = true;
      if (raw.enabled !== undefined) {
        if (typeof raw.enabled !== 'boolean') errors.push({ path: '$.enabled', message: '必须是布尔值' });
        else enabled = raw.enabled;
      }
      const rules = [];
      if (raw.rules !== undefined) {
        if (!Array.isArray(raw.rules)) errors.push({ path: '$.rules', message: '必须是数组' });
        else {
          raw.rules.forEach((rule, index) => {
            const normalized = normalizeRule(rule, index, errors);
            if (normalized !== undefined) rules.push(normalized);
          });
        }
      }
      const seenIds = new Set();
      rules.forEach((rule, index) => {
        if (seenIds.has(rule.id)) errors.push({ path: 'rules[' + index + '].id', message: '规则 id 重复：' + rule.id });
        else seenIds.add(rule.id);
      });
      if (errors.length > 0) return { ok: false, document: null, errors };
      return { ok: true, document: { version: DOCUMENT_VERSION, enabled, rules }, errors: [] };
    }

    /**
     * Parse the stored document text. Empty text is the empty document.
     * @param {unknown} text
     * @returns {{ ok: boolean, document: object | null, errors: Array<{path: string, message: string}> }}
     */
    function parseDocument(text) {
      if (typeof text !== 'string' || text.trim() === '') return { ok: true, document: EMPTY_DOCUMENT, errors: [] };
      let raw;
      try {
        raw = JSON.parse(text);
      } catch (error) {
        return {
          ok: false,
          document: null,
          errors: [{ path: '$', message: 'JSON 解析失败：' + (error instanceof Error ? error.message : String(error)) }],
        };
      }
      return normalizeDocument(raw);
    }

    /**
     * Fill `{name}` placeholders; `{{` and `}}` are literal braces.
     * @param {string} text
     * @param {Record<string, unknown>} variables
     * @returns {string}
     */
    function renderTemplate(text, variables) {
      const OPEN = '\u0000OPEN\u0000';
      const CLOSE = '\u0000CLOSE\u0000';
      return text
        .split('{{').join(OPEN)
        .split('}}').join(CLOSE)
        .replace(/\{(\w+)\}/g, (match, name) => (
          Object.prototype.hasOwnProperty.call(variables, name) ? String(variables[name]) : match
        ))
        .split(OPEN).join('{')
        .split(CLOSE).join('}');
    }

    /**
     * Compile one normalized matcher for matching or for replacement.
     * @param {{ mode: 'exact'|'glob'|'regex', pattern: string, flags?: string } | undefined} spec
     * @param {boolean} anchored - match the whole text (true) or find a substring (false)
     * @returns {{ mode: string, pattern: string, flags?: string, regex?: RegExp } | null}
     */
    function compileMatcher(spec, anchored) {
      if (spec === undefined || spec === null) return null;
      if (spec.mode === 'exact') return { mode: 'exact', pattern: spec.pattern };
      if (spec.mode === 'regex') {
        return { mode: 'regex', pattern: spec.pattern, flags: spec.flags || '', regex: new RegExp(spec.pattern, spec.flags || '') };
      }
      return { mode: 'glob', pattern: spec.pattern, regex: globToRegExp(spec.pattern, { anchored }) };
    }

    /** Test one compiled matcher. */
    function matchesText(matcher, value) {
      if (matcher === null) return true;
      if (matcher.mode === 'exact') return value === matcher.pattern;
      matcher.regex.lastIndex = 0;
      return matcher.regex.test(value);
    }

    /** Escape `$` so a non-regex replacement inserts literally. */
    function literalReplacement(text) {
      return text.replace(/\$/g, '$$$$');
    }

    /**
     * Replace the portion selected by `find` with `replacement`.
     * Regex replacements keep `$1` / `$&` semantics; glob and exact replacements are literal.
     */
    function replaceWith(matcher, value, replacement, count) {
      if (matcher === null) return replacement;
      // An empty pattern would splice the replacement between every character.
      if (matcher.pattern === '') return value;
      if (matcher.mode === 'exact') {
        if (count === 'first') return value.replace(matcher.pattern, replacement);
        return value.split(matcher.pattern).join(replacement);
      }
      const flags = matcher.mode === 'regex' ? (matcher.flags || '') : '';
      const globalFlags = count === 'first' ? flags.replace(/g/g, '') : (flags.includes('g') ? flags : flags + 'g');
      const expression = new RegExp(matcher.regex.source, globalFlags);
      const output = matcher.mode === 'regex' ? replacement : literalReplacement(replacement);
      return value.replace(expression, output);
    }

    /**
     * Apply one rule operation.
     * @param {{ op: string, text: string, count?: string }} then
     * @param {{ mode: string, pattern: string, flags?: string, regex?: RegExp } | null} findMatcher
     * @param {string} current
     * @param {Record<string, unknown>} variables
     * @returns {string}
     */
    function applyOperation(then, findMatcher, current, variables) {
      const rendered = renderTemplate(then.text, { ...variables, current });
      switch (then.op) {
        case 'prepend': return rendered + current;
        case 'append': return current + rendered;
        case 'rewrite': return rendered;
        case 'replace': return replaceWith(findMatcher, current, rendered, then.count === 'first' ? 'first' : 'all');
        default: return current;
      }
    }

    /** One selector list against one value. */
    function listMatches(list, value) {
      return list === undefined || list.includes('*') || list.includes(value);
    }

    /** Plugin-inventory condition. A missing inventory makes an asserted condition false. */
    function pluginConditionMatches(condition, plugins) {
      if (condition === undefined) return true;
      if (!Array.isArray(plugins)) return false;
      const same = (entry) => entry !== null && typeof entry === 'object'
        && (entry.entryId === condition.id || entry.moduleName === condition.id);
      if (condition.state === 'absent') return !plugins.some((entry) => same(entry) && entry.enabled === true);
      return plugins.some((entry) => same(entry) && entry.enabled === true
        && (condition.state !== 'active' || entry.fiberPhase === 'active'));
    }

    /** Workspace path glob. A missing workspace makes an asserted condition false. */
    function workspaceConditionMatches(pattern, workspace) {
      if (pattern === undefined) return true;
      if (typeof workspace !== 'string' || workspace === '') return false;
      return globToRegExp(pattern.replace(/\\/g, '/'), { pathMode: true }).test(workspace.replace(/\\/g, '/'));
    }

    /** Every condition of one compiled rule against one subject. */
    function ruleMatches(compiled, subject, context) {
      const when = compiled.rule.when;
      if (when.key !== undefined && when.key !== subject.key) return false;
      if (!listMatches(when.locales, subject.locale)) return false;
      const target = subject.target;
      if (when.presets !== undefined && !when.presets.includes('*')
        && (target === undefined || !when.presets.includes(target.preset))) return false;
      if (when.fields !== undefined && !when.fields.includes('*')
        && (target === undefined || !when.fields.includes(target.field))) return false;
      if (when.text !== undefined && !matchesText(compiled.text, subject.current)) return false;
      if (!pluginConditionMatches(when.plugin, context.plugins)) return false;
      if (!workspaceConditionMatches(when.workspace, context.workspace)) return false;
      return true;
    }

    /**
     * Compile one document's rules once, for any number of subjects.
     * @param {object} document - normalized document
     * @returns {Array<{ rule: object, text: object | null, find: object | null }>}
     */
    function compileRules(document) {
      const doc = document === null || document === undefined ? EMPTY_DOCUMENT : document;
      if (doc.enabled === false) return [];
      return doc.rules.map((rule) => ({
        rule,
        text: compileMatcher(rule.when.text, true),
        find: rule.then.op === 'replace' ? compileMatcher(rule.then.find, false) : null,
      }));
    }

    /**
     * Apply compiled rules to one subject in document order.
     * @param {Array<{ rule: object, text: object | null, find: object | null }>} rules
     * @param {{ locale: string, key?: string, target?: { preset: string, field: string }, original: string }} subject
     * @param {{ plugins?: unknown[], workspace?: string }} context
     * @returns {{ value: string, matched: boolean }}
     */
    function applyCompiledRules(rules, subject, context) {
      let current = subject.original;
      let matched = false;
      for (const compiled of rules) {
        if (!ruleMatches(compiled, { ...subject, current }, context)) continue;
        const target = subject.target;
        current = applyOperation(compiled.rule.then, compiled.find, current, {
          locale: subject.locale,
          key: subject.key === undefined ? '' : subject.key,
          preset: target === undefined ? '' : target.preset,
          field: target === undefined ? '' : target.field,
          original: subject.original,
        });
        matched = true;
      }
      return { value: current, matched };
    }

    /**
     * Compute the effective text for every `(locale, key)` in `originals`.
     * Rules run in document order against the working text, so a later rule
     * sees the previous rule's output; `{original}` always names the snapshot.
     * @param {object} document - normalized document
     * @param {Map<string, Map<string, string>>} originals
     * @param {{ plugins?: unknown[], workspace?: string }} context
     * @returns {Map<string, Map<string, string>>}
     */
    function computeTexts(document, originals, context) {
      const result = new Map();
      const rules = compileRules(document);
      for (const [locale, keys] of originals) {
        const localeResult = new Map();
        for (const [key, original] of keys) {
          const applied = applyCompiledRules(rules, {
            locale,
            key,
            target: KEY_TO_TARGET.get(key),
            original,
          }, context);
          localeResult.set(key, applied.value);
        }
        result.set(locale, localeResult);
      }
      return result;
    }

    /**
     * Compute one custom-preset field, outside the dictionary path.
     *
     * Custom preset text has no locale of its own; `locale` selects the rule
     * locale (the active interface language at display time). A missing
     * original stays missing until a rule produces text.
     * @param {object} document - normalized document
     * @param {{ locale: string, preset: string, field: string, original?: string }} subject
     * @param {{ plugins?: unknown[], workspace?: string }} context
     * @param {Array} [compiledRules] - reuse one compilation across a batch
     * @returns {string | undefined} undefined when the field does not exist and no rule produces one
     */
    function computePresetText(document, subject, context, compiledRules) {
      const hasOriginal = typeof subject.original === 'string';
      const rules = compiledRules === undefined ? compileRules(document) : compiledRules;
      const applied = applyCompiledRules(rules, {
        locale: subject.locale,
        target: { preset: subject.preset, field: subject.field },
        original: hasOriginal ? subject.original : '',
      }, context);
      if (!applied.matched && !hasOriginal) return undefined;
      return applied.value;
    }

    /** Clone a normalized document (plain JSON) before a structural edit. */
    function cloneDocument(document) {
      return JSON.parse(JSON.stringify(document));
    }

    /** True when a rule targets exactly one cell the GUI owns. */
    function isCellRule(rule, cell) {
      const when = rule.when;
      return when !== undefined
        && when.key === undefined
        && Array.isArray(when.locales) && when.locales.length === 1 && when.locales[0] === cell.locale
        && Array.isArray(when.presets) && when.presets.length === 1 && when.presets[0] === cell.preset
        && Array.isArray(when.fields) && when.fields.length === 1 && when.fields[0] === cell.field;
    }

    /** GUI draft for an existing rule. */
    function draftFromRule(rule) {
      const when = rule.when;
      const find = rule.then.find;
      return {
        op: rule.then.op,
        text: rule.then.text,
        findMode: find === undefined ? 'glob' : find.mode,
        findPattern: find === undefined ? '' : find.pattern,
        findFlags: find === undefined || find.flags === undefined ? '' : find.flags,
        matchMode: when.text === undefined ? 'any' : when.text.mode,
        matchPattern: when.text === undefined ? '' : when.text.pattern,
        matchFlags: when.text === undefined || when.text.flags === undefined ? '' : when.text.flags,
        plugin: when.plugin === undefined ? '' : when.plugin.id,
        pluginState: when.plugin === undefined ? 'enabled' : when.plugin.state,
        workspace: when.workspace === undefined ? '' : when.workspace,
      };
    }

    /** The empty GUI draft. */
    const EMPTY_DRAFT = Object.freeze({
      op: 'append', text: '',
      findMode: 'glob', findPattern: '', findFlags: '',
      matchMode: 'any', matchPattern: '', matchFlags: '',
      plugin: '', pluginState: 'enabled', workspace: '',
    });

    /** Build a rule for one cell from a GUI draft. */
    function ruleFromDraft(cell, id, draft) {
      const when = {
        locales: [cell.locale],
        presets: [cell.preset],
        fields: [cell.field],
      };
      if (draft.matchMode !== 'any') {
        when.text = {
          mode: draft.matchMode,
          pattern: draft.matchPattern,
          ...(draft.matchFlags === '' ? {} : { flags: draft.matchFlags }),
        };
      }
      if (draft.plugin.trim() !== '') when.plugin = { id: draft.plugin.trim(), state: draft.pluginState };
      if (draft.workspace.trim() !== '') when.workspace = draft.workspace.trim();
      const then = { op: draft.op, text: draft.text };
      if (draft.op === 'replace') {
        then.find = {
          mode: draft.findMode,
          pattern: draft.findPattern,
          ...(draft.findFlags === '' ? {} : { flags: draft.findFlags }),
        };
      }
      return { id, when, then };
    }

    /* ------------------------------------------------------------------ *
     * interface copy
     * ------------------------------------------------------------------ */

    const zh = {
      nav: 'Agent 预设文本',
      intro: '在显示层替换内置 Agent 预设的名称与说明。预设本身不被修改：禁用本插件后，界面立即恢复原文。',
      mechActive: '已接管',
      mechWaiting: '等待 Agent 预设插件',
      mechUnsupported: '不可用',
      waitingDetail: '尚未找到 settings.agentPreset 字典；Agent 预设插件加载后会自动接管。',
      unsupportedDetail: '当前 DSH 的 locale 服务没有暴露可覆写的字典对象。请按 README 的版本契约核对 DSH 版本。',
      statusLocale: '当前语言',
      statusRules: '规则',
      statusWorkspace: '当前工作区',
      statusNoWorkspace: '无（主视图没有会话）',
      statusInventory: '插件清单',
      inventoryReady: '可用',
      inventoryLoading: '读取中',
      inventoryError: '不可用',
      inventoryRefresh: '刷新插件清单',
      statusConflicts: '被外部改写',
      writeFailed: 'Host 拒绝了这次写入。',
      parseFailed: '已保存的配置无法解析，界面继续使用上一份可用规则：',
      localeLabel: '语言',
      presetGroup: '内置预设',
      customGroup: '自定义预设',
      customNote: '自定义预设的名称与说明同样可被规则接管；它们没有随语言变化的原生文本，规则按当前界面语言选择，表格按所选语言预览。',
      customEmpty: '当前没有自定义预设。',
      customLanguageHint: '自定义预设没有内置多语言文本：实际显示跟随当前界面语言，这里按上面所选语言预览规则结果。',
      statusCustom: '自定义预设',
      customActive: '已接管',
      customUnavailable: '命名空间不可用',
      customError: '读取失败',
      fieldName: '名称',
      fieldDescription: '说明',
      originalLabel: '原文',
      effectiveLabel: '生效',
      editedBadge: '已改写',
      editRules: '编辑规则',
      cellTitle: '编辑规则',
      closeEditor: '收起',
      cellRulesTitle: '该字符串的规则',
      noCellRules: '还没有规则。',
      advancedRulesNote: '这里只显示目标语言、预设、字段都精确等于本单元格的规则；通配、按 key 或组合条件的规则请在原始文档中管理。',
      addRule: '添加规则',
      editRule: '编辑',
      saveRule: '保存规则',
      cancel: '取消',
      deleteRule: '删除',
      confirmDelete: '确认删除',
      moveUp: '上移',
      moveDown: '下移',
      opLabel: '操作',
      opPrepend: '首部附加',
      opAppend: '尾部附加',
      opReplace: '替换匹配',
      opRewrite: '整体重写',
      textLabel: '文本',
      textHint: '可用占位符：{preset} {field} {locale} {original} {current}；{{ 与 }} 表示字面花括号。',
      findLabel: '查找',
      findHint: '查找要替换的片段；正则模式支持 $1、$&。',
      findRequired: '替换操作需要填写查找模式。',
      patternLabel: '模式',
      flagsLabel: '标志',
      matchLabel: '匹配当前文本',
      matchAny: '不限制',
      matchExact: '精确',
      matchGlob: '通配',
      matchRegex: '正则',
      pluginLabel: '要求插件',
      pluginHint: '插件 entry id 或模块名；留空表示不限制。',
      pluginStateLabel: '状态',
      pluginEnabled: '已启用',
      pluginActive: '已激活',
      pluginAbsent: '未启用',
      workspaceLabel: '要求工作区',
      workspaceHint: '对主视图会话的工作目录做通配匹配；** 跨目录，* 段内。留空表示不限制。',
      conditionsTitle: '附加条件',
      rawTitle: '原始文档',
      rawHint: '整份规则文档的 JSON。保存前会校验结构与正则；无法解析的已存配置不会生效。',
      rawSave: '保存文档',
      rawFormat: '格式化',
      rawRevert: '恢复为已保存',
      rawErrors: '校验错误',
      rawPlaceholder: '{\n  "version": 1,\n  "enabled": true,\n  "rules": []\n}',
      rawEmpty: '（空文档）',
      saved: '已保存。',
      saving: '正在保存…',
      saveFailed: '保存失败。',
      notWritable: '当前配置不可写，无法保存。',
      documentDisabled: '文档已停用（enabled: false），所有规则暂不生效。',
      rulesCount: '{n} 条规则',
      ruleTextEmpty: '（空文本）',
      noWorkspace: '未限定',
      loading: '加载中…',
      emptyDocument: '空文档',
      customBroken: '加载失败',
    };

    const en = {
      nav: 'Agent preset text',
      intro: 'Replaces the displayed names and descriptions of the shipped Agent presets. The presets themselves are not modified: disabling this plugin restores the original text immediately.',
      mechActive: 'Active',
      mechWaiting: 'Waiting for the Agent-preset plugin',
      mechUnsupported: 'Unavailable',
      waitingDetail: 'The settings.agentPreset dictionaries are not registered yet; this plugin takes over as soon as the Agent-preset plugin loads.',
      unsupportedDetail: 'The running DSH locale service does not expose the dictionary objects this plugin rewrites. Check the version contract in the README.',
      statusLocale: 'Language',
      statusRules: 'Rules',
      statusWorkspace: 'Workspace',
      statusNoWorkspace: 'none (no session in the main view)',
      statusInventory: 'Plugin inventory',
      inventoryReady: 'available',
      inventoryLoading: 'loading',
      inventoryError: 'unavailable',
      inventoryRefresh: 'Refresh plugin inventory',
      statusConflicts: 'externally rewritten',
      writeFailed: 'The Host rejected the write.',
      parseFailed: 'The stored configuration cannot be parsed; the last usable rules remain in effect:',
      localeLabel: 'Language',
      presetGroup: 'Built-in presets',
      customGroup: 'Custom presets',
      customNote: 'Custom preset names and descriptions are taken over too. They have no built-in localized copy, so rules select by the active interface language and this table previews the selected language.',
      customEmpty: 'No custom presets.',
      customLanguageHint: 'Custom presets have no built-in localized text: the live display follows the active interface language, while this table previews the selected language.',
      statusCustom: 'Custom presets',
      customActive: 'Active',
      customUnavailable: 'Namespace unavailable',
      customError: 'Read failed',
      fieldName: 'Name',
      fieldDescription: 'Description',
      originalLabel: 'Original',
      effectiveLabel: 'Effective',
      editedBadge: 'Rewritten',
      editRules: 'Edit rules',
      cellTitle: 'Edit rules',
      closeEditor: 'Close',
      cellRulesTitle: 'Rules for this string',
      noCellRules: 'No rules yet.',
      advancedRulesNote: 'Only rules whose target language, preset and field exactly match this cell are listed here. Manage wildcard, key-based or combined rules in the raw document.',
      addRule: 'Add rule',
      editRule: 'Edit',
      saveRule: 'Save rule',
      cancel: 'Cancel',
      deleteRule: 'Delete',
      confirmDelete: 'Confirm delete',
      moveUp: 'Move up',
      moveDown: 'Move down',
      opLabel: 'Operation',
      opPrepend: 'Prepend',
      opAppend: 'Append',
      opReplace: 'Replace match',
      opRewrite: 'Rewrite',
      textLabel: 'Text',
      textHint: 'Placeholders: {preset} {field} {locale} {original} {current}; {{ and }} are literal braces.',
      findLabel: 'Find',
      findHint: 'The fragment to replace; regex mode supports $1 and $&.',
      findRequired: 'Replace requires a find pattern.',
      patternLabel: 'Pattern',
      flagsLabel: 'Flags',
      matchLabel: 'Match current text',
      matchAny: 'Any',
      matchExact: 'Exact',
      matchGlob: 'Glob',
      matchRegex: 'Regex',
      pluginLabel: 'Require plugin',
      pluginHint: 'Plugin entry id or module name; empty means no constraint.',
      pluginStateLabel: 'State',
      pluginEnabled: 'Enabled',
      pluginActive: 'Active',
      pluginAbsent: 'Not enabled',
      workspaceLabel: 'Require workspace',
      workspaceHint: 'Glob against the main-view session working directory; ** crosses directories, * stays in a segment. Empty means no constraint.',
      conditionsTitle: 'Conditions',
      rawTitle: 'Raw document',
      rawHint: 'The complete rule document as JSON. Structure and regular expressions are validated before saving; an unparsable stored configuration stays inactive.',
      rawSave: 'Save document',
      rawFormat: 'Format',
      rawRevert: 'Revert to saved',
      rawErrors: 'Validation errors',
      rawPlaceholder: '{\n  "version": 1,\n  "enabled": true,\n  "rules": []\n}',
      rawEmpty: '(empty document)',
      saved: 'Saved.',
      saving: 'Saving…',
      saveFailed: 'Saving failed.',
      notWritable: 'The current configuration is not writable.',
      documentDisabled: 'The document is disabled (enabled: false); no rules apply.',
      rulesCount: '{n} rules',
      ruleTextEmpty: '(empty text)',
      noWorkspace: 'unconstrained',
      loading: 'Loading…',
      emptyDocument: 'Empty document',
      customBroken: 'Failed to load',
    };

    /* ------------------------------------------------------------------ *
     * styles
     * ------------------------------------------------------------------ */

    const STYLE = `
.dapt-section{display:flex;flex-direction:column;gap:16px;max-width:780px;color:var(--dsw-alias-label-primary)}
.dapt-title{margin:0;font-size:18px;font-weight:600}
.dapt-intro{margin:0;font-size:13px;color:var(--dsw-alias-label-tertiary);line-height:1.6}
.dapt-status{display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;font-size:13px}
.dapt-dot{width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-state-idle-primary);flex:0 0 auto}
.dapt-status--active .dapt-dot{background:var(--dsw-alias-state-success-primary)}
.dapt-status--waiting .dapt-dot{background:var(--dsw-alias-state-warn-primary)}
.dapt-status--unsupported .dapt-dot{background:var(--dsw-alias-state-error-primary)}
.dapt-meta{color:var(--dsw-alias-label-tertiary);font-size:12px}
.dapt-detail{margin:0;font-size:12px;color:var(--dsw-alias-label-tertiary);line-height:1.6;overflow-wrap:anywhere}
.dapt-tabs{display:flex;flex-wrap:wrap;gap:6px}
.dapt-tab{appearance:none;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;padding:4px 10px;border-radius:999px;cursor:pointer}
.dapt-tab[aria-selected="true"]{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2)}
.dapt-group{display:flex;flex-direction:column;gap:10px}
.dapt-groupHead{margin:0;font-size:12px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--dsw-alias-label-tertiary)}
.dapt-cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:12px}
.dapt-card{border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-1);padding:12px 14px;display:flex;flex-direction:column;gap:10px}
.dapt-cardHead{display:flex;align-items:baseline;gap:8px;justify-content:space-between}
.dapt-cardName{font-size:14px;font-weight:600;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dapt-cardId{font-size:11px;color:var(--dsw-alias-label-tertiary);flex:0 0 auto}
.dapt-fieldRow{display:flex;flex-direction:column;gap:6px;padding-top:8px;border-top:1px solid var(--dsw-alias-border-l1)}
.dapt-fieldHead{display:flex;align-items:center;gap:8px}
.dapt-fieldLabel{font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary)}
.dapt-badge{font-size:11px;line-height:17px;padding:0 7px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);border:1px solid var(--dsw-alias-border-l2);white-space:nowrap}
.dapt-badge--accent{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.dapt-badge--warn{border-color:var(--dsw-alias-state-warn-primary);color:var(--dsw-alias-state-warn-primary)}
.dapt-link{appearance:none;border:0;background:none;color:var(--dsw-alias-brand-primary);font:inherit;font-size:12px;padding:0;cursor:pointer;margin-left:auto}
.dapt-link:hover{text-decoration:underline}
.dapt-textPair{display:flex;flex-direction:column;gap:6px}
.dapt-text{display:flex;gap:8px;font-size:12px;line-height:1.55}
.dapt-textLabel{flex:0 0 42px;color:var(--dsw-alias-label-tertiary)}
.dapt-textBody{flex:1;min-width:0;white-space:pre-wrap;overflow-wrap:anywhere;color:var(--dsw-alias-label-secondary)}
.dapt-textBody--effective{color:var(--dsw-alias-label-primary)}
.dapt-editor{border:1px solid var(--dsw-alias-brand-primary);border-radius:12px;padding:14px;display:flex;flex-direction:column;gap:12px;background:var(--dsw-alias-bg-layer-1)}
.dapt-editorHead{display:flex;align-items:flex-start;gap:8px}
.dapt-editorTitle{margin:0;font-size:14px;font-weight:600;line-height:1.5}
.dapt-subHead{margin:0;font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary)}
.dapt-muted{margin:0;font-size:12px;color:var(--dsw-alias-label-tertiary);line-height:1.6}
.dapt-ruleList{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px}
.dapt-rule{display:flex;align-items:center;gap:8px;padding:6px 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;font-size:12px}
.dapt-ruleMain{flex:1;min-width:0;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dapt-ruleText{color:var(--dsw-alias-label-secondary);white-space:pre-wrap;overflow-wrap:anywhere;max-height:3.2em;overflow:hidden}
.dapt-ruleActions{display:flex;gap:6px;flex:0 0 auto;flex-wrap:wrap}
.dapt-button{appearance:none;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;padding:5px 12px;border-radius:8px;cursor:pointer}
.dapt-button:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2)}
.dapt-button:disabled{opacity:.5;cursor:default}
.dapt-button--primary{border-color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-brand-primary);color:#fff}
.dapt-button--danger{color:var(--dsw-alias-state-error-primary)}
.dapt-form{display:flex;flex-direction:column;gap:8px}
.dapt-label{display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--dsw-alias-label-secondary)}
.dapt-hint{font-size:11px;color:var(--dsw-alias-label-tertiary);line-height:1.5}
.dapt-row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.dapt-input,.dapt-select,.dapt-textarea{font:inherit;font-size:12px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:6px 8px;min-width:0}
.dapt-input{flex:1;min-width:140px}
.dapt-textarea{min-height:72px;resize:vertical;line-height:1.5}
.dapt-textarea--raw{min-height:220px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}
.dapt-errors{margin:0;padding:8px 10px;border:1px solid var(--dsw-alias-state-error-primary);border-radius:8px;font-size:12px;color:var(--dsw-alias-state-error-primary);display:flex;flex-direction:column;gap:4px}
.dapt-errorList{margin:0;padding-left:18px;font-size:12px;line-height:1.5}
.dapt-notice{font-size:12px;color:var(--dsw-alias-label-secondary);margin:0}
.dapt-notice--error{color:var(--dsw-alias-state-error-primary)}
.dapt-actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.dapt-raw{display:flex;flex-direction:column;gap:8px;border-top:1px solid var(--dsw-alias-border-l2);padding-top:12px}
.dapt-customList{margin:0;padding-left:18px;font-size:12px;color:var(--dsw-alias-label-tertiary);line-height:1.6}
.dapt-button:focus-visible,.dapt-tab:focus-visible,.dapt-link:focus-visible,.dapt-input:focus-visible,.dapt-select:focus-visible,.dapt-textarea:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
`;

    /* ------------------------------------------------------------------ *
     * GUI component
     * ------------------------------------------------------------------ */

    /** Stable names for the two shipped dictionary keys per preset. */
    const BUILT_IN_IDS = new Set(BUILT_IN_PRESETS.map((preset) => preset.id));

    /**
     * True for a roster row whose copy is not resolved from the locale
     * dictionary: a preset that published its own name, or an id the display
     * fold does not know. Shipped rows (no name, known id) stay untouched so
     * their grouping and dictionary copy keep working.
     * @param {{ id: string, name?: string }} row - roster row or inventory group
     * @returns {boolean}
     */
    function isCustomRow(row) {
      return row !== null && typeof row === 'object'
        && (row.name !== undefined || !BUILT_IN_IDS.has(row.id));
    }

    /** Render one compact error list. */
    function errorList(title, errors) {
      return h('div', { className: 'dapt-errors' },
        h('span', null, title),
        h('ul', { className: 'dapt-errorList' },
          errors.slice(0, 6).map((error, index) => h('li', { key: index }, error.path + ': ' + error.message)),
          errors.length > 6 ? h('li', { key: 'more' }, '… ' + (errors.length - 6) + ' more') : null,
        ),
      );
    }

    /** One field row in a preset card. */
    function PresetField(props) {
      const { t, label, original, effective, onEdit } = props;
      const changed = original !== effective;
      return h('div', { className: 'dapt-fieldRow' },
        h('div', { className: 'dapt-fieldHead' },
          h('span', { className: 'dapt-fieldLabel' }, label),
          changed ? h('span', { className: 'dapt-badge dapt-badge--accent' }, t('editedBadge')) : null,
          h('button', { type: 'button', className: 'dapt-link', onClick: onEdit }, t('editRules')),
        ),
        h('div', { className: 'dapt-textPair' },
          h('div', { className: 'dapt-text' },
            h('span', { className: 'dapt-textLabel' }, t('originalLabel')),
            h('span', { className: 'dapt-textBody' }, original === '' ? '—' : original),
          ),
          h('div', { className: 'dapt-text' },
            h('span', { className: 'dapt-textLabel' }, t('effectiveLabel')),
            h('span', { className: 'dapt-textBody dapt-textBody--effective' }, effective === '' ? '—' : effective),
          ),
        ),
      );
    }

    /** One cell-rule row with its actions. */
    function CellRuleRow(props) {
      const { t, rule, disabled, pendingDelete, onEdit, onDelete, onConfirmDelete, onCancelDelete, onMove } = props;
      return h('li', { className: 'dapt-rule' },
        h('div', { className: 'dapt-ruleMain' },
          h('span', { className: 'dapt-badge' }, t('op' + rule.then.op[0].toUpperCase() + rule.then.op.slice(1))),
          h('span', { className: 'dapt-ruleText' }, rule.then.text === '' ? t('ruleTextEmpty') : rule.then.text),
          rule.when.text !== undefined ? h('span', { className: 'dapt-badge' }, t('matchLabel')) : null,
          rule.when.plugin !== undefined ? h('span', { className: 'dapt-badge' }, rule.when.plugin.id) : null,
          rule.when.workspace !== undefined ? h('span', { className: 'dapt-badge' }, rule.when.workspace) : null,
        ),
        h('div', { className: 'dapt-ruleActions' },
          pendingDelete === rule.id
            ? [
              h('button', { key: 'yes', type: 'button', className: 'dapt-button dapt-button--danger', disabled, onClick: () => onConfirmDelete(rule.id) }, t('confirmDelete')),
              h('button', { key: 'no', type: 'button', className: 'dapt-button', disabled, onClick: onCancelDelete }, t('cancel')),
            ]
            : [
              h('button', { key: 'edit', type: 'button', className: 'dapt-button', disabled, onClick: () => onEdit(rule) }, t('editRule')),
              h('button', { key: 'up', type: 'button', className: 'dapt-button', disabled, onClick: () => onMove(rule.id, -1), title: t('moveUp') }, '↑'),
              h('button', { key: 'down', type: 'button', className: 'dapt-button', disabled, onClick: () => onMove(rule.id, 1), title: t('moveDown') }, '↓'),
              h('button', { key: 'del', type: 'button', className: 'dapt-button dapt-button--danger', disabled, onClick: () => onDelete(rule.id) }, t('deleteRule')),
            ],
        ),
      );
    }

    /**
     * The settings section: status, per-language preset matrix, cell rule editor
     * and the raw document editor.
     * @param {object} props - injected face + locale translate + owner props
     * @returns {object}
     */
    function AgentPresetTextSection(props) {
      const {
        t, useAgentPresetText, saveCellRule, deleteCellRule, moveCellRule, saveRawDocument, refreshInventory,
      } = props;
      const state = useAgentPresetText((snapshot) => snapshot);
      const [locale, setLocale] = React.useState('');
      const [cell, setCell] = React.useState(null);
      const [editingId, setEditingId] = React.useState(null);
      const [draft, setDraft] = React.useState(EMPTY_DRAFT);
      const [notice, setNotice] = React.useState(null);
      const [rawOpen, setRawOpen] = React.useState(false);
      const [rawDraft, setRawDraft] = React.useState(null);
      const [rawErrors, setRawErrors] = React.useState([]);
      const [pendingDelete, setPendingDelete] = React.useState(null);

      const localeIds = [];
      if (state.locales.length === 0) {
        // No dictionary takeover: still offer the interface languages so custom
        // preset rules (which never need the dictionaries) remain editable.
        for (const option of state.localeOptions) localeIds.push(option.id);
      } else {
        for (const option of state.localeOptions) {
          if (state.locales.includes(option.id) && !localeIds.includes(option.id)) localeIds.push(option.id);
        }
        for (const id of state.locales) if (!localeIds.includes(id)) localeIds.push(id);
      }
      const fallbackLocale = state.locales.includes(state.activeLocale) ? state.activeLocale : (localeIds[0] || '');
      const shownLocale = localeIds.includes(locale) ? locale : fallbackLocale;
      const originals = state.originals[shownLocale] || {};
      const effective = state.effective[shownLocale] || {};
      const rules = state.document.rules || [];
      const cellRules = cell === null ? [] : rules
        .map((rule) => rule)
        .filter((rule) => isCellRule(rule, cell));

      const localeLabel = (id) => {
        const option = state.localeOptions.find((entry) => entry.id === id);
        return option === undefined || option.label === undefined ? id : option.label;
      };
      const fieldLabel = (field) => (field === 'name' ? t('fieldName') : t('fieldDescription'));
      const customRows = state.roster.filter(isCustomRow);
      /** Effective custom text for the preview language; '' when the field is absent. */
      const customEffectiveValue = (row, field) => {
        const byLocale = state.customEffective[shownLocale] || {};
        const entry = byLocale[row.id];
        const value = entry === undefined ? undefined : entry[field];
        if (value === null || value === undefined) {
          return row[field] === undefined ? '' : row[field];
        }
        return value;
      };
      const presetLabel = (id) => {
        const preset = BUILT_IN_PRESETS.find((entry) => entry.id === id);
        if (preset !== undefined) {
          return effective[preset.nameKey] || originals[preset.nameKey] || id;
        }
        const row = state.roster.find((entry) => entry.id === id);
        if (row !== undefined) return customEffectiveValue(row, 'name') || row.name || id;
        return id;
      };
      const errorsText = (errors) => {
        if (!Array.isArray(errors) || errors.length === 0) return t('saveFailed');
        return errors.map((error) => error.path + ': ' + error.message).join('；');
      };

      const openCell = (presetId, field) => {
        setCell({ locale: shownLocale, preset: presetId, field });
        setEditingId(null);
        setDraft(EMPTY_DRAFT);
        setNotice(null);
        setPendingDelete(null);
      };
      const startEdit = (rule) => {
        setEditingId(rule.id);
        setDraft(draftFromRule(rule));
        setNotice(null);
        setPendingDelete(null);
      };
      const resetEditor = () => {
        setEditingId(null);
        setDraft(EMPTY_DRAFT);
        setPendingDelete(null);
      };
      const submit = async () => {
        if (cell === null) return;
        if (draft.op === 'replace' && draft.findPattern.trim() === '') {
          setNotice({ kind: 'error', text: t('findRequired') });
          return;
        }
        const result = await saveCellRule(cell, editingId, draft);
        if (result.ok) {
          setNotice({ kind: 'ok', text: t('saved') });
          resetEditor();
        } else {
          setNotice({ kind: 'error', text: errorsText(result.errors) });
        }
      };
      const confirmDelete = async (id) => {
        const result = await deleteCellRule(cell, id);
        setPendingDelete(null);
        if (!result.ok) setNotice({ kind: 'error', text: errorsText(result.errors) });
        else setNotice({ kind: 'ok', text: t('saved') });
      };
      const move = async (id, delta) => {
        const result = await moveCellRule(cell, id, delta);
        if (!result.ok) setNotice({ kind: 'error', text: errorsText(result.errors) });
      };
      const rawText = rawDraft === null ? state.rawDocument : rawDraft;
      const saveRaw = async () => {
        const result = await saveRawDocument(rawText);
        if (result.ok) {
          setRawErrors([]);
          setRawDraft(null);
          setNotice({ kind: 'ok', text: t('saved') });
        } else {
          setRawErrors(result.errors);
        }
      };
      const formatRaw = () => {
        try {
          const parsed = JSON.parse(rawText);
          setRawDraft(JSON.stringify(parsed, null, 2));
          setRawErrors([]);
        } catch (error) {
          setRawErrors([{ path: '$', message: String(error instanceof Error ? error.message : error) }]);
        }
      };
      const revertRaw = () => {
        setRawDraft(null);
        setRawErrors([]);
      };

      const mechanismLabel = state.mechanism === 'active'
        ? t('mechActive')
        : state.mechanism === 'waiting' ? t('mechWaiting') : t('mechUnsupported');
      const mechanismDetail = state.mechanism === 'waiting'
        ? t('waitingDetail')
        : state.mechanism === 'unsupported'
          ? t('unsupportedDetail') + (state.detail === '' ? '' : ' — ' + state.detail)
          : '';


      return h('section', { className: 'dapt-section' },
        h('h2', { className: 'dapt-title' }, t('nav')),
        h('p', { className: 'dapt-intro' }, t('intro')),

        h('div', { className: 'dapt-status dapt-status--' + state.mechanism, role: 'status' },
          h('span', { className: 'dapt-dot' }),
          h('span', null, mechanismLabel),
          state.mechanism === 'active'
            ? h('span', { className: 'dapt-meta' }, t('statusLocale') + ' · ' + (state.activeLocale === '' ? '—' : localeLabel(state.activeLocale)))
            : null,
          state.mechanism === 'active'
            ? h('span', { className: 'dapt-meta' }, t('statusRules') + ' · ' + state.rulesCount)
            : null,
          state.mechanism === 'active'
            ? h('span', { className: 'dapt-meta' }, t('statusWorkspace') + ' · ' + (state.workspace === '' ? t('statusNoWorkspace') : state.workspace))
            : null,
          state.conflicts > 0
            ? h('span', { className: 'dapt-meta' }, t('statusConflicts') + ' · ' + state.conflicts)
            : null,
          h('span', { className: 'dapt-meta' }, t('statusInventory') + ' · ' + (
            state.inventoryStatus === 'ready' ? t('inventoryReady')
              : state.inventoryStatus === 'loading' ? t('inventoryLoading')
                : state.inventoryStatus === 'error' ? t('inventoryError') : '—')),
          h('span', { className: 'dapt-meta' }, t('statusCustom') + ' · ' + (
            state.customStatus === 'active' ? t('customActive')
              : state.customStatus === 'error' ? t('customError')
                : t('customUnavailable'))),
          h('button', {
            type: 'button',
            className: 'dapt-button',
            disabled: state.inventoryStatus === 'loading',
            onClick: () => { void refreshInventory(); },
          }, t('inventoryRefresh')),
        ),
        mechanismDetail === '' ? null : h('p', { className: 'dapt-detail' }, mechanismDetail),

        state.parseErrors.length > 0 ? errorList(t('parseFailed'), state.parseErrors) : null,
        state.document.enabled === false ? h('p', { className: 'dapt-detail' }, t('documentDisabled')) : null,
        state.writable === false ? h('p', { className: 'dapt-detail' }, t('notWritable')) : null,
        notice === null ? null : h('p', { className: notice.kind === 'error' ? 'dapt-notice dapt-notice--error' : 'dapt-notice' }, notice.text),

        localeIds.length === 0 ? null : h('div', { className: 'dapt-tabs', role: 'tablist', 'aria-label': t('localeLabel') },
          localeIds.map((id) => h('button', {
            key: id,
            type: 'button',
            role: 'tab',
            className: 'dapt-tab',
            'aria-selected': id === shownLocale,
            onClick: () => { setLocale(id); setCell(null); resetEditor(); },
          }, localeLabel(id) + ' · ' + id)),
        ),

        h('div', { className: 'dapt-group' },
          h('h3', { className: 'dapt-groupHead' }, t('presetGroup')),
          h('div', { className: 'dapt-cards' },
            BUILT_IN_PRESETS.map((preset) => {
              const originalName = originals[preset.nameKey] === undefined ? '' : originals[preset.nameKey];
              const effectiveName = effective[preset.nameKey] === undefined ? originalName : effective[preset.nameKey];
              const originalDescription = originals[preset.descriptionKey] === undefined ? '' : originals[preset.descriptionKey];
              const effectiveDescription = effective[preset.descriptionKey] === undefined ? originalDescription : effective[preset.descriptionKey];
              return h('article', { key: preset.id, className: 'dapt-card' },
                h('header', { className: 'dapt-cardHead' },
                  h('span', { className: 'dapt-cardName' }, effectiveName === '' ? preset.id : effectiveName),
                  h('code', { className: 'dapt-cardId' }, preset.id),
                ),
                h(PresetField, {
                  t,
                  label: t('fieldName'),
                  original: originalName,
                  effective: effectiveName,
                  onEdit: () => { openCell(preset.id, 'name'); },
                }),
                h(PresetField, {
                  t,
                  label: t('fieldDescription'),
                  original: originalDescription,
                  effective: effectiveDescription,
                  onEdit: () => { openCell(preset.id, 'description'); },
                }),
              );
            }),
          ),
        ),

        h('div', { className: 'dapt-group' },
          h('h3', { className: 'dapt-groupHead' }, t('customGroup')),
          h('p', { className: 'dapt-muted' }, t('customNote')),
          customRows.length === 0
            ? h('p', { className: 'dapt-muted' }, t('customEmpty'))
            : h('div', { className: 'dapt-cards' },
              customRows.map((row) => {
                const originalName = row.name === undefined ? '' : row.name;
                const originalDescription = row.description === undefined ? '' : row.description;
                const effectiveName = customEffectiveValue(row, 'name');
                const effectiveDescription = customEffectiveValue(row, 'description');
                return h('article', { key: 'custom-' + row.id, className: 'dapt-card' },
                  h('header', { className: 'dapt-cardHead' },
                    h('span', { className: 'dapt-cardName' }, effectiveName === '' ? row.id : effectiveName),
                    row.broken === undefined ? null : h('span', { className: 'dapt-badge dapt-badge--warn' }, t('customBroken')),
                    h('code', { className: 'dapt-cardId' }, row.id),
                  ),
                  h(PresetField, {
                    t,
                    label: t('fieldName'),
                    original: originalName,
                    effective: effectiveName,
                    onEdit: () => { openCell(row.id, 'name'); },
                  }),
                  h(PresetField, {
                    t,
                    label: t('fieldDescription'),
                    original: originalDescription,
                    effective: effectiveDescription,
                    onEdit: () => { openCell(row.id, 'description'); },
                  }),
                  row.broken === undefined ? null : h('p', { className: 'dapt-hint' }, row.broken),
                );
              })),
          h('p', { className: 'dapt-hint' }, t('customLanguageHint')),
        ),

        cell === null ? null : h('div', { className: 'dapt-editor' },
          h('div', { className: 'dapt-editorHead' },
            h('h3', { className: 'dapt-editorTitle' }, t('cellTitle') + ' · ' + presetLabel(cell.preset) + ' · ' + fieldLabel(cell.field) + ' · ' + localeLabel(cell.locale)),
            h('button', { type: 'button', className: 'dapt-link', onClick: () => { setCell(null); resetEditor(); } }, t('closeEditor')),
          ),
          h('h4', { className: 'dapt-subHead' }, t('cellRulesTitle')),
          cellRules.length === 0
            ? h('p', { className: 'dapt-muted' }, t('noCellRules'))
            : h('ul', { className: 'dapt-ruleList' },
              cellRules.map((rule) => h(CellRuleRow, {
                key: rule.id,
                t,
                rule,
                disabled: state.saving === true,
                pendingDelete,
                onEdit: startEdit,
                onDelete: (id) => { setPendingDelete(id); },
                onConfirmDelete: (id) => { void confirmDelete(id); },
                onCancelDelete: () => { setPendingDelete(null); },
                onMove: (id, delta) => { void move(id, delta); },
              })),
            ),
          h('p', { className: 'dapt-muted' }, t('advancedRulesNote')),
          h('h4', { className: 'dapt-subHead' }, editingId === null ? t('addRule') : t('editRule')),

          h('div', { className: 'dapt-form' },
            h('label', { className: 'dapt-label' }, t('opLabel'),
              h('select', {
                className: 'dapt-select',
                value: draft.op,
                disabled: state.saving === true,
                onChange: (event) => { setDraft({ ...draft, op: event.target.value }); },
              }, OPERATIONS.map((op) => h('option', { key: op, value: op }, t('op' + op[0].toUpperCase() + op.slice(1))))),
            ),
            h('label', { className: 'dapt-label' }, t('textLabel'),
              h('textarea', {
                className: 'dapt-textarea',
                value: draft.text,
                spellCheck: false,
                disabled: state.saving === true,
                onChange: (event) => { setDraft({ ...draft, text: event.target.value }); },
              }),
              h('span', { className: 'dapt-hint' }, t('textHint')),
            ),
            draft.op === 'replace'
              ? h('div', { className: 'dapt-row' },
                h('label', { className: 'dapt-label', style: { flex: '1 1 160px' } }, t('findLabel'),
                  h('select', {
                    className: 'dapt-select',
                    value: draft.findMode,
                    disabled: state.saving === true,
                    onChange: (event) => { setDraft({ ...draft, findMode: event.target.value }); },
                  }, ['exact', 'glob', 'regex'].map((mode) => h('option', { key: mode, value: mode }, t('match' + mode[0].toUpperCase() + mode.slice(1))))),
                ),
                h('label', { className: 'dapt-label', style: { flex: '2 1 240px' } }, t('patternLabel'),
                  h('input', {
                    className: 'dapt-input',
                    value: draft.findPattern,
                    spellCheck: false,
                    disabled: state.saving === true,
                    onChange: (event) => { setDraft({ ...draft, findPattern: event.target.value }); },
                  }),
                ),
                draft.findMode === 'regex'
                  ? h('label', { className: 'dapt-label', style: { flex: '0 1 90px' } }, t('flagsLabel'),
                    h('input', {
                      className: 'dapt-input',
                      value: draft.findFlags,
                      spellCheck: false,
                      disabled: state.saving === true,
                      onChange: (event) => { setDraft({ ...draft, findFlags: event.target.value }); },
                    }),
                  )
                  : null,
              )
              : null,

            h('h4', { className: 'dapt-subHead' }, t('conditionsTitle')),
            h('div', { className: 'dapt-row' },
              h('label', { className: 'dapt-label', style: { flex: '0 1 150px' } }, t('matchLabel'),
                h('select', {
                  className: 'dapt-select',
                  value: draft.matchMode,
                  disabled: state.saving === true,
                  onChange: (event) => { setDraft({ ...draft, matchMode: event.target.value }); },
                }, MATCH_MODES.map((mode) => h('option', { key: mode, value: mode }, t('match' + mode[0].toUpperCase() + mode.slice(1))))),
              ),
              draft.matchMode === 'any' ? null : h('label', { className: 'dapt-label', style: { flex: '1 1 220px' } }, t('patternLabel'),
                h('input', {
                  className: 'dapt-input',
                  value: draft.matchPattern,
                  spellCheck: false,
                  disabled: state.saving === true,
                  onChange: (event) => { setDraft({ ...draft, matchPattern: event.target.value }); },
                }),
              ),
              draft.matchMode !== 'regex' ? null : h('label', { className: 'dapt-label', style: { flex: '0 1 90px' } }, t('flagsLabel'),
                h('input', {
                  className: 'dapt-input',
                  value: draft.matchFlags,
                  spellCheck: false,
                  disabled: state.saving === true,
                  onChange: (event) => { setDraft({ ...draft, matchFlags: event.target.value }); },
                }),
              ),
            ),
            h('div', { className: 'dapt-row' },
              h('label', { className: 'dapt-label', style: { flex: '1 1 220px' } }, t('pluginLabel'),
                h('input', {
                  className: 'dapt-input',
                  value: draft.plugin,
                  spellCheck: false,
                  disabled: state.saving === true,
                  onChange: (event) => { setDraft({ ...draft, plugin: event.target.value }); },
                }),
                h('span', { className: 'dapt-hint' }, t('pluginHint')),
              ),
              h('label', { className: 'dapt-label', style: { flex: '0 1 130px' } }, t('pluginStateLabel'),
                h('select', {
                  className: 'dapt-select',
                  value: draft.pluginState,
                  disabled: state.saving === true,
                  onChange: (event) => { setDraft({ ...draft, pluginState: event.target.value }); },
                }, PLUGIN_STATES.map((pluginState) => h('option', { key: pluginState, value: pluginState }, t('plugin' + pluginState[0].toUpperCase() + pluginState.slice(1))))),
              ),
            ),
            h('label', { className: 'dapt-label' }, t('workspaceLabel'),
              h('input', {
                className: 'dapt-input',
                value: draft.workspace,
                spellCheck: false,
                disabled: state.saving === true,
                onChange: (event) => { setDraft({ ...draft, workspace: event.target.value }); },
              }),
              h('span', { className: 'dapt-hint' }, t('workspaceHint')),
            ),

            h('div', { className: 'dapt-actions' },
              h('button', {
                type: 'button',
                className: 'dapt-button dapt-button--primary',
                disabled: state.saving === true,
                onClick: () => { void submit(); },
              }, t('saveRule')),
              h('button', {
                type: 'button',
                className: 'dapt-button',
                disabled: state.saving === true,
                onClick: resetEditor,
              }, t('cancel')),
            ),
          ),
        ),

        h('div', { className: 'dapt-raw' },
          h('div', { className: 'dapt-actions' },
            h('button', {
              type: 'button',
              className: 'dapt-button',
              onClick: () => {
                setRawOpen(!rawOpen);
                if (!rawOpen) {
                  setRawDraft(null);
                  setRawErrors([]);
                }
              },
            }, t('rawTitle')),
            h('span', { className: 'dapt-hint' }, t('rulesCount', { n: rules.length })),
          ),
          rawOpen
            ? h('div', { className: 'dapt-form' },
              h('p', { className: 'dapt-hint' }, t('rawHint')),
              h('textarea', {
                className: 'dapt-textarea dapt-textarea--raw',
                value: rawText,
                placeholder: t('rawPlaceholder'),
                spellCheck: false,
                onChange: (event) => { setRawDraft(event.target.value); setRawErrors([]); },
              }),
              rawErrors.length > 0 ? errorList(t('rawErrors'), rawErrors) : null,
              h('div', { className: 'dapt-actions' },
                h('button', { type: 'button', className: 'dapt-button dapt-button--primary', disabled: state.saving === true, onClick: () => { void saveRaw(); } }, t('rawSave')),
                h('button', { type: 'button', className: 'dapt-button', disabled: state.saving === true, onClick: formatRaw }, t('rawFormat')),
                h('button', { type: 'button', className: 'dapt-button', disabled: state.saving === true || rawDraft === null, onClick: revertRaw }, t('rawRevert')),
                state.saving === true ? h('span', { className: 'dapt-hint' }, t('saving')) : null,
              ),
            )
            : null,
        ),

      );
    }

    /* ------------------------------------------------------------------ *
     * plugin body
     * ------------------------------------------------------------------ */

    /** Turn `Map<locale, Map<key, text>>` into the plain object a snapshot may hold. */
    function mapsToObject(map) {
      const out = {};
      for (const [locale, keys] of map) out[locale] = Object.fromEntries(keys);
      return out;
    }

    /** Minimal snapshot store for the injected hook. */
    function createStore(initial) {
      let snapshot = initial;
      const listeners = new Set();
      return {
        getSnapshot() {
          return snapshot;
        },
        subscribe(listener) {
          listeners.add(listener);
          return () => { listeners.delete(listener); };
        },
        update(patch) {
          const next = { ...snapshot, ...patch };
          next.revision = snapshot.revision + 1;
          snapshot = next;
          for (const listener of [...listeners]) {
            try {
              listener();
            } catch (error) {
              console.error('[agent-preset-text] store listener failed', error);
            }
          }
        },
      };
    }

    /** The store's initial snapshot. */
    function initialState() {
      return {
        mechanism: 'waiting',
        detail: '',
        activeLocale: '',
        localeOptions: [],
        locales: [],
        originals: {},
        effective: {},
        document: EMPTY_DOCUMENT,
        rawDocument: '',
        parseErrors: [],
        rulesCount: 0,
        conflicts: 0,
        roster: [],
        rosterStatus: 'idle',
        customEffective: {},
        customStatus: 'unavailable',
        inventoryStatus: 'idle',
        workspace: '',
        writable: undefined,
        saving: false,
        revision: 0,
      };
    }

    /**
     * Client plugin body.
     * @param {object} ctx - browser Cordis context
     */
    function apply(ctx) {
      const copy = ctx.locale.bind(COPY_NAMESPACE);
      ctx.effect(() => ctx.locale.register(COPY_NAMESPACE, { zh, en }), 'agent-preset-text: interface dictionaries');

      const store = createStore(initialState());
      const form = ctx.configForms.get(SETTINGS_NAMESPACE);

      /** Original text per locale and dictionary key, captured before any write. */
      const originals = new Map();
      /** Dictionary object per locale; identity changes mean the shipped plugin re-registered. */
      const dictRefs = new Map();
      /** Values this plugin wrote, per locale and key, for conflict detection and restore. */
      const written = new Map();
      /** Retain-info subscriptions keyed by session id (workspace condition). */
      const retainSubs = new Map();

      let lastRaw;
      let lastDocument = EMPTY_DOCUMENT;
      let lastParseErrors = [];
      let rosterRows = [];
      let customStatus = 'unavailable';
      let customEffective = {};
      let lastCustomSignature = '';
      let inventory;
      let inventoryStatus = 'idle';
      let inventoryPromise;
      let inventoryFetchedAt = 0;
      let workspace = '';
      let disposed = false;
      let scheduled = false;
      let saving = false;

      function setState(patch) {
        store.update(patch);
      }

      /* ---------------- dictionary access ---------------- */

      /**
       * Read the shipped namespace out of the locale service.
       * @returns {{ ok: true, entries: Map<string, object> | null } | { ok: false, reason: string }}
       */
      function acquireDictionaries() {
        try {
          const dicts = ctx.locale.dicts;
          if (!(dicts instanceof Map)) return { ok: false, reason: 'ctx.locale.dicts is missing or not a Map' };
          const locales = dicts.get(SOURCE_NAMESPACE);
          if (!(locales instanceof Map)) return { ok: true, entries: null };
          const entries = new Map();
          for (const [locale, dictionary] of locales) {
            if (isPlainObject(dictionary)) entries.set(locale, dictionary);
          }
          return { ok: true, entries };
        } catch (error) {
          return { ok: false, reason: error instanceof Error ? error.message : String(error) };
        }
      }

      /**
       * Refresh the original snapshot. A new dictionary object means the shipped
       * plugin re-registered; its values are the fresh originals, so any value
       * this plugin wrote for that locale is no longer relevant.
       * @param {Map<string, object>} entries
       * @returns {boolean} whether anything was recaptured
       */
      function captureOriginals(entries) {
        const nextOriginals = new Map();
        const nextRefs = new Map();
        let recaptured = false;
        for (const [locale, dictionary] of entries) {
          const previousRef = dictRefs.get(locale);
          const previousOriginal = originals.get(locale);
          if (previousRef === dictionary && previousOriginal !== undefined) {
            nextRefs.set(locale, dictionary);
            nextOriginals.set(locale, previousOriginal);
          } else {
            const snapshot = new Map();
            for (const key of Object.keys(dictionary)) {
              if (typeof dictionary[key] === 'string') snapshot.set(key, dictionary[key]);
            }
            nextRefs.set(locale, dictionary);
            nextOriginals.set(locale, snapshot);
            if (previousRef !== undefined) written.delete(locale);
            recaptured = true;
          }
        }
        for (const locale of [...dictRefs.keys()]) {
          if (!nextRefs.has(locale)) written.delete(locale);
        }
        dictRefs.clear();
        for (const [locale, dictionary] of nextRefs) dictRefs.set(locale, dictionary);
        originals.clear();
        for (const [locale, snapshot] of nextOriginals) originals.set(locale, snapshot);
        return recaptured;
      }

      /* ---------------- apply / restore ---------------- */

      /** Bump the locale revision through a disposable, unbound probe namespace. */
      function bumpLocale() {
        try {
          const dispose = ctx.locale.register(PROBE_NAMESPACE, 'en', {});
          dispose();
        } catch (error) {
          console.error('[agent-preset-text] locale revision probe failed', error);
        }
      }

      /**
       * Write the computed text into the dictionaries.
       * @param {object} document
       * @param {{ plugins?: unknown[], workspace?: string }} context
       * @returns {{ effective: Map, changed: boolean, conflicts: number }}
       */
      function applyDocument(document, context) {
        const effective = computeTexts(document, originals, context);
        let changed = false;
        let conflicts = 0;
        for (const [locale, desired] of effective) {
          const dictionary = dictRefs.get(locale);
          const original = originals.get(locale);
          if (dictionary === undefined || original === undefined) continue;
          let mine = written.get(locale);
          for (const [key, before] of original) {
            const want = desired.has(key) ? desired.get(key) : before;
            const actual = dictionary[key];
            const owned = actual === before || (mine !== undefined && mine.get(key) === actual);
            if (actual === want) {
              // Still ours: the value is already the computed one. Drop the
              // record only when the computed value is the original again.
              if (mine !== undefined && mine.get(key) === actual && want === before) mine.delete(key);
              continue;
            }
            if (!owned) {
              conflicts += 1;
              continue;
            }
            dictionary[key] = want;
            changed = true;
            if (want === before) {
              if (mine !== undefined) mine.delete(key);
            } else {
              if (mine === undefined) {
                mine = new Map();
                written.set(locale, mine);
              }
              mine.set(key, want);
            }
          }
          if (mine !== undefined && mine.size === 0) written.delete(locale);
        }
        return { effective, changed, conflicts };
      }

      /** Restore every value this plugin still owns, then refresh the UI. */
      function restoreOriginals() {
        let restored = false;
        const read = acquireDictionaries();
        const entries = read.ok ? read.entries : null;
        for (const [locale, mine] of written) {
          const dictionary = entries === null ? dictRefs.get(locale) : (entries.get(locale) || dictRefs.get(locale));
          if (dictionary === undefined) continue;
          for (const [key, value] of mine) {
            if (dictionary[key] !== value) continue;
            const before = originals.get(locale) === undefined ? undefined : originals.get(locale).get(key);
            if (typeof before === 'string') {
              dictionary[key] = before;
              restored = true;
            }
          }
        }
        written.clear();
        dictRefs.clear();
        originals.clear();
        if (restored) {
          try {
            const dispose = ctx.locale.register(PROBE_NAMESPACE, 'en', {});
            dispose();
          } catch (error) {
            console.error('[agent-preset-text] locale revision probe failed during restore', error);
          }
        }
      }

      /* ---------------- workspace ---------------- */

      /** The main-view session's working directory, or an empty string. */
      function currentWorkspacePath() {
        try {
          const list = ctx.sessions.list.getSnapshot();
          const candidates = [];
          for (const id of Object.keys(list.byId || {})) {
            const summary = list.byId[id];
            const info = ctx.sessions.retainInfo(id).getSnapshot();
            if ((info && info.retainedBy && info.retainedBy.mainView ? info.retainedBy.mainView : 0) > 0) candidates.push(summary);
          }
          const blank = candidates.find((summary) => summary.blank === true);
          const chosen = blank !== undefined
            ? blank
            : candidates.sort((left, right) => (right.updatedAt || 0) - (left.updatedAt || 0))[0];
          return chosen !== undefined && typeof chosen.cwd === 'string' ? chosen.cwd : '';
        } catch (error) {
          return '';
        }
      }

      /** Recompute the workspace and follow retain changes for every known session. */
      function rebuildWorkspace() {
        try {
          const list = ctx.sessions.list.getSnapshot();
          const ids = new Set(Object.keys(list.byId || {}));
          for (const [id, dispose] of retainSubs) {
            if (!ids.has(id)) {
              dispose();
              retainSubs.delete(id);
            }
          }
          for (const id of ids) {
            if (retainSubs.has(id)) continue;
            try {
              retainSubs.set(id, ctx.sessions.retainInfo(id).subscribe(() => { schedule(); }));
            } catch (error) {
              // A session that lost its retain source is simply not watched.
            }
          }
        } catch (error) {
          // Session tracking is best effort; the workspace condition then stays empty.
        }
        workspace = currentWorkspacePath();
      }

      /* ---------------- remote data ---------------- */

      /**
       * Read one provisioned Remote namespace without making it an activation
       * dependency.
       *
       * `ctx.remote.<namespace>` is itself a provisioned service, and the
       * context proxy refuses such an access unless the name is in this
       * plugin's `inject` list. `ctx.get()` reads the same provision directly
       * and yields `undefined` while the namespace is not mounted, which is
       * what keeps the dictionary takeover alive in a deployment where the
       * optional roster or inventory namespace is absent.
       * @param {string} name - Remote namespace, without the `remote.` prefix.
       * @returns {object | undefined}
       */
      function remoteNamespace(name) {
        try {
          return ctx.get('remote.' + name);
        } catch (error) {
          return undefined;
        }
      }

      /* ---------------- custom preset takeover ---------------- */

      /** Display wrappers this plugin currently holds, keyed by `namespace.method`. */
      const remotePatches = new Map();

      /** Compute one custom field at display time (active interface locale + live conditions). */
      function liveCustomText(id, field, original) {
        return computePresetText(lastDocument, {
          locale: ctx.locale.getLocale().active,
          preset: id,
          field,
          original,
        }, { plugins: inventory, workspace });
      }

      /**
       * Decorate one roster row with live display getters.
       * The settings section stores rows directly, so the getters are read on
       * every render; consumers that copy the fields read them at load time.
       */
      function decoratePresetRow(row) {
        if (!isCustomRow(row)) return row;
        const out = { ...row };
        Object.defineProperty(out, 'name', {
          enumerable: true,
          configurable: true,
          get: () => liveCustomText(row.id, 'name', row.name),
        });
        Object.defineProperty(out, 'description', {
          enumerable: true,
          configurable: true,
          get: () => liveCustomText(row.id, 'description', row.description),
        });
        return out;
      }

      /** Decorate one plugin-inventory preset group (name only; groups carry no description). */
      function decoratePresetGroup(group) {
        if (group === null || typeof group !== 'object') return group;
        if (!isCustomRow({ id: group.id, name: group.name })) return group;
        const out = { ...group };
        Object.defineProperty(out, 'name', {
          enumerable: true,
          configurable: true,
          get: () => liveCustomText(group.id, 'name', group.name),
        });
        return out;
      }

      /** Transform one `agentPresets.list` result. */
      function decorateRosterResult(result) {
        if (result === null || typeof result !== 'object' || result.ok !== true) return result;
        const value = result.value;
        if (value === null || typeof value !== 'object' || !Array.isArray(value.presets)) return result;
        return { ...result, value: { ...value, presets: value.presets.map(decoratePresetRow) } };
      }

      /** Transform one `agentPresets.read` result for a custom preset. */
      function decorateReadResult(result) {
        if (result === null || typeof result !== 'object' || result.ok !== true) return result;
        const value = result.value;
        if (value === null || typeof value !== 'object' || typeof value.agentPreset !== 'string') return result;
        if (!isCustomRow({ id: value.agentPreset, name: value.name })) return result;
        const name = liveCustomText(value.agentPreset, 'name', value.name);
        const description = liveCustomText(value.agentPreset, 'description', value.description);
        return {
          ...result,
          value: {
            ...value,
            ...(name === undefined ? {} : { name }),
            ...(description === undefined ? {} : { description }),
          },
        };
      }

      /** Transform one `pluginInventory.list` result's preset group names. */
      function decorateInventoryResult(result) {
        if (result === null || typeof result !== 'object' || result.ok !== true) return result;
        const value = result.value;
        if (value === null || typeof value !== 'object' || !Array.isArray(value.agentPresets)) return result;
        return { ...result, value: { ...value, agentPresets: value.agentPresets.map(decoratePresetGroup) } };
      }

      /**
       * Install one display wrapper over a Remote namespace method.
       *
       * The Gateway installs each namespace method as a configurable accessor
       * that returns a caller-bound invoker; a wrapper is a configurable data
       * property over it. Calling the original accessor with the consumer's
       * `this` preserves that caller binding. The original descriptor is kept
       * for restoration, and a method the Gateway re-installs is patched again
       * by the next `ensureRemotePatches()`.
       *
       * @param {string} namespaceName - namespace without the `remote.` prefix
       * @param {string} method - method name
       * @param {(result: unknown) => unknown} transform - display transform over the result
       */
      function ensureRemotePatch(namespaceName, method, transform) {
        const key = namespaceName + '.' + method;
        const service = remoteNamespace(namespaceName);
        const existing = remotePatches.get(key);
        if (service === undefined) {
          if (existing !== undefined) {
            existing.restore();
            remotePatches.delete(key);
          }
          return;
        }
        const descriptor = Object.getOwnPropertyDescriptor(service, method);
        if (existing !== undefined) {
          if (existing.service === service && descriptor !== undefined && descriptor.value === existing.wrapper) return;
          existing.restore();
          remotePatches.delete(key);
        }
        if (descriptor === undefined) return;
        const raw = service[method];
        if (typeof raw !== 'function') return;
        const wrapper = function wrappedRemoteMethod(...args) {
          let invoke = raw;
          if (typeof descriptor.get === 'function') {
            try {
              const bound = descriptor.get.call(this);
              if (typeof bound === 'function') invoke = bound;
            } catch (error) {
              invoke = raw;
            }
          } else if (typeof descriptor.value === 'function') {
            invoke = descriptor.value;
          }
          return Promise.resolve(invoke.apply(this, args)).then(transform);
        };
        Object.defineProperty(service, method, {
          configurable: true,
          enumerable: true,
          writable: true,
          value: wrapper,
        });
        const restore = () => {
          const current = Object.getOwnPropertyDescriptor(service, method);
          if (current !== undefined && current.value === wrapper) {
            Object.defineProperty(service, method, descriptor);
          }
        };
        remotePatches.set(key, { service, method, descriptor, wrapper, raw, restore });
      }

      /** Keep the display wrappers installed across namespace mounts and method reinstalls. */
      function ensureRemotePatches() {
        ensureRemotePatch('agentPresets', 'list', decorateRosterResult);
        ensureRemotePatch('agentPresets', 'read', decorateReadResult);
        ensureRemotePatch('pluginInventory', 'list', decorateInventoryResult);
      }

      /** Restore every Remote method descriptor this plugin replaced. */
      function restoreRemotePatches() {
        for (const patch of remotePatches.values()) patch.restore();
        remotePatches.clear();
      }

      /**
       * Read one namespace method without going through this plugin's wrapper.
       * Used for this plugin's own roster/inventory reads (the raw declaration
       * data), never for another consumer's display.
       * @returns {((...args: unknown[]) => unknown) | undefined}
       */
      function rawNamespaceMethod(namespaceName, method) {
        ensureRemotePatches();
        const service = remoteNamespace(namespaceName);
        if (service === undefined) return undefined;
        const patch = remotePatches.get(namespaceName + '.' + method);
        if (patch !== undefined && patch.service === service) return patch.raw;
        const candidate = service[method];
        return typeof candidate === 'function' ? candidate.bind(service) : undefined;
      }

      /** Read the preset roster for the custom-preset cards and default marks. */
      async function refreshRoster() {
        const remote = remoteNamespace('agentPresets');
        if (remote === undefined || typeof remote.list !== 'function') {
          rosterRows = [];
          customStatus = 'unavailable';
          setState({ roster: [], rosterStatus: 'ready', customStatus });
          schedule();
          return;
        }
        setState({ rosterStatus: 'loading', customStatus: 'active' });
        try {
          const list = rawNamespaceMethod('agentPresets', 'list');
          if (list === undefined) throw new Error('agentPresets.list is unavailable');
          const result = await list();
          if (result.ok) {
            rosterRows = Array.isArray(result.value.presets) ? result.value.presets : [];
            customStatus = 'active';
            setState({ roster: rosterRows, rosterStatus: 'ready', customStatus });
          } else if (result.error !== undefined && result.error.code === 'gateway/invocation-unavailable') {
            rosterRows = [];
            customStatus = 'unavailable';
            setState({ roster: [], rosterStatus: 'ready', customStatus });
          } else {
            rosterRows = [];
            customStatus = 'error';
            setState({ roster: [], rosterStatus: 'error', customStatus });
          }
        } catch (error) {
          console.error('[agent-preset-text] roster read failed', error);
          rosterRows = [];
          customStatus = 'error';
          setState({ roster: [], rosterStatus: 'error', customStatus });
        }
        schedule();
      }

      /**
       * Read the Host plugin inventory, throttled because the condition is
       * evaluated on every recompute and the Remote is a point-in-time read.
       * @param {boolean} [force]
       * @returns {Promise<void>}
       */
      function refreshInventory(force) {
        const remote = remoteNamespace('pluginInventory');
        if (remote === undefined || typeof remote.list !== 'function') {
          inventoryStatus = 'error';
          setState({ inventoryStatus });
          return Promise.resolve();
        }
        const list = rawNamespaceMethod('pluginInventory', 'list');
        if (list === undefined) {
          inventoryStatus = 'error';
          setState({ inventoryStatus });
          return Promise.resolve();
        }
        const now = Date.now();
        if (force !== true && now - inventoryFetchedAt < 2000) return inventoryPromise === undefined ? Promise.resolve() : inventoryPromise;
        inventoryFetchedAt = now;
        inventoryStatus = 'loading';
        setState({ inventoryStatus });
        inventoryPromise = (async () => {
          try {
            const result = await list();
            if (result.ok) {
              inventory = result.value.entries;
              inventoryStatus = 'ready';
            } else {
              inventory = undefined;
              inventoryStatus = 'error';
            }
          } catch (error) {
            console.error('[agent-preset-text] plugin inventory read failed', error);
            inventory = undefined;
            inventoryStatus = 'error';
          }
          inventoryPromise = undefined;
          setState({ inventoryStatus });
          schedule();
        })();
        return inventoryPromise;
      }

      /* ---------------- document and recompute ---------------- */

      /** Merge the persisted document into local state; an invalid document keeps the last usable one. */
      function readConfig() {
        const snapshot = form.getSnapshot();
        if (snapshot.status !== 'ready') {
          if (snapshot.status === 'unavailable') setState({ writable: false });
          return;
        }
        const value = snapshot.value;
        const raw = isPlainObject(value) && typeof value[CONFIG_FIELD] === 'string' ? value[CONFIG_FIELD] : '';
        if (raw === lastRaw) return;
        lastRaw = raw;
        const parsed = parseDocument(raw);
        if (parsed.ok) {
          lastDocument = parsed.document;
          lastParseErrors = [];
        } else {
          lastParseErrors = parsed.errors;
        }
      }

      /** The state fields every recompute publishes, whatever the mechanism status is. */
      function commonState() {
        const localeSnapshot = ctx.locale.getLocale();
        return {
          activeLocale: localeSnapshot.active,
          localeOptions: localeSnapshot.locales.map((locale) => ({ id: locale.id, label: locale.label })),
          document: lastDocument,
          rawDocument: lastRaw === undefined ? '' : lastRaw,
          parseErrors: lastParseErrors,
          rulesCount: lastDocument.rules.length,
          workspace,
          inventoryStatus,
          saving,
          writable: form.getSnapshot().writable === true,
        };
      }

      /** Compute the custom-preset display table for every registered language. */
      function computeCustomEffective(locales) {
        const compiled = compileRules(lastDocument);
        const out = {};
        for (const locale of locales) out[locale] = {};
        for (const row of rosterRows) {
          if (!isCustomRow(row)) continue;
          for (const locale of locales) {
            const entry = {};
            for (const field of ['name', 'description']) {
              const value = computePresetText(lastDocument, {
                locale,
                preset: row.id,
                field,
                original: row[field],
              }, { plugins: inventory, workspace }, compiled);
              entry[field] = value === undefined ? null : value;
            }
            out[locale][row.id] = entry;
          }
        }
        return out;
      }

      /** Recompute the effective text and publish it. */
      function recompute() {
        if (disposed) return;
        readConfig();
        ensureRemotePatches();
        const localeSnapshot = ctx.locale.getLocale();
        const custom = computeCustomEffective(localeSnapshot.locales.map((locale) => locale.id));
        const customSignature = JSON.stringify(custom);
        const customChanged = customSignature !== lastCustomSignature;
        lastCustomSignature = customSignature;
        customEffective = custom;
        const read = acquireDictionaries();
        if (!read.ok) {
          setState({
            ...commonState(),
            mechanism: 'unsupported',
            detail: read.reason,
            customEffective,
            customStatus,
          });
          if (customChanged) bumpLocale();
          return;
        }
        if (read.entries === null) {
          setState({
            ...commonState(),
            mechanism: 'waiting',
            detail: '',
            customEffective,
            customStatus,
          });
          if (customChanged) bumpLocale();
          return;
        }
        captureOriginals(read.entries);
        const applied = applyDocument(lastDocument, { plugins: inventory, workspace });
        setState({
          ...commonState(),
          mechanism: 'active',
          detail: '',
          locales: [...dictRefs.keys()].sort(),
          originals: mapsToObject(originals),
          effective: mapsToObject(applied.effective),
          conflicts: applied.conflicts,
          customEffective,
          customStatus,
        });
        if (applied.changed || customChanged) bumpLocale();
      }

      /** Coalesce every trigger into one recompute. */
      function schedule() {
        if (disposed || scheduled) return;
        scheduled = true;
        queueMicrotask(() => {
          scheduled = false;
          try {
            recompute();
            if (lastDocument.rules.some((rule) => rule.when.plugin !== undefined)) void refreshInventory(false);
          } catch (error) {
            console.error('[agent-preset-text] recompute failed', error);
          }
        });
      }

      /* ---------------- persistence ---------------- */

      /**
       * Persist document text and adopt it optimistically.
       * @param {string} text
       * @param {object} document - normalized document represented by `text`
       * @returns {Promise<{ok: boolean, errors: Array<{path: string, message: string}>}>}
       */
      async function persist(text, document) {
        if (saving) return { ok: false, errors: [{ path: '$', message: '正在保存，请稍候。' }] };
        saving = true;
        setState({ saving: true });
        try {
          const accepted = await form.set(CONFIG_FIELD, text);
          if (!accepted) return { ok: false, errors: [{ path: '$', message: 'Host rejected the write' }] };
          lastRaw = text;
          lastDocument = document;
          lastParseErrors = [];
          return { ok: true, errors: [] };
        } catch (error) {
          return { ok: false, errors: [{ path: '$', message: error instanceof Error ? error.message : String(error) }] };
        } finally {
          saving = false;
          setState({ saving: false });
          schedule();
        }
      }

      /**
       * Save one cell rule (insert or replace).
       * @param {{locale: string, preset: string, field: string}} cell
       * @param {string | null} id - existing rule id, or null for a new rule
       * @param {object} draft
       * @returns {Promise<{ok: boolean, errors: Array}>}
       */
      async function saveCellRule(cell, id, draft) {
        const document = cloneDocument(lastDocument);
        const ruleId = id === null || id === undefined ? 'rule-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7) : id;
        const rule = ruleFromDraft(cell, ruleId, draft);
        const index = document.rules.findIndex((entry) => entry.id === ruleId);
        if (index < 0) document.rules.push(rule);
        else document.rules[index] = rule;
        const text = JSON.stringify(document, null, 2);
        const parsed = parseDocument(text);
        if (!parsed.ok) return { ok: false, errors: parsed.errors };
        return persist(text, parsed.document);
      }

      /** Delete one cell rule. */
      async function deleteCellRule(cell, id) {
        const document = cloneDocument(lastDocument);
        document.rules = document.rules.filter((rule) => rule.id !== id);
        const text = JSON.stringify(document, null, 2);
        const parsed = parseDocument(text);
        if (!parsed.ok) return { ok: false, errors: parsed.errors };
        return persist(text, parsed.document);
      }

      /** Move one cell rule by one position in document order. */
      async function moveCellRule(cell, id, delta) {
        const document = cloneDocument(lastDocument);
        const index = document.rules.findIndex((rule) => rule.id === id);
        const target = index + delta;
        if (index < 0 || target < 0 || target >= document.rules.length) return { ok: true, errors: [] };
        const [rule] = document.rules.splice(index, 1);
        document.rules.splice(target, 0, rule);
        const text = JSON.stringify(document, null, 2);
        const parsed = parseDocument(text);
        if (!parsed.ok) return { ok: false, errors: parsed.errors };
        return persist(text, parsed.document);
      }

      /** Validate and save raw document text. */
      async function saveRawDocument(text) {
        const parsed = parseDocument(text);
        if (!parsed.ok) return { ok: false, errors: parsed.errors };
        return persist(text, parsed.document);
      }

      /* ---------------- wiring ---------------- */

      ctx.effect(() => form.subscribe(() => { schedule(); }), 'agent-preset-text: configuration');
      ctx.effect(() => ctx.locale.subscribe(() => { schedule(); }), 'agent-preset-text: locale');
      ctx.effect(() => {
        const disposeList = ctx.sessions.list.subscribe(() => { rebuildWorkspace(); schedule(); });
        rebuildWorkspace();
        return () => {
          disposeList();
          for (const dispose of retainSubs.values()) dispose();
          retainSubs.clear();
        };
      }, 'agent-preset-text: workspace tracking');
      ctx.effect(() => {
        const offManager = ctx.remote.$on('plugin-manager/changed', () => { void refreshInventory(true); });
        const offReset = ctx.on('connection/reset', () => {
          void refreshInventory(true);
          void refreshRoster();
          schedule();
        });
        return () => {
          offManager();
          offReset();
        };
      }, 'agent-preset-text: host change signals');
      ctx.effect(() => {
        if (typeof document === 'undefined' || document.head === undefined) return undefined;
        const tag = document.createElement('style');
        tag.dataset.plugin = '@local/dsh-agent-preset-text';
        tag.textContent = STYLE;
        document.head.appendChild(tag);
        return () => { tag.remove(); };
      }, 'agent-preset-text: section styles');

      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: SECTION_ID,
        order: SECTION_ORDER,
        label: () => copy('nav'),
        locale: COPY_NAMESPACE,
        inject: () => ({
          hooks: { agentPresetText: store },
          saveCellRule,
          deleteCellRule,
          moveCellRule,
          saveRawDocument,
          refreshInventory: () => refreshInventory(true),
        }),
      }, AgentPresetTextSection));

      ctx.effect(() => () => {
        disposed = true;
        restoreRemotePatches();
        restoreOriginals();
      }, 'agent-preset-text: restore');

      // The Remote namespaces mount asynchronously after the browser plugin
      // tree starts. Wait for them without turning them into activation
      // dependencies, then install the display wrappers and read the data they
      // back; the initial reads above may legitimately find them absent.
      ctx.inject(['remote.agentPresets', 'remote.pluginInventory'], () => {
        ensureRemotePatches();
        void refreshRoster();
        void refreshInventory(true);
        schedule();
      });

      ensureRemotePatches();
      void refreshRoster();
      void refreshInventory(true);
      schedule();
    }

    /* ------------------------------------------------------------------ *
     * exports
     * ------------------------------------------------------------------ */

    return {
      inject: ['slots', 'locale', 'configForms', 'remote', 'sessions'],
      apply,
      __test: {
        parseDocument,
        normalizeDocument,
        normalizeRule,
        compileRules,
        applyCompiledRules,
        computeTexts,
        computePresetText,
        globToRegExp,
        renderTemplate,
        compileMatcher,
        matchesText,
        applyOperation,
        replaceWith,
        isCellRule,
        AgentPresetTextSection,
        draftFromRule,
        ruleFromDraft,
        BUILT_IN_PRESETS,
        KEY_TO_TARGET,
        EMPTY_DOCUMENT,
      },
    };
  },
});
