/**
 * dsh-quota-panel — draggable dual-state quota capsule with a position lock.
 */
export const name: 'quota-panel'
/** Only credentials is required; the data carrier is discovered at apply time
 * (the `connection` exact Fetch registry first — Web server and Desktop host —
 * then the `webServer` route table). */
export const inject: ['credentials']

export interface WindowLabels {
  rolling?: string
  weekly?: string
  monthly?: string
  /** (command-cost) label for the 5-hour window */
  fiveHour?: string
}

export interface BalanceTiers {
  /** total <= critical renders "建议充值" (error/red) */
  critical?: number
  /** total <= warn renders "余额紧张" (warn/amber) */
  warn?: number
  /** total <= healthy renders "余额正常", above renders "余额充足" */
  healthy?: number
}

export type ProviderFormat = 'deepseek-balance' | 'opencode-usage' | 'command-cost'

export interface ProviderConfig {
  /** Route id, also the row key (`/api/quota/<id>`); ^[a-z0-9-]+$ */
  id: string
  /** Provider name shown when expanded; standard long names are shortened. */
  label: string
  /** Credential reference, e.g. "DEEPSEEK_API_KEY" */
  credential: string
  /**
   * Endpoint to proxy (GET, Bearer auth). For "command-cost" this is the API
   * BASE (https://api.commandcode.ai), not a single route: the host walks
   * whoami → billing/credits + usage/summary and merges them.
   * Must be https; http is accepted for loopback hosts only.
   */
  endpoint: string
  /** Row renderer, default "deepseek-balance" */
  format?: ProviderFormat
  /** (deepseek-balance) balance level thresholds, defaults {10, 20, 50} */
  balanceTiers?: BalanceTiers
  /** Legacy alias for balanceTiers.warn */
  lowBalance?: number
  /** (opencode-usage | command-cost) labels for the windows */
  windowLabels?: WindowLabels
  /** (opencode-usage | command-cost) warn threshold, default 70; 0 <= warn < error <= 100 */
  warnPercent?: number
  /** (opencode-usage | command-cost) error threshold, default 90 */
  errorPercent?: number
  /** (command-cost) ISO code the credits are denominated in, default "USD" */
  currency?: string
}

export interface Config {
  /** Auto-refresh interval in ms, default 60000; 5000 <= refreshMs <= 86400000 */
  refreshMs?: number
  providers: ProviderConfig[]
}

/** Normalized body every `/api/quota/<id>` route answers with. */
export type RouteResponse =
  | { ok: true, data: unknown }
  | { ok: false, error: { code: 'credentials' | 'upstream' | 'timeout' | 'network' | 'invalid-body' | 'method', status?: number, message: string } }

export function apply(ctx: any, config?: Config): void
