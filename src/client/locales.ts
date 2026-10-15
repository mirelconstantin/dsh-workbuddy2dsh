/**
 * The `settings.workbuddy2dsh` locale dictionary.
 *
 * ENGLISH ONLY, and deliberately so: `en` holds the key set and the key type
 * is derived from it, so adding a string needs one edit rather than two. The
 * host's locale contract requires a `zh` seat to exist, and `zh` IS `en` here —
 * one set of strings, no second dictionary to drift.
 */

export const en = {
  title: 'WorkBuddy2API',
  description: 'Your WorkBuddy account as an OpenAI-compatible gateway: free and account-metered models, pool health and credit spend, in the composer.',

  // -- chip trigger ----------------------------------------------------------
  chipValueReady: '{free} free',
  chipValueEmpty: 'no models',
  chipValueOffline: 'not running',

  // -- chip tooltip ----------------------------------------------------------
  chipReady: '{free} free and {account} account model(s); {healthy}/{total} account(s) usable.',
  chipEmpty: 'The gateway is running but no model is available yet. Open the panel to add your WorkBuddy account.',
  chipOffline: 'The gateway is not answering',

  // -- chip panel ------------------------------------------------------------
  chipPanelTitle: 'WorkBuddy gateway',
  chipOpenPanel: 'Open management panel',
  chipPoolTitle: 'Account pool',
  chipPoolHealthy: '{healthy}/{total} usable',
  chipPoolCooling: '{n} cooling',
  chipPoolDisabled: '{n} disabled',
  chipSpent: 'Credits spent',
  chipGroupFree: 'Free now',
  chipGroupAccount: 'Account-metered',
  chipColPrice: 'Price',
  chipNoModels: 'No models advertised',
  chipRetry: 'Retry',
} as const

export type WorkbuddyKey = keyof typeof en

/** The `zh` seat the host's locale contract requires. */
export const zh = en
