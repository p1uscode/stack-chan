import { localize } from 'localization'
import type { Application as PiuApplication, Container as PiuContainer, Label as PiuLabel } from 'piu/MC'
import { Application, Column, Container, Label } from 'piu/MC'
import { ActionButton } from 'ui-controls'
import { UI, uiStyles } from 'ui-theme'

export type StartupSplashOptions = {
  message?: string
  onSettings?: () => void
}

export type WiFiConnectionStatusOptions = {
  attempt: number
  maxAttempts: number
  ssid?: string
  onRestart?: () => void
}

export type WiFiRecoveryChoiceOptions = {
  message: string
  onRetry?: () => void
  onOffline?: () => void
  onRestart?: () => void
}

let currentMessageLabel: PiuLabel | null = null
let currentActionArea: PiuContainer | null = null

function showActions(contents: PiuContainer[]) {
  if (!currentActionArea) return
  currentActionArea.empty()
  for (const content of contents) currentActionArea.add(content)
}

// 再起動ボタン。Wi-Fi の接続試行中〜失敗時は本体のメニュー(ドロワー)がまだ無く、
// 起動画面に出ている操作しか触れない。試行が長引くと(スキャン3回×3試行+manifest
// フォールバック)何分も何も押せない状態になるので、電源を抜かずに起動画面から
// やり直せる逃げ道として常に出しておく。上段に固定して接続中↔失敗で位置が動かない
// ようにする(下段は再試行/オフラインの一次操作)。
function restartAction(onRestart?: () => void): PiuContainer {
  return new ActionButton(
    {
      icon: 'restart',
      label: localize('splash.restart'),
      onTap: onRestart,
    },
    { top: 0, left: 86, width: 148 },
  )
}

function setMessage(message: string) {
  if (currentMessageLabel) currentMessageLabel.string = message
}

export function showStartupSplash(options: StartupSplashOptions = {}): PiuApplication {
  const styles = uiStyles()
  const messageLabel = new Label(null, {
    left: 12,
    right: 12,
    height: 28,
    string: options.message ?? localize('splash.starting'),
    style: styles.bodyMuted,
  })
  // 2段ぶん確保する(下段=一次操作、上段=再起動)。1段しか出さない画面でも各ボタンが
  // bottom:0 で下端に貼り付くので、見た目は従来どおり。
  const actionArea = new Container(null, {
    left: 0,
    right: 0,
    bottom: 12,
    height: UI.touchTarget * 2 + UI.space,
  })
  currentMessageLabel = messageLabel
  currentActionArea = actionArea

  const application = new Application(options, {
    commandListLength: 4096,
    displayListLength: 4096,
    touchCount: 1,
    skin: styles.screen,
    contents: [
      new Column(null, {
        left: 0,
        right: 0,
        top: 66,
        contents: [
          new Label(null, {
            left: 0,
            right: 0,
            height: 42,
            string: 'Stack-chan[・＿・]',
            style: styles.brand,
          }),
          messageLabel,
        ],
      }),
      actionArea,
    ],
  })

  showActions([
    new ActionButton(
      {
        icon: 'settings',
        label: localize('settings.title'),
        onTap: options.onSettings,
      },
      { left: 104, width: 112, bottom: 0 },
    ),
  ])
  return application
}

export function showWiFiConnectionStatus(options: WiFiConnectionStatusOptions): void {
  // 接続先SSIDが分かるときはそれを含む文言に切り替える(どのAPに繋ぎに行っているか
  // 起動画面で確認できるようにするfork由来の挙動)。語順と区切りは翻訳側に持たせたいので
  // ここで連結せず、SSID有無で別キーを引く。
  const values = { attempt: options.attempt, maxAttempts: options.maxAttempts, ssid: options.ssid ?? '' }
  setMessage(localize(options.ssid ? 'splash.connectingWithSsid' : 'splash.connecting', values))
  showActions(options.onRestart ? [restartAction(options.onRestart)] : [])
}

export function showWiFiRecoveryChoice(options: WiFiRecoveryChoiceOptions): void {
  setMessage(options.message)
  const actions = [
    new ActionButton(
      {
        icon: 'retry',
        label: localize('splash.retry'),
        onTap: options.onRetry,
      },
      { left: 8, width: 148, bottom: 0 },
    ),
    new ActionButton(
      {
        icon: 'offline',
        label: localize('splash.offline'),
        onTap: options.onOffline,
      },
      { left: 164, width: 148, bottom: 0 },
    ),
  ]
  // 再試行/オフラインの後ろに足す(既存の並び順に依存する呼び出し・テストを壊さない)。
  if (options.onRestart) actions.push(restartAction(options.onRestart))
  showActions(actions)
}
