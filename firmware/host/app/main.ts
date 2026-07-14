import loadPreferences, { loadPreferenceConfig } from 'loadPreference'
import { runContextCreatedBehaviors, type StackchanAppBehavior } from 'app-behavior'
import { resolveAppBehaviors } from 'app-behavior-resolver'
import defaultBehavior from 'app-default-behavior'
import { prepareAppLaunch } from 'app-launch'
import { type BootWiFiStatus, startHostBootServices } from 'boot-services'
import type { StackchanContext } from 'capabilities'
import { createStackchanContext, getHostDeviceEnvironment } from 'compose'
import { DOMAIN } from 'consts'
import { type StackchanDockRuntime, startStackchanDock } from 'dock'
import { prepareExperimentalMiniApps, registerExperimentalMiniApps } from 'experimental-mini-app-loader'
import { initializeLocalization } from 'localization'
import Modules from 'modules'
import { showWiFiConnectionStatus, showWiFiRecoveryChoice } from 'startup-splash'
import Timer from 'timer'
import { applyTimezone } from 'timezone-settings'

type DeviceButton = {
  onChanged: (this: DeviceButton) => void
}

type GlobalEnvironment = {
  button?: Partial<Record<'a' | 'c', DeviceButton>>
}

const globalEnv = globalThis as typeof globalThis & GlobalEnvironment
const noopButtonHandler = () => undefined

function installPlatformInputBridge(): void {
  if (!Modules.has('wasm-button-bridge')) return
  const bridge = Modules.importNow('wasm-button-bridge') as { installWasmButtons?: () => void }
  bridge.installWasmButtons?.()
  trace('[main] installed WASM button bridge\n')
}

function loadAppBehaviors(): StackchanAppBehavior[] {
  trace('[main] checking mod override\n')
  return resolveAppBehaviors(Modules, defaultBehavior)
}

// 起動画面からの再起動。Wi-Fi の接続試行中と失敗時はまだ本体のメニュー(ドロワー)が
// 無く、電源を抜く以外に抜け出す手段が無かったので、起動画面のボタンから叩けるようにする。
// 'system'(ecma-419 io)は esp32 の io manifest が preload するが、載っていない
// ターゲット(シミュレータ等)もあるので has() で確認してから読む。
function restartDevice(): void {
  try {
    const env = globalThis as typeof globalThis & { System?: { restart?: () => void } }
    // esp32 の io manifest は 'system' を preload するので普段は globalThis.System が既にある。
    // preload されないターゲット向けに importNow でも取りに行く。
    if (!env.System?.restart && Modules.has('system')) Modules.importNow('system')
    if (!env.System?.restart) {
      trace('[main] restart unavailable (no System.restart)\n')
      return
    }
    trace('[main] restarting by user request\n')
    env.System.restart()
  } catch (error) {
    trace(`[main] restart failed ${error instanceof Error ? error.message : String(error)}\n`)
  }
}

// 誰も選ばなかったときに自分でやり直すまでの時間。
//
// **待ち続けてはいけない。**この Promise が解決するまで main は Wi-Fi の前で止まって
// おり、アプリの文脈も MOD も起動しない。電源投入時に AP がまだ起きていなかった、
// 一瞬圏外だった、というだけで**以後ずっと無接続のまま**になり、手でリセットする
// までサーバに現れない(2026-08-10 に実際にそうなった: 電源は入っているのに
// gateway に hello が一度も来ず、リセットしたら即繋がった)。
// 人が居るとは限らない機体なので、既定は「黙って繋ぎ直し続ける」でなければならない。
// ボタンを押せば即座にそちらが勝つので、手動の選択を奪ってはいない。
const BOOT_WIFI_AUTO_RETRY_MS = 30000

