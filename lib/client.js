/**
 * dsh-cost-meter, browser half.
 *
 * Renders one compact readout in the conversation composer dock — the ambient
 * strip below the composer card — directly to the RIGHT of the shipped
 * token/cache-hit stats pill: the account balance with a refresh button, and
 * what the current session has cost.
 *
 * Two data paths, deliberately separate:
 *   - COST is computed here from the `tokenUsage` session projection, which the
 *     Host already pushes to the client. No new transport, and it keeps working
 *     with the network down.
 *   - BALANCE and the exchange rate come from the Host's same-origin routes,
 *     because they touch the API key and the network. The key never reaches this
 *     side.
 *
 * The pricing core is `import()`ed from the Host route rather than duplicated
 * here, so a price is written down in exactly one place.
 *
 * This bundle is hand-written in the documented lazy-CJS factory form; it
 * requires only React and never touches a stylesheet or a UI-primitives package,
 * so it cannot fail on a module-table miss.
 */
window.__ModuleLoader__.load({
  id: 'dsh-cost-meter',
  factory: (require) => {
    const react = require('react')

    /** Host routes served by this plugin's node half. */
    const BALANCE_URL = '/cost-meter/balance'
    const PRICING_URL = '/cost-meter/pricing.js'

    /** Required client services: slot contribution and the namespace translator. */
    const inject = ['slots']

    /** How often the balance is re-read while a conversation stays open. */
    const POLL_MS = 5 * 60 * 1000
    /** Cadence of the peak/off-peak re-evaluation for the cost figure. */
    const CLOCK_MS = 30 * 1000

    /** Memoized pricing-core import; the promise is shared by every caller. */
    let pricingPromise

    /** Load the shared pricing core once, reporting a null on failure. */
    function loadPricing() {
      if (pricingPromise === undefined) {
        pricingPromise = import(PRICING_URL).catch((error) => {
          console.error('cost-meter: the pricing core failed to load', error)
          return null
        })
      }
      return pricingPromise
    }

    /** Read one JSON route, or a failure descriptor. */
    async function readJson(url) {
      try {
        const response = await fetch(url, { headers: { accept: 'application/json' } })
        if (!response.ok) return { ok: false, reason: 'http', message: `HTTP ${response.status}` }
        return await response.json()
      } catch (error) {
        return { ok: false, reason: 'network', message: String(error?.message ?? error) }
      }
    }

    /**
     * The session header readout.
     *
     * @param props - the render kit's session slot currency.
     * @returns the balance and cost line, or null while there is nothing yet to show.
     */
    function CostMeterAction({ sessionId, useProjection }) {
      const usage = useProjection('tokenUsage')
      const model = useProjection('modelSelection')

      const [pricing, setPricing] = react.useState(null)
      const [remote, setRemote] = react.useState(null)
      const [pending, setPending] = react.useState(false)
      const [opened, setOpened] = react.useState(false)
      const [now, setNow] = react.useState(() => Date.now())

      // The pricing core is needed before any figure can be shown.
      react.useEffect(() => {
        let live = true
        loadPricing().then((loaded) => {
          if (live) setPricing(loaded)
        })
        return () => {
          live = false
        }
      }, [])

      // Balance and rate: one read at mount, then at a slow cadence, plus the
      // explicit refresh. A cheap local clock re-evaluates the peak window.
      react.useEffect(() => {
        let live = true
        const read = async () => {
          setPending(true)
          const payload = await readJson(BALANCE_URL)
          if (!live) return
          setRemote(payload)
          setPending(false)
        }
        read()
        const poll = setInterval(read, POLL_MS)
        const clock = setInterval(() => setNow(Date.now()), CLOCK_MS)
        return () => {
          live = false
          clearInterval(poll)
          clearInterval(clock)
        }
      }, [])

      const refresh = react.useCallback(() => {
        setPending(true)
        readJson(BALANCE_URL)
          .then(setRemote)
          .catch(() => {})
          .finally(() => setPending(false))
      }, [])

      // The projection names the model as `lastUsed.model`; a session that has
      // not chosen one yet has nothing to price.
      const modelId = model?.lastUsed?.model

      // `tokenUsage` reaches the client as one FLAT object of the four disjoint
      // buckets (dsh-token-meter's wire view), not as a `{ totals }` wrapper.
      const projected = usage === undefined ? undefined : usage
      // Live rates when the Host could read the official page; otherwise the
      // served core prices from its own embedded table.
      const liveRates = remote?.liveRates?.ok === true ? remote.liveRates.rates : undefined
      const priced = pricing === null ? undefined : pricing.costOfTotals(projected, modelId, now, liveRates)
      const hasUsage = projected !== undefined && projected.uncachedInputTokens !== undefined

      const balance = remote?.balance
      const rate = remote?.rate
      const cny = priced !== undefined && rate?.ok === true ? pricing.usdToCny(priced.usd, rate.rate) : undefined

      // Nothing to say until the Host has answered or a cost exists; an ordinary
      // empty conversation does not grow a control it is not using. A failed
      // balance read still renders, so an outage is visible rather than silent.
      if (remote === null && priced === undefined) return null

      const parts = []

      if (balance === undefined) {
        parts.push('余额 读取中…')
      } else if (balance.ok === true) {
        const symbol = balance.primary.currency === 'CNY' ? '¥' : balance.primary.currency === 'USD' ? '$' : ''
        parts.push(`${symbol}${balance.primary.total.toFixed(2)}`)
      } else {
        parts.push(`余额不可用`)
      }

      if (priced !== undefined && pricing !== null) {
        parts.push(cny === undefined ? `本次 $${priced.usd.toFixed(4)}` : `本次 ¥${pricing.formatCny(cny)}`)
      } else if (hasUsage && modelId !== undefined && pricing !== null) {
        // An unpriceable model must not silently read as "free".
        parts.push('本次 ?')
      }

      const title = buildTitle({ pricing, priced, cny, balance, rate, projected, modelId, now, remote })

      // Parts are joined with the shipped separator span rather than one
      // concatenated string, so the divider picks up the same
      // `--dsw-alias-separator-primary` colour and 6px margins the stats pill
      // uses between its own segments.
      const children = []
      parts.forEach((part, index) => {
        if (index > 0) {
          children.push(
            react.createElement('span', { key: `sep-${index}`, style: SEP_STYLE, 'aria-hidden': true }, '·'),
          )
        }
        children.push(react.createElement('span', { key: `part-${index}`, style: LABEL_STYLE }, part))
      })
      children.push(
        react.createElement(
          'button',
          {
            type: 'button',
            onClick: refresh,
            disabled: pending,
            title: '刷新余额',
            'aria-label': '刷新余额',
            style: pending ? { ...BUTTON_STYLE, opacity: 0.5 } : BUTTON_STYLE,
            onMouseEnter: () => setOpened(true),
          },
          pending ? '⋯' : '↻',
        ),
      )

      return react.createElement(
        'div',
        { style: ROOT_STYLE, title },
        react.createElement('span', { style: PILL_STYLE }, children),
      )
    }

    /** Assemble the hover detail, stating every approximation rather than hiding it. */
    function buildTitle({ pricing, priced, cny, balance, rate, projected, modelId, now, remote }) {
      const lines = []

      if (balance === undefined) lines.push('余额：读取中…')
      else if (balance.ok === true) {
        lines.push(`余额 ${balance.primary.total.toFixed(2)} ${balance.primary.currency}（读取于 ${new Date(balance.fetchedAt).toLocaleTimeString()}）`)
        if (balance.primary.granted !== undefined && balance.primary.toppedUp !== undefined) {
          lines.push(`  赠送 ${balance.primary.granted.toFixed(2)} / 充值 ${balance.primary.toppedUp.toFixed(2)}`)
        }
        lines.push(`  账户可用：${balance.isAvailable ? '是' : '否'}`)
      } else {
        lines.push(`余额不可用：${balance.message}`)
      }

      if (rate !== undefined) {
        if (rate.ok === true) {
          const when = rate.publishedAt === undefined ? '' : `（汇率发布于 ${rate.publishedAt}）`
          lines.push(`汇率 ${rate.rate.toFixed(4)} CNY/USD${when}${rate.stale === true ? ' — 已过期，使用上次缓存' : ''}`)
        } else {
          lines.push(`汇率不可用：${rate.message}`)
        }
      }

      if (pricing === null) {
        lines.push('计价模块未能加载，本次花费无法计算')
      } else if (projected === undefined || projected.uncachedInputTokens === undefined) {
        lines.push('本次花费：本会话尚无用量记录')
      } else if (modelId === undefined) {
        lines.push('本次花费：尚未确定模型')
      } else if (priced === undefined) {
        lines.push(`本次花费：未配置 ${modelId} 的费率，故不显示金额（不按 0 计）`)
      } else {
        lines.push(`本次花费 $${priced.usd.toFixed(6)}${cny === undefined ? '' : ` = ¥${pricing.formatCny(cny)}`}`)
        lines.push(
          `  用量 命中 ${priced.tokens.cacheHitInput.toLocaleString('en-US')} / 未命中 ${priced.tokens.cacheMissInput.toLocaleString('en-US')} / 输出 ${priced.tokens.output.toLocaleString('en-US')}`,
        )
        lines.push(`  按${priced.peak ? '高峰' : '非高峰'}价计（现在 UTC ${new Date(now).toISOString().slice(11, 16)}）`)
        lines.push('  注意：会话投影只给总量、不含逐次调用时间，故整段按同一时段价计；跨峰谷边界的会话会因此有偏差。')
      }

      // Say where the prices came from, because a stale table and a live one
      // differ in trust and the difference must be visible, not implied.
      const live = remote?.liveRates
      if (live?.ok === true) {
        lines.push(`价格：实时读取于 ${new Date(live.fetchedAt).toLocaleString()}（模型 ${live.models.join(', ')}）${live.stale === true ? ' — 已过期，用上次成功读取' : ''}`)
      } else if (live === undefined) {
        lines.push(`价格：内嵌表，读取于 ${pricing.PRICING_REVISION.readOn}`)
      } else {
        lines.push(`价格：内嵌表，读取于 ${pricing.PRICING_REVISION.readOn}；实时页不可用（${live.reason}）`)
      }
      lines.push('点击 ↻ 立即刷新余额')
      lines.push('')
      lines.push('这是估算，不是账单：金额 = 官方费率 × 本地记录的 token 数。')
      lines.push('实测与余额实际降幅有约 14% 的未解释差额，故请以余额变化为准。')

      return lines.join('\n')
    }

    /**
     * Outermost element: a shrink-wrapped pill inside the composer dock's strip.
     *
     * Placement was settled by probing the live DOM, not by reading stylesheets.
     * The dock is
     * `.RlGAzG_dock{display:flex; flex-direction:row; flex-wrap:nowrap;
     * justify-content:center; gap:12px; max-width:100%}`, and line breaking is a
     * property of the CONTAINER: with `nowrap` there is no second line for an
     * occupant to move onto. The probe measured two wrong attempts: `width:100%`
     * merely filled the existing line, and `flex-basis:100%` made the dock WIDEN
     * to `stats + a full basis` (619px) instead of wrapping.
     *
     * So this element shrink-wraps and shares the strip, which is the use the
     * `conversation.composer.dock` slot documents for itself ("ambient entries
     * below the composer card", a list whose shipped occupant is the stats pill).
     *
     * Type size and colour come from the SAME tokens the shipped stats pill uses.
     * The packaged app's rule is
     * `.iq1doa_root{font-size:calc(var(--dsh-content-font-size-secondary,13px) - 1px); …}`
     * — one pixel SMALLER than the raw secondary token — so the subtraction is
     * mirrored here. Naming the tokens rather than inheriting them is deliberate:
     * inheritance would be a bet that this element is a direct child of the rule
     * declaring them, and the slot renderer inserts a `display:contents` wrapper
     * (confirmed by the probe), which happens to preserve inheritance today but is
     * not this plugin's contract to rely on.
     */
    const ROOT_STYLE = {
      display: 'inline-flex',
      alignItems: 'center',
      gap: '6px',
      padding: '1px 8px',
      borderRadius: '999px',
      maxWidth: '100%',
      minWidth: 0,
      flex: '0 1 auto',
      fontSize: 'calc(var(--dsh-content-font-size-secondary, 13px) - 1px)',
      lineHeight: 'calc(20px + var(--dsh-content-font-delta-secondary, 0px))',
      color: 'var(--dsw-alias-label-tertiary, #888)',
      whiteSpace: 'nowrap',
      cursor: 'default',
    }

    /**
     * The inner pill: keeps the shipped radius / padding shape and the hover
     * target as one unit inside the outer element.
     */
    const PILL_STYLE = {
      display: 'inline-flex',
      alignItems: 'center',
      gap: '6px',
      padding: '1px 8px',
      borderRadius: '999px',
      maxWidth: '100%',
      minWidth: 0,
    }

    const LABEL_STYLE = {
      fontVariantNumeric: 'tabular-nums',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      minWidth: 0,
    }

    /** The shipped stats pill's divider: separator colour, 6px either side. */
    const SEP_STYLE = {
      color: 'var(--dsw-alias-separator-primary, #ccc)',
      margin: '0 6px',
      flex: 'none',
    }

    /** The refresh affordance, sized to the 14px icon the sibling pills use. */
    const BUTTON_STYLE = {
      border: 'none',
      background: 'transparent',
      color: 'inherit',
      cursor: 'pointer',
      padding: '0',
      margin: '0',
      width: '16px',
      height: '16px',
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      fontSize: '13px',
      lineHeight: '16px',
      borderRadius: '50%',
      flex: 'none',
    }

    /**
     * Client plugin body: contribute the readout to the composer dock.
     *
     * The dock is the ambient strip below the composer card, where the shipped
     * token/cache-hit stats already live. Registering a NEW id adds a sibling
     * rather than replacing that cell, and `order` places it after the stats
     * pills (which register at order 0) — i.e. directly to their right.
     *
     * @param ctx - client root context.
     */
    function apply(ctx) {
      ctx.slots.inject('conversation.composer.dock', () =>
        ctx.slots.register(
          {
            name: 'conversation.composer.dock',
            id: 'cost-meter',
            order: 1,
          },
          CostMeterAction,
        ),
      )
    }

    return { apply, inject }
  },
})
