/**
 * The WorkBuddy gateway chip in the composer dock (the bottom bar).
 *
 * It answers, in one click, the three questions a user of this plugin has while
 * typing: is the gateway up, what can I use for free right now, and what am I
 * spending. Clicking opens a panel with the pool health, the credit total, and
 * the catalogue split into the free and account-metered lanes the plugin
 * publishes — plus a link to the gateway's own management panel, which is where
 * an account gets added.
 *
 * It reads the plugin's own status route (see src/web-route.mjs), so the
 * browser never sees the gateway's API key or its loopback port. The route
 * answers same-origin from DSH's web server.
 *
 * The trigger, panel and dismissal follow the ContextMeter, the control this
 * chip sits beside in the dock row: a real <button> with aria-haspopup, a
 * portaled panel anchored above the bar, outside-pointer and Escape dismissal.
 * Matching it is the point — anything invented here reads as a stranger in the
 * one row where it would be most visible.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  IconGlobeOutlineRegular,
  Tooltip,
  useAnchoredPosition,
  useDismissOnOutsidePointer,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'

import {
  chipHealth,
  chipTitle,
  chipValue,
  priceLine,
  resolve,
  type ChipState,
  type ModelRow,
  type StatusView,
} from './chip-readout.ts'
import type { WorkbuddyKey } from './locales.ts'
import styles from './chip.module.css'

/** Props the composer dock binds: the locale kit, nothing else. */
export type WorkbuddyChipProps = PropsLocale<'settings.workbuddy2dsh'>

/** The status route this plugin's runtime registers. Same-origin, no key. */
const BRIDGE_PREFIX = '/api/workbuddy2dsh'

/** How often the readout refreshes while the composer is mounted. */
const POLL_MS = 15_000

/** How many models each lane shows before it is summarised instead. */
const ROWS_PER_LANE = 8

async function readStatus(): Promise<StatusView | null> {
  try {
    const response = await fetch(`${BRIDGE_PREFIX}/status`, {
      signal: AbortSignal.timeout(8000),
    })
    if (!response.ok) return null
    return (await response.json()) as StatusView
  } catch {
    // A stopped host answers nothing; the chip keeps its last read and the
    // offline state on the next tick says why.
    return null
  }
}

/** One model row: its name, its lane, and what it costs right now. */
function ModelLine({ row }: { row: ModelRow }): React.ReactElement {
  const price = priceLine(row)
  return (
    <div className={styles.chipRow}>
      <span className={styles.chipRowLabel}>
        <span className={styles.chipRowName}>{row.name || row.id}</span>
        {price.label !== '' && <span className={styles.chipRowSub}>{price.label}</span>}
      </span>
      <span className={styles.chipPrice}>
        {price.struck !== null && <span className={styles.chipPriceWas}>{price.struck}</span>}
        <span className={price.current === '0.00' ? styles.chipPriceFree : styles.chipPriceNow}>
          {price.current}
        </span>
      </span>
    </div>
  )
}

/** A lane of models, summarised when it is longer than the panel can show. */
function Lane({ title, rows }: { title: string; rows: ModelRow[] }): React.ReactElement {
  const shown = rows.slice(0, ROWS_PER_LANE)
  const rest = rows.length - shown.length
  return (
    <>
      <div className={styles.chipGroupLabel}>
        {title} · {rows.length}
      </div>
      {shown.map((row) => <ModelLine key={row.id} row={row} />)}
      {rest > 0 && <div className={styles.chipEmpty}>+{rest} more in the picker</div>}
    </>
  )
}

