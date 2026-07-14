// codex app-server への接続を作る。2つの繋ぎ方を同じ形にまとめる。
//
//   spawn(既定) … `codex app-server` を子プロセスとして起こし、その stdin/stdout で
//                  JSON-RPC を喋る。gateway のプロセスだけで完結するので、外で
//                  デーモンを常駐させておく必要がない。落ちても次のターンで起こし直す。
//   socket      … 既に走っている app-server の unix socket に相乗りする(従来の動き)。
//                  profile の codex.socket を書いたときだけこちら。
//
// 認証はどちらも codex CLI が持っているもの(ChatGPT ログイン)をそのまま使う。
// SDK(@openai/codex-sdk)を使わないのは、こちらの MCP ツールを渡す dynamicTools が
// SDK 側に無いため。SDK 経由だと道具は「codex 側に登録された MCP」しか呼べず、
// キャラごとの道具の出し分けと channel の注入(誰に返すか)が効かなくなる。

import { type ChildProcess, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { CodexAppServer } from '#codex/codex/app-server.ts'
import { connectCodexDaemon, JsonLineRpcConnection } from '#codex/codex/rpc.ts'

export type CodexAppServerOptions = {
  /** 指定すると既存の app-server に繋ぐ。未指定なら自分で起こす。 */
  socketPath?: string
  /** codex 実行ファイル。launchd 起動だと PATH が細いので絶対パスで渡せるようにしてある。 */
  codexPath?: string
  log?: (message: string) => void
  /** 接続が切れた(子プロセスが落ちた等)ときに呼ばれる。呼び出し側は掴んだ handle を捨てること。 */
  onClosed?: () => void
}

export type CodexAppServerHandle = {
  server: CodexAppServer
  close(): Promise<void>
}

const noop = () => {}

// launchd から起動すると PATH が素になり、`codex` が見つからない。実体も見に行く
// (usage.ts の claudeBin と同じ理由・同じ形)。config の codex.path が最優先。
const resolveCodexPath = (explicit?: string): string => {
  if (explicit) return explicit
  if (process.env.CODEX_BIN) return process.env.CODEX_BIN
  const candidates = ['/opt/homebrew/bin/codex', '/usr/local/bin/codex', join(homedir(), '.local', 'bin', 'codex')]
  return candidates.find((path) => existsSync(path)) ?? 'codex'
}

export const startCodexAppServer = async (options: CodexAppServerOptions = {}): Promise<CodexAppServerHandle> => {
  const log = options.log ?? noop
  const onClosed = options.onClosed ?? noop

  if (options.socketPath) {
    const daemon: any = await connectCodexDaemon(options.socketPath)
    const server = new CodexAppServer(daemon.connection)
    void daemon.connection.closed?.then?.(() => onClosed())
    await server.initialize()
    return {
      server,
      close: async () => {
        try {
          await daemon.close?.()
        } catch {}
      },
    }
  }

  const command = resolveCodexPath(options.codexPath)
  log(`codex app-server を起動: ${command}`)
  let child: ChildProcess
  try {
    child = spawn(command, ['app-server'], { stdio: ['pipe', 'pipe', 'pipe'] })
  } catch (error: any) {
    throw new Error(`codex app-server を起動できない (${command}): ${error?.message ?? error}`)
  }

  let exited = false
  const killOnExit = () => {
    if (!exited) child.kill()
  }
  // gateway が落ちるときに app-server を道連れにする。放っておくと孤児が残る。
  process.once('exit', killOnExit)

  const cleanup = () => {
    exited = true
    process.off('exit', killOnExit)
  }

  // spawn は非同期に失敗する(ENOENT はここに来る)。initialize の待ちと競走させて、
  // 起動できなかったことをその場で分かる形にする。
  const failed = new Promise<never>((_resolve, reject) => {
    child.once('error', (error: any) => {
      cleanup()
      reject(new Error(`codex app-server を起動できない (${command}): ${error?.message ?? error}`))
    })
    child.once('exit', (code, signal) => {
      cleanup()
      onClosed()
      reject(new Error(`codex app-server が終了した (code=${code} signal=${signal})`))
    })
  })

  // codex は正常時にも stderr へログを吐く(memories の ERROR 行など)ので、
  // 落とさずに渡しておく。呼び出し側が log を渡さなければ捨てられる。
  child.stderr?.on('data', (chunk) => {
    const line = String(chunk).trim()
    if (line) log(`codex app-server: ${line.slice(0, 300)}`)
  })

  const connection = new JsonLineRpcConnection(child.stdout!, child.stdin!)
  const server = new CodexAppServer(connection)

  try {
    await Promise.race([server.initialize(), failed])
  } catch (error) {
    cleanup()
    child.kill()
    throw error
  }
  // 起動できたあとは、落ちたことを呼び出し側へ伝えるだけにする(reject は誰も待っていない)。
  failed.catch(() => {})

  return {
    server,
    close: async () => {
      cleanup()
      try {
        connection.close()
      } catch {}
      child.kill()
    },
  }
}
