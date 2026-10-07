/**
 * Host-facing re-export of the pricing core.
 *
 * The implementation lives in `pricing-core.mjs` because that exact file is also
 * served to the browser half; this module exists so Host code and the `.mjs`
 * verification scripts keep importing `./pricing.js` while there is still only
 * one copy of the rate table in the tree.
 *
 * @module dsh-cost-meter/pricing
 */

export {
  PRICING_REVISION,
  costOfCall,
  costOfTotals,
  formatCny,
  isPeak,
  pricedModels,
  resolveRates,
  roundUsd,
  usdToCny,
} from './pricing-core.mjs'
