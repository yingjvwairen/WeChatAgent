const { withoutSocialTools, canonicalSocialTools, withoutDshIdentity } = await import(
  new URL('./social-tool-policy.mjs' + new URL(import.meta.url).search, import.meta.url)
);
import { WEB_READER_POLICY } from './web-reader-policy.mjs';
import { MODEL_SEARCH_POLICY } from './model-search.mjs';
import { FILE_TRANSFER_POLICY } from './file-transfers.mjs';
import { ASSISTANT_ACCESS } from './assistant-policy.mjs';
import { DSH_ACCESS_POLICY } from './dsh-access.mjs';
import { MEME_LIBRARY_POLICY } from './meme-library-policy.mjs';
import { MEMBER_MEMORY_POLICY } from './member-memory-policy.mjs';
import { HISTORY_POLICY } from './history-policy.mjs';
export const name = 'social-tool-restrict';
export const inject = ['tools'];
const policySymbols = [
  Symbol.for('wechatagent.extension-tools.v1'),
  WEB_READER_POLICY,
  MODEL_SEARCH_POLICY,
  DSH_ACCESS_POLICY,
  FILE_TRANSFER_POLICY,
  MEME_LIBRARY_POLICY,
  MEMBER_MEMORY_POLICY,
  HISTORY_POLICY,
];
const policies = ctx => policySymbols.map(symbol => ctx[symbol]).filter(Boolean);
const assistantAllowed = ctx => {
  try {
    return ctx[ASSISTANT_ACCESS]?.() !== false;
  } catch {
    return false;
  }
};
const visibleNames = ctx => new Set(assistantAllowed(ctx) ? policies(ctx).flatMap(policy => [...policy.names()]) : []);
const executorMarker = Symbol.for('wechatagent.scoped-tool-executor.v1');
const baseMarker = Symbol.for('wechatagent.scoped-tool-executor-base.v1');
const bindOwner = Symbol.for('wechatagent.scoped-tool-executor-bind.v1');

// DSH 0.2.x exposes the same-scope registration conflict as an untyped Error.
function registerDshExecutor(tools, wrapper, selected, owner, agent) {
  try {
    tools.setExecutor(wrapper);
  } catch (error) {
    const sameRegistration = agent && selected[bindOwner] && tools.selectExecutor(agent) === selected;
    if (!sameRegistration || error?.message !== 'Only one tool executor may be registered in each scope') throw error;
    selected[bindOwner](owner);
  }
}

// DSH 0.2.2 computes tool descriptions BEFORE its assembly callback and
// attaches them to the result afterwards. Bind before the first turn.
export function bindSocialToolExecutor(owner, agent) {
  const tools = owner.tools;
  if (
    typeof tools?.selectExecutor !== 'function' ||
    typeof tools.setExecutor !== 'function' ||
    Object.hasOwn(owner, executorMarker)
  )
    return;
  const selected = tools.selectExecutor(agent);
  const base = selected[baseMarker] ?? selected;
  let permissions = owner,
    agentContext = agent?.ctx;
  const allowedDefinitions = definitions => {
    const names = visibleNames(permissions);
    return definitions.filter(definition => names.has(definition.name));
  };
  const wrapper = {
    [baseMarker]: base,
    [bindOwner](ctx) {
      if (agentContext && agentContext !== ctx) throw Error('Social tool executor scope changed');
      agentContext = permissions = ctx;
    },
    describe(definitions) {
      const allowed = allowedDefinitions(definitions);
      const names = new Set(allowed.map(tool => tool.name));
      const description = base.describe(allowed);
      const schemas = description.schemas
        .filter(tool => names.has(tool.name))
        .map(({ deferLoading, ...schema }) => schema);
      return { ...description, schemas: canonicalSocialTools(schemas), knownNames: [...names].sort() };
    },
    execute: input => base.execute(input),
  };
  if (base.sections?.length)
    wrapper.sections = base.sections.map(section =>
      typeof section.text === 'function'
        ? { ...section, text: definitions => section.text(allowedDefinitions(definitions)) }
        : section,
    );
  registerDshExecutor(tools, wrapper, selected, owner, agent);
  Object.defineProperty(owner, executorMarker, { value: true, configurable: true });
}
export function apply(ctx) {
  const marker = Symbol.for('wechatagent.scoped-tool-guard.v1');
  if (Object.hasOwn(ctx, marker)) return;
  Object.defineProperty(ctx, marker, { value: true, configurable: true });
  ctx.tools.presentAs?.('native'); // Visibility and execution use the same live per-chat authorization below.
  bindSocialToolExecutor(ctx);
  ctx.tools.guard(exec => {
    const owner = exec?.agent?.ctx ?? ctx;
    return assistantAllowed(owner) && policies(owner).some(policy => policy.check(exec?.name))
      ? undefined
      : '微信群友会话不允许调用未授权工具';
  });
  ctx.on(
    'system-prompt/assemble',
    async (_assembly, context, next) => {
      const original = withoutDshIdentity(await next()),
        assembly = original.sections?.some(section => section.name === 'dsh-expression:companion')
          ? { ...original, sections: original.sections.filter(section => section.name !== 'dsh-expression:companion') }
          : original;
      if (!Array.isArray(assembly.tools)) return assembly;
      const names = visibleNames(context?.scope?.ctx ?? ctx);
      return names.size
        ? {
            ...assembly,
            tools: canonicalSocialTools(
              assembly.tools.filter(tool => names.has(tool.name)).map(({ deferLoading, ...tool }) => tool),
            ),
          }
        : withoutSocialTools(assembly);
    },
    { prepend: true },
  );
}
