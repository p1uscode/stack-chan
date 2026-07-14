// 4サーバの一括起動(スーパーバイザ)
//   ./run.sh all
// 個別に上げたいときは従来どおり ./run.sh gateway など。
//
// - 各サーバは子プロセス。出力は [gateway] のように前置きして混ざっても読めるようにする
// - Ctrl-C (SIGINT/SIGTERM) で全部まとめて落とす
// - 既にポートを使っているサーバは「起動済み」とみなして飛ばす(二重起動で
//   EADDRINUSE を出さない)。個別起動したものが居ても all で残りを足せる

import { type ChildProcess, spawn } from 'node:child_process'
import { accessSync, rmSync } from 'node:fs'
import { connect } from 'node:net'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const TSX = join(ROOT, 'node_modules', '.bin', 'tsx')

// Codex の app-server(backend: 'codex-realtime' が使う)。TCP ではなく unix socket
// で待つので、ポートではなくソケットで生存確認する。既定パスは codex CLI の慣習に合わせる。
export const CODEX_SOCKET = process.env.CODEX_APP_SERVER_SOCKET ?? join(homedir(), '.codex', 'app-server-control', 'app-server-control.sock')

type Service = {
  name: string
  entry: string
  // 生存確認に使うポート。先頭を代表(これが埋まっていれば起動済みとみなす)。
  ports: number[]
}

const SERVICES: Service[] = [
  { name: 'gateway', entry: 'src/gateway/index.ts', ports: [8098, 8099, 8100] },
  { name: 'mcp', entry: 'src/mcp/index.ts', ports: [8097] },
  { name: 'search', entry: 'src/tools/search.ts', ports: [8093] },
  { name: 'docs', entry: 'src/tools/docs.ts', ports: [8095] },
]

const children = new Map<string, ChildProcess>()
let stopping = false

const portInUse = (port: number) =>
  new Promise<boolean>((resolve) => {
    const socket = connect({ port, host: '127.0.0.1' })
    const done = (used: boolean) => {
      socket.destroy()
      resolve(used)
    }
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
    socket.setTimeout(400, () => done(false))
  })

// 子の stdout/stderr を行単位で前置きして親へ流す。行の途中で chunk が切れても
// 崩れないよう、余りを持ち越す。
const pipePrefixed = (name: string, from: NodeJS.ReadableStream, to: NodeJS.WritableStream) => {
  let rest = ''
  from.on('data', (chunk) => {
    const lines = (rest + chunk).split('\n')
    rest = lines.pop() ?? ''
    for (const line of lines) to.write(`[${name}] ${line}\n`)
  })
  from.on('end', () => {
    if (rest) to.write(`[${name}] ${rest}\n`)
  })
}

const socketInUse = (path: string) =>
  new Promise<boolean>((resolve) => {
    const socket = connect({ path })
    const done = (used: boolean) => {
      socket.destroy()
      resolve(used)
    }
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
    socket.setTimeout(400, () => done(false))
  })

const hasCommand = (command: string) => {
  for (const dir of (process.env.PATH ?? '').split(':')) {
    if (!dir) continue
    try {
      accessSync(join(dir, command))
      return true
    } catch {}
  }
  return false
}

// codex app-server を子として起動する。TCP サービスと違い実体は codex CLI なので
// start() とは別立て。socket が残っているのに誰も待っていない場合は掃除してから上げる
// (残骸があると codex 側が起動を拒む)。
const startCodexAppServer = () => {
  const child = spawn('codex', ['app-server', '--listen', `unix://${CODEX_SOCKET}`], {
    cwd: ROOT,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  })
  children.set('codex', child)
  if (child.stdout) pipePrefixed('codex', child.stdout, process.stdout)
  if (child.stderr) pipePrefixed('codex', child.stderr, process.stderr)
  child.on('exit', (code, signal) => {
    children.delete('codex')
    // 会話バックエンドが codex-realtime のときだけ必要な補助プロセス。落ちても
    // gateway 全体は道連れにしない(他サービスは動き続ける)。
    if (!stopping) console.error(`[all] codex app-server が終了した (code=${code} signal=${signal})`)
  })
  child.on('error', (error) => console.error(`[all] codex app-server を起動できない: ${error}`))
}

