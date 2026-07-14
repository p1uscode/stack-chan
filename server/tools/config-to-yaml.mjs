// gateway.config.json を YAML に移す一度きりの道具。
//
//   node server/tools/config-to-yaml.mjs [設定ディレクトリ]
//
// 変換した .json は .json.migrated へ退避する(消さない)。既に .yaml があれば何もしない。
// YAML は JSON の上位互換なので、読めることは変換後に parse し直して確かめる。
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse, stringify } from 'yaml'

const dir = process.argv[2] ?? join(process.cwd(), 'config')
const OPTS = { lineWidth: 0, blockQuote: 'literal' }

for (const base of ['gateway.config', 'gateway.secret', 'gateway.config.example']) {
  const json = join(dir, `${base}.json`)
  const yaml = join(dir, `${base}.yaml`)
  if (!existsSync(json)) continue
  if (existsSync(yaml)) {
    console.log(`skip  ${base}.yaml は既にある`)
    continue
  }
  const data = JSON.parse(readFileSync(json, 'utf8'))
  const text = stringify(data, OPTS)
  // 書く前に読み直して、元の JSON と同じ構造に戻ることを確かめる。
  const back = parse(text)
  if (JSON.stringify(back) !== JSON.stringify(data)) {
    console.error(`★ ${base}: YAML に落として読み直したら中身が変わった。中止する`)
    process.exit(1)
  }
  writeFileSync(yaml, text)
  renameSync(json, `${json}.migrated`)
  console.log(`ok    ${base}.json -> ${base}.yaml  (元は ${base}.json.migrated へ)`)
}
