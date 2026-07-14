import {
  type BootWiFiRecoveryChoice,
  bootWiFiFailureMessage,
  networkReadyResultForRecoveryChoice,
  shouldRetryBootWiFiAttempt,
} from 'boot-network-recovery'
import type { NetworkReadyResult } from 'capabilities'
import { DOMAIN } from 'consts'
import { createLocalPeerCapability } from 'local-peer-capability'
import type { LocalPeerCapability } from 'local-peer-types'
import { localize } from 'localization'
import config from 'mc/config'
import Preference from 'preference'
import { wait } from 'stackchan-util'
import { connectStoredWiFi, readStoredWiFiPreference, stopStoredWiFiConnection } from 'stored-wifi'

export type { NetworkReadyResult } from 'capabilities'

export type HostBootServices = {
  connectivity: {
    network: {
      ready: Promise<NetworkReadyResult>
    }
    localPeer?: LocalPeerCapability
  }
}

export type BootWiFiStatus = {
  attempt: number
  maxAttempts: number
  message: string
  ssid?: string
}

export type HostBootServicesOptions = {
  wifi?: {
    maxAttempts?: number
    retryDelayMs?: number
    onStatusChanged?: (status: BootWiFiStatus) => void
    promptRecoveryChoice?: (status: BootWiFiStatus & { reason: string }) => Promise<BootWiFiRecoveryChoice>
  }
}

const NOT_STARTED: NetworkReadyResult = {
  status: 'skipped',
  reason: 'host boot services not started',
}
const DEFAULT_BOOT_WIFI_MAX_ATTEMPTS = 4
// 失敗のたびに WiFi ドライバを close して作り直すので、間隔が短いと無線が立ち上がり
// きらないうちに次を叩いて連続失敗する(500ms では実機で「リトライも全部だめ」が
// 頻発した)。落ち着かせる時間を取る。
const DEFAULT_BOOT_WIFI_RETRY_DELAY_MS = 2500

let bootServices: HostBootServices = {
  connectivity: {
    network: {
      ready: Promise.resolve(NOT_STARTED),
    },
  },
}

export function startHostBootServices(options: HostBootServicesOptions = {}): HostBootServices {
  const networkReady = startStoredWiFi(options.wifi)
  const localPeer = createLocalPeerCapability()
  bootServices = {
    connectivity: {
      network: {
        ready: networkReady,
      },
      localPeer,
    },
  }
  return bootServices
}

export function getHostBootServices(): HostBootServices {
  return bootServices
}

async function startStoredWiFi(
  options: NonNullable<HostBootServicesOptions['wifi']> = {},
): Promise<NetworkReadyResult> {
  const maxAttempts = options.maxAttempts ?? DEFAULT_BOOT_WIFI_MAX_ATTEMPTS
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_BOOT_WIFI_RETRY_DELAY_MS
  for (;;) {
    let lastReason = 'connection failed'
    // Show which SSID we're joining on the boot screen, not just "connecting".
    const bootSsid = primaryBootSsid()
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      options.onStatusChanged?.({
        attempt,
        maxAttempts,
        message: localize('splash.connecting', { attempt, maxAttempts }),
        ssid: bootSsid,
      })
      // 1回目だけスキャンしてから繋ぐ(圏外なら早く諦めて manifest フォールバックへ
      // 回すため)。2回目以降はスキャンせず直接 connect する — 実測で多い失敗が
      // 「スキャンでAPを見つけた直後の association が即 disconnect」で、スキャン直後の
      // 無線状態が原因と見られるため。直接 connect なら esp_wifi_connect が内部で
      // 選局するので、この経路を踏まない。
      const result = await connectStoredWiFiOnce(getBootWiFiCredentials(), { scanBeforeConnect: attempt === 1 })
      if (result.status !== 'failed') {
        return result
      }
      lastReason = result.reason
      trace(`[network] boot Wi-Fi attempt ${attempt}/${maxAttempts} failed: ${lastReason}\n`)
      if (shouldRetryBootWiFiAttempt(attempt, maxAttempts)) {
        await wait(retryDelayMs)
      }
    }

    // The persisted/primary network failed every attempt. Before dropping to the
    // recovery prompt, try each manifest network once (internal first, as listed),
    // skipping the one just tried — so a device persisted to an out-of-range
    // network (e.g. mobile still persisted after returning to the internal LAN) recovers to a configured one.
    const fallback = await tryManifestNetworkFallback(primaryBootSsid(), options)
    if (fallback.status === 'connected') {
      return fallback
    }
    // 'failed' → carry its reason to the prompt; 'skipped' (no fallback network) →
    // keep the primary failure reason.
    if (fallback.status === 'failed') {
      lastReason = fallback.reason
    }

    const message = bootWiFiFailureMessage(lastReason)
    if (!options.promptRecoveryChoice) {
      return { status: 'failed', reason: lastReason }
    }
    const choice = await options.promptRecoveryChoice({
      attempt: maxAttempts,
      maxAttempts,
      message,
      reason: lastReason,
    })
    const result = networkReadyResultForRecoveryChoice(choice, lastReason)
    if (result) {
      trace(`[network] ${result.reason}\n`)
      return result
    }
    trace('[network] retrying Wi-Fi by user request\n')
  }
}

