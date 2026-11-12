/**
 * Host half of the Agent-preset text bundle.
 *
 * It owns exactly one settings namespace (`dsh-agent-preset-text`, the Loader
 * entry id) carrying the user's override document as a JSON string. All
 * interpretation lives in the Client half: the text this document rewrites is
 * only ever displayed in the browser, and the document is validated there
 * before it is written back.
 *
 * The field is volatile so an accepted write reaches the running plugin
 * without a Host restart, and the entry hides its generated settings page
 * because the Client half owns that surface.
 */
import z from '@deepseek-ai/schemastery';

/** Settings namespace owned by this plugin; equals this bundle's Loader entry id. */
const SETTINGS_NAMESPACE = 'dsh-agent-preset-text';

/** Stable Loader identity, exported for the build probe and the bundle patch check. */
const ENTRY_ID = SETTINGS_NAMESPACE;

/** Field carrying the override document. */
const CONFIG_FIELD = 'document';

/**
 * Live override document stored in the Host user-settings document.
 *
 * A string on purpose: the rule language is versioned JSON, its grammar is
 * owned by the Client half, and encoding it in a schema would reject values
 * the Client could still migrate or report on.
 */
const Config = z.object({
  [CONFIG_FIELD]: z.string().default('').volatile(),
});

/**
 * Register the settings ownership this plugin presents. The page itself is
 * the Client half's; this call keeps the entry in the settings document so
 * its value has one durable home, and suppresses the generated form.
 * @param ctx - Host plugin context.
 */
function apply(ctx) {
  ctx.inject(['settings'], (child) => {
    child.effect(() => child.settings.configure({ auto: false }, ctx.fiber));
  });
}

export { SETTINGS_NAMESPACE, ENTRY_ID, CONFIG_FIELD, Config, apply };