export function WorkbuddyChip(props: WorkbuddyChipProps): React.ReactElement | null {
  const { t } = props
  const [status, setStatus] = useState<StatusView | null>(null)
  const [state, setState] = useState<ChipState | null>(null)
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLSpanElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)

  const apply = useCallback((next: StatusView) => {
    setStatus(next)
    setState(resolve(next))
  }, [])

  useEffect(() => {
    let live = true
    const tick = (): void => {
      void readStatus().then((read) => {
        if (live && read !== null) apply(read)
      })
    }
    tick()
    const timer = setInterval(tick, POLL_MS)
    return () => {
      live = false
      clearInterval(timer)
    }
  }, [apply])

  // Escape closes the panel, matching the ContextMeter's.
  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [open])

  const position = useAnchoredPosition({ open, anchorRef: rootRef, panelRef, side: 'top', gap: 8, margin: 12 })
  useDismissOnOutsidePointer(rootRef, open, setOpen, panelRef)

  // Nothing has answered yet: DSH may still be starting, and a chip that reads
  // "not running" during boot would be wrong in the one direction that matters.
  // It appears once there is a real reading.
  if (state === null) return null

  const title = chipTitle(status ?? unreachableStub, state, t as (k: string, p?: Record<string, string | number>) => string)
  const value = chipValue(state, t as (k: string, p?: Record<string, string | number>) => string)
  const health = chipHealth(state)
  const pool = status?.pool
  const spent = status?.creditsSpent ?? 0

  return (
    <span ref={rootRef} className={styles.chipRoot} data-composer-workbuddy={true}>
      <Tooltip label={title} side="top" delayMs={200} disabled={open}>
        <button
          type="button"
          className={styles.chipTrigger}
          data-health={health}
          aria-label={title}
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          <IconGlobeOutlineRegular className={styles.chipIcon} data-health={health} aria-hidden={true} />
          <span>{value}</span>
        </button>
      </Tooltip>
      {open && status !== null && createPortal(
        <div
          ref={panelRef}
          className={styles.chipPanel}
          role="dialog"
          aria-label={t('chipPanelTitle' as WorkbuddyKey)}
          style={position ?? { visibility: 'hidden', left: 0, top: 0 }}
        >
          <div className={styles.chipPanelHead}>
            <span className={styles.chipPanelTitle}>{t('chipPanelTitle' as WorkbuddyKey)}</span>
            {pool !== undefined && state.mode !== 'offline' && (
              <span className={styles.chipFigures}>
                {t('chipPoolHealthy' as WorkbuddyKey, { healthy: pool.healthy, total: pool.total })}
              </span>
            )}
          </div>

          {state.mode === 'offline' && (
            <div className={styles.chipOfflineNote}>
              {title}
            </div>
          )}

          {state.mode === 'empty' && <div className={styles.chipEmpty}>{t('chipEmpty' as WorkbuddyKey)}</div>}

          {state.mode !== 'offline' && (
            <div className={styles.chipFacts}>
              {pool !== undefined && pool.cooling > 0 && (
                <span className={styles.chipFact}>
                  <span className={styles.chipFactValue}>{pool.cooling}</span>
                  {t('chipPoolCooling' as WorkbuddyKey, { n: pool.cooling })}
                </span>
              )}
              {pool !== undefined && pool.disabled > 0 && (
                <span className={styles.chipFact}>
                  <span className={styles.chipFactValue}>{pool.disabled}</span>
                  {t('chipPoolDisabled' as WorkbuddyKey, { n: pool.disabled })}
                </span>
              )}
              {spent > 0 && (
                <span className={styles.chipFact}>
                  {t('chipSpent' as WorkbuddyKey)}
                  <span className={styles.chipFactValue}>{spent.toFixed(2)}</span>
                </span>
              )}
            </div>
          )}

          {state.mode === 'ready' && (
            <>
              {status!.freeModels.length > 0 && (
                <Lane title={t('chipGroupFree' as WorkbuddyKey)} rows={status!.freeModels} />
              )}
              {status!.accountModels.length > 0 && (
                <Lane title={t('chipGroupAccount' as WorkbuddyKey)} rows={status!.accountModels} />
              )}
            </>
          )}

          {status!.panelUrl !== '' && (
            <a
              className={styles.chipPanelLink}
              href={status!.panelUrl}
              target="_blank"
              rel="noreferrer noopener"
            >
              {t('chipOpenPanel' as WorkbuddyKey)}
            </a>
          )}
        </div>,
        document.body,
      )}
    </span>
  )
}

/** A stand-in so the title can be computed before the first read lands. */
const unreachableStub: StatusView = {
  reachable: false,
  error: '',
  panelUrl: '',
  pool: { total: 0, healthy: 0, cooling: 0, disabled: 0 },
  freeModels: [],
  accountModels: [],
  creditsSpent: 0,
  at: 0,
}
