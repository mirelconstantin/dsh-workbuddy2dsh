/**
 * dsh-workbuddy2dsh — browser half.
 *
 * Registers the gateway chip on the `conversation.composer.dock` slot, the
 * bottom bar of the composer, where it sits beside the ContextMeter. That is
 * the whole browser surface of this plugin: the settings card, the model picker
 * and the panel are all owned by DSH or by the gateway itself.
 *
 * The chip is registered on the main fiber, not under `configForms.whileServed`:
 * a settings page mounts only while the host serves this entry's namespace, and
 * a readout of "what can I use for free" is needed exactly when nobody is on a
 * settings page. Like every other registration it is an effect, so it dies with
 * the fiber.
 *
 * Export discipline: collaboration with the host goes through cordis services
 * (`slots`, `locale`). The bundle purity gate in tsdown.client.config.ts
 * forbids value imports of any @deepseek-ai package outside the platform module
 * table; type-only imports are erased and so are always fine.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls in the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: the ctx.slots Context merge, which the renderer plugin declares.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'

import { WorkbuddyChip } from './WorkbuddyChip.tsx'
import type { WorkbuddyKey } from './locales.ts'
import { en, zh } from './locales.ts'

export type { WorkbuddyChipProps } from './WorkbuddyChip.tsx'
export type { WorkbuddyKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The gateway chip's copy. */
    'settings.workbuddy2dsh': WorkbuddyKey
  }
}

/** Dictionary namespace owned by this plugin. */
export const NS = 'settings.workbuddy2dsh'

/** Where this sorts in the dock row: beside the ContextMeter, not over it. */
const ORDER = 20

/**
 * Required services (cordis fiber inject).
 *
 * `slots` to register the dock entry, `locale` for the chip's copy. Both are
 * stable services, so they gate the main fiber directly.
 */
export const inject = ['slots', 'locale']

/** Mount the chip. @param ctx - the browser plugin context. */
export function apply(ctx: ClientContext): void {
  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'workbuddy2dsh: chip copy')
  const slots = ctx.slots as unknown as {
    inject(name: string, callback: () => () => void): () => void
    register(options: Record<string, unknown>, component: unknown): () => void
  }
  ctx.effect(
    () => slots.inject('conversation.composer.dock', () => slots.register({
      name: 'conversation.composer.dock',
      id: 'workbuddy2dsh-gateway',
      order: ORDER,
      locale: NS,
      label: () => t('title' as WorkbuddyKey),
    }, WorkbuddyChip)),
    'workbuddy2dsh: gateway chip',
  )
}