const start = (service: Service) => {
  const env = { ...process.env }
  // search/docs は process.env.PORT を見る。親に PORT が居ると両方が同じポートを
  // 掴もうとするので、子には渡さない(各サーバの既定値を使わせる)。
  delete env.PORT

  // detached: 子(tsx)を自分のプロセスグループのリーダーにし、停止はグループごと
  // 送る(killTree)。tsx の先の実体(node)まで届かせないと、SIGKILL 打ち切り時に
  // 実体が孤児化してポートを掴み続け、次回起動が EADDRINUSE で死ぬ。
  const child = spawn(TSX, [service.entry], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
  children.set(service.name, child)
  if (child.stdout) pipePrefixed(service.name, child.stdout, process.stdout)
  if (child.stderr) pipePrefixed(service.name, child.stderr, process.stderr)

  child.on('exit', (code, signal) => {
    children.delete(service.name)
    if (!stopping) {
      console.error(`[all] ${service.name} が終了した (code=${code} signal=${signal})`)
      if (children.size === 0) process.exit(code ?? 1)
    }
  })
  child.on('error', (error) => {
    console.error(`[all] ${service.name} を起動できない: ${error}`)
  })
}

// 子のプロセスグループごとシグナルを送る(tsx ラッパーの先の実体まで届かせる)。
const killTree = (child: ChildProcess, signal: NodeJS.Signals) => {
  if (child.pid == null) return
  try {
    process.kill(-child.pid, signal)
  } catch {
    child.kill(signal)
  }
}

const stopAll = (signal: NodeJS.Signals) => {
  if (stopping) return
  stopping = true
  console.log(`\n[all] ${signal} — ${children.size}個を停止中`)
  for (const child of children.values()) killTree(child, signal)
  // 落ちきらない子は打ち切る
  const force = setTimeout(() => {
    for (const child of children.values()) killTree(child, 'SIGKILL')
    process.exit(0)
  }, 5000)
  force.unref()
  const wait = setInterval(() => {
    if (children.size === 0) {
      clearInterval(wait)
      process.exit(0)
    }
  }, 100)
}

process.on('SIGINT', () => stopAll('SIGINT'))
process.on('SIGTERM', () => stopAll('SIGTERM'))

for (const service of SERVICES) {
  const used = await Promise.all(service.ports.map(portInUse))
  if (used[0]) {
    console.log(`[all] ${service.name} は起動済み (:${service.ports[0]}) — 飛ばす`)
    continue
  }
  // 代表ポートは空きなのに残りが埋まっている = 前回の残骸が掴んでいる。起動しても
  // EADDRINUSE で即死するので、始末の仕方を案内して飛ばす。
  const busy = service.ports.filter((_, i) => used[i])
  if (busy.length > 0) {
    console.error(`[all] ${service.name} のポート :${busy.join(', :')} を別プロセスが掴んでいる — 飛ばす(lsof -nP -iTCP:${busy[0]} -sTCP:LISTEN で特定して kill)`)
    continue
  }
  console.log(`[all] ${service.name} を起動 (:${service.ports.join(', :')})`)
  start(service)
}

// codex app-server(backend: 'codex-realtime' 用)。codex CLI が入っていない環境では
// 黙って飛ばす — 他のバックエンド(ollama/claude)だけで使う構成を壊さないため。
if (!hasCommand('codex')) {
  console.log('[all] codex CLI が無い — codex app-server は飛ばす')
} else if (await socketInUse(CODEX_SOCKET)) {
  console.log(`[all] codex app-server は起動済み (${CODEX_SOCKET}) — 飛ばす`)
} else {
  for (const stale of [CODEX_SOCKET, `${CODEX_SOCKET.replace(/\.sock$/, '')}-startup.lock`, join(dirname(CODEX_SOCKET), 'app-server-startup.lock')]) {
    try {
      rmSync(stale)
    } catch {}
  }
  console.log(`[all] codex app-server を起動 (${CODEX_SOCKET})`)
  startCodexAppServer()
}

if (children.size === 0) {
  console.log('[all] 起動するものが無い(全部動いている)')
  process.exit(0)
}