function connectStoredWiFiOnce(
  credentials: { ssid?: string; password?: string } = getBootWiFiCredentials(),
  { scanBeforeConnect = true }: { scanBeforeConnect?: boolean } = {},
): Promise<NetworkReadyResult> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (result: NetworkReadyResult) => {
      if (settled) return
      settled = true
      if (result.status !== 'connected') {
        stopStoredWiFiConnection()
      }
      resolve(result)
    }

    try {
      stopStoredWiFiConnection()
      const started = connectStoredWiFi({
        ...credentials,
        scanBeforeConnect,
        // 15秒だと DHCP が混んでいるときに取りこぼす(実測で connection timeout が出た)。
        // 一過性切断の繋ぎ直しもこの予算の中で行われるので、少し長めに取る。
        connectionTimeoutMs: 25000,
        onConnected: () => finish({ status: 'connected' }),
        onError: (reason) => {
          const message = reason ?? 'connection failed'
          trace(`[network] connection failed: ${message}\n`)
          finish({ status: 'failed', reason: message })
        },
      })
      if (!started) {
        finish({ status: 'skipped', reason: 'missing Wi-Fi credentials' })
      }
    } catch (error) {
      const message = error && typeof error === 'object' && 'message' in error ? String(error.message) : String(error)
      trace(`[network] connection failed: ${message}\n`)
      finish({ status: 'failed', reason: message })
    }
  })
}

function getBootWiFiCredentials(): { ssid?: string; password?: string } {
  // A network chosen at runtime (persisted to Preference) wins over the manifest,
  // so a menu selection survives reboots. connectStoredWiFi falls back to the
  // stored values when we return no ssid here.
  if (readStoredWiFiPreference('ssid').length > 0) {
    return {}
  }
  const first = bootWiFiNetworks()[0]
  return { ssid: first?.ssid, password: first?.password }
}

// All manifest Wi-Fi networks, in listed order, with a usable ssid. `config.networks`
// is the multi-network form (internal/external roaming); `config.wifi` is the
// single-network form and stays supported for manifests that only set that.
function bootWiFiNetworks(): { ssid: string; password: string }[] {
  const bootConfig = config as {
    networks?: { ssid?: unknown; password?: unknown }[]
    wifi?: { ssid?: unknown; password?: unknown }
  }
  const source = Array.isArray(bootConfig.networks) ? bootConfig.networks : [bootConfig.wifi ?? {}]
  return source
    .map((n) => ({
      ssid: typeof n.ssid === 'string' ? n.ssid : '',
      password: typeof n.password === 'string' ? n.password : '',
    }))
    .filter((n) => n.ssid.length > 0)
}

// The ssid the primary attempt loop used: the persisted one, else manifest[0].
function primaryBootSsid(): string {
  const persisted = readStoredWiFiPreference('ssid')
  if (persisted.length > 0) return persisted
  return bootWiFiNetworks()[0]?.ssid ?? ''
}

// Try each manifest network once (skipping `skipSsid`, already attempted). On the
// first success, persist it so the mod's profile selection matches the connected
// network and future boots use it. Returns 'skipped' when there is nothing to try.
async function tryManifestNetworkFallback(
  skipSsid: string,
  options: NonNullable<HostBootServicesOptions['wifi']>,
): Promise<NetworkReadyResult> {
  const candidates = bootWiFiNetworks().filter((n) => n.ssid !== skipSsid)
  if (candidates.length === 0) {
    return { status: 'skipped', reason: 'no fallback network' }
  }
  let lastReason = 'no fallback network'
  for (const net of candidates) {
    // フォールバックは候補を1本ずつ1回だけ試すので (1/1)。SSIDは必ず分かるので
    // splash 側が出すのと同じ SSID 入りの文言を渡す。
    const status = { attempt: 1, maxAttempts: 1, ssid: net.ssid }
    options.onStatusChanged?.({ ...status, message: localize('splash.connectingWithSsid', status) })
    trace(`[network] fallback trying ${net.ssid}\n`)
    const result = await connectStoredWiFiOnce(net)
    if (result.status === 'connected') {
      Preference.set(DOMAIN.wifi, 'ssid', net.ssid)
      Preference.set(DOMAIN.wifi, 'password', net.password)
      trace(`[network] fallback connected to ${net.ssid}; persisted\n`)
      return result
    }
    if (result.status === 'failed') {
      lastReason = result.reason
    }
  }
  return { status: 'failed', reason: lastReason }
}