function waitForBootWiFiRecoveryChoice(status: BootWiFiStatus & { reason: string }): Promise<'retry' | 'offline'> {
  return new Promise((resolve) => {
    let resolved = false
    const previousAHandler = globalEnv.button?.a?.onChanged
    const previousCHandler = globalEnv.button?.c?.onChanged
    let autoRetryTimer: ReturnType<typeof Timer.set> | undefined

    const restoreButtons = () => {
      if (globalEnv.button?.a) {
        globalEnv.button.a.onChanged = previousAHandler ?? noopButtonHandler
      }
      if (globalEnv.button?.c) {
        globalEnv.button.c.onChanged = previousCHandler ?? noopButtonHandler
      }
    }
    const choose = (choice: 'retry' | 'offline') => {
      if (resolved) return
      resolved = true
      if (autoRetryTimer != null) {
        Timer.clear(autoRetryTimer)
        autoRetryTimer = undefined
      }
      restoreButtons()
      resolve(choice)
    }

    autoRetryTimer = Timer.set(() => {
      autoRetryTimer = undefined
      trace('[network] no choice made, retrying Wi-Fi automatically\n')
      choose('retry')
    }, BOOT_WIFI_AUTO_RETRY_MS)

    trace(`[network] ${status.message}: ${status.reason}\n`)
    showWiFiRecoveryChoice({
      message: status.message,
      onRetry: () => choose('retry'),
      onOffline: () => choose('offline'),
      onRestart: restartDevice,
    })
    if (globalEnv.button?.a) {
      globalEnv.button.a.onChanged = () => choose('retry')
    }
    if (globalEnv.button?.c) {
      globalEnv.button.c.onChanged = () => choose('offline')
    }
  })
}

async function main() {
  trace('[main] start\n')
  let dockRuntime: StackchanDockRuntime | undefined
  let context: StackchanContext | undefined
  try {
    dockRuntime = startStackchanDock(Modules)
    if (dockRuntime) trace('[main] Stackchan Dock started\n')
    installPlatformInputBridge()
    initializeLocalization(loadPreferences(DOMAIN.ui).language)
    applyTimezone(loadPreferences(DOMAIN.time).timezone)

    trace('[main] loading app behaviors\n')
    const appBehaviors = loadAppBehaviors()
    // Launch behaviors run before startHostBootServices so the splash screen is
    // visible while network setup blocks.
    const launch = await prepareAppLaunch(appBehaviors, prepareExperimentalMiniApps)
    trace(`[main] onLaunch shouldCreateContext=${launch.shouldCreateContext}\n`)
    if (!launch.shouldCreateContext) {
      const unownedDock = dockRuntime
      dockRuntime = undefined
      unownedDock?.close()
      return
    }
    const experimentalMiniApps = launch.prepared

    const bootServices = startHostBootServices({
      wifi: {
        onStatusChanged: (status) => showWiFiConnectionStatus({ ...status, onRestart: restartDevice }),
        promptRecoveryChoice: waitForBootWiFiRecoveryChoice,
      },
    })
    const networkReady = await bootServices.connectivity.network.ready
    trace(`[main] network ready: ${networkReady.status}\n`)
    const preferences = loadPreferenceConfig()
    const ownedDock = dockRuntime
    context = createStackchanContext(preferences, {
      connectivity: bootServices.connectivity,
      remoteConversationSession: ownedDock?.remoteConversationSession,
      closeHandlers: ownedDock ? [() => ownedDock.close()] : undefined,
    })
    ownedDock?.onContextCreated(context)
    registerExperimentalMiniApps(experimentalMiniApps, context.ui.miniApps)
    trace('[main] app context created\n')
    await runContextCreatedBehaviors(appBehaviors, context, {
      device: getHostDeviceEnvironment(),
      config: preferences,
    })
    trace('[main] app behaviors ready\n')
  } catch (error) {
    try {
      if (context) await context.lifecycle.close()
      else dockRuntime?.close()
    } catch (closeError) {
      trace(`[main] cleanup error ${closeError instanceof Error ? closeError.message : String(closeError)}\n`)
    }
    throw error
  }
}

main().catch((error) => {
  trace(`[main] error ${error?.message ?? error}\n`)
})
