/**
 * Host-half contract probe for the Agent-preset text bundle.
 *
 * The Host half owns one settings namespace carrying the JSON rule document and
 * registers nothing else: every display effect happens in the browser. What is
 * worth asserting here is the identity the settings document is keyed by
 * (renaming it orphans what the user saved), the field name inside that
 * document, and the fact that the document survives validation byte for byte —
 * the Client half, not a schema, owns its grammar.
 *
 * @module scripts/host-contract
 */
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { runProbe } from './lib/probe-runner.mjs';

/**
 * Assert the Host-half contract.
 * @param context - `{ root, patchId, check }`.
 * @returns `{ identity }` — the settings namespace, compared against the bundle patch id.
 */
export async function probeHost({ root, patchId, check }) {
  const mod = await import(pathToFileURL(join(root, 'index.js')).href);

  check('exports apply()', typeof mod.apply === 'function');
  check('exports Config', typeof mod.Config === 'function');
  check('SETTINGS_NAMESPACE is the Loader entry id', mod.SETTINGS_NAMESPACE === 'dsh-agent-preset-text', `${mod.SETTINGS_NAMESPACE} — the entry id is also the settings-document key, so renaming it orphans every saved rule document`);
  check('ENTRY_ID names the same entry', mod.ENTRY_ID === mod.SETTINGS_NAMESPACE, `${mod.ENTRY_ID} vs ${mod.SETTINGS_NAMESPACE}`);
  check('CONFIG_FIELD is the document field', mod.CONFIG_FIELD === 'document', `${mod.CONFIG_FIELD} — the field name is the key inside the settings document`);

  const empty = mod.Config({});
  check('Config materializes the volatile document field', typeof empty?.document?.get === 'function');
  check('document defaults to the empty string', empty?.document?.get() === '', JSON.stringify(empty?.document?.get()));
  const document = '{"version":1,"enabled":true,"rules":[]}';
  const filled = mod.Config({ document });
  check('document round-trips through validation untouched', filled?.document?.get() === document, JSON.stringify(filled?.document?.get()));

  const calls = [];
  const fiber = { name: 'fiber' };
  const ctx = {
    fiber,
    inject(dependencies, callback) {
      calls.push(['inject', dependencies]);
      callback({
        effect(callback2) {
          calls.push(['effect']);
          return callback2();
        },
        settings: {
          configure(options, owner) {
            calls.push(['configure', options, owner]);
            return () => {};
          },
        },
      });
    },
  };
  mod.apply(ctx);
  check('apply() injects the settings service', JSON.stringify(calls[0]) === JSON.stringify(['inject', ['settings']]), JSON.stringify(calls[0]));
  check('apply() configures the namespace with auto:false and its own fiber', calls.some((call) => call[0] === 'configure' && call[1].auto === false && call[2] === fiber), JSON.stringify(calls));

  return { identity: mod.SETTINGS_NAMESPACE };
}

runProbe(import.meta.url, probeHost);
