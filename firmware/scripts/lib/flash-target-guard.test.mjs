import assert from 'node:assert/strict'
import { test } from 'node:test'
import { assertNotWatchTarget, listCandidatePorts, looksLikeWatch } from './flash-target-guard.mjs'

test('watch の起動ログを watch と判定する', () => {
  assert.equal(looksLikeWatch('[power] style=Haro current=0mA voltage=3960mV level=82%'), true)
  assert.equal(looksLikeWatch('[gw] wifi retry'), true)
})

test('黙っている相手や Moddable の出力は watch と判定しない', () => {
  // まっさらな CoreS3 は何も喋らない。ここで止めると初回書き込みができなくなる。
  assert.equal(looksLikeWatch(''), false)
  assert.equal(looksLikeWatch('xsbug instruments: 12345'), false)
  assert.equal(looksLikeWatch('[main] using device.sensor.TouchPanel fallback'), false)
})

test('相手が watch なら止める', () => {
  assert.throws(
    () =>
      assertNotWatchTarget({
        uploadPort: '/dev/cu.usbmodemTEST',
        readPort: () => '[power] style=Haro level=100%',
      }),
    /焼き先が watch/,
  )
})

test('部分的にしか読めなくても watch と判定できる', () => {
  // 読み取りが途中で打ち切られる前提。1行でも watch の目印があれば止まること。
  assert.throws(
    () => assertNotWatchTarget({ uploadPort: '/dev/cu.usbmodemTEST', readPort: () => '[power] style=Haro cur' }),
    /焼き先が watch/,
  )
})

test('相手が黙っていても通す', () => {
  const port = assertNotWatchTarget({ uploadPort: '/dev/cu.usbmodemTEST', readPort: () => '' })
  assert.equal(port, '/dev/cu.usbmodemTEST')
})

test('候補が複数あるなら止める', () => {
  assert.throws(
    () =>
      assertNotWatchTarget({
        listPorts: () => ['/dev/cu.usbmodemA', '/dev/cu.usbmodemB'],
        readPort: () => '',
      }),
    /複数のシリアルポート/,
  )
})

test('候補が0件なら判定を省略して通す(ビルド専用の使い方を巻き添えにしない)', () => {
  assert.equal(assertNotWatchTarget({ listPorts: () => [], readPort: () => '' }), undefined)
})

test('候補が1件ならそれを見る', () => {
  const seen = []
  const port = assertNotWatchTarget({
    listPorts: () => ['/dev/cu.usbmodemONLY'],
    readPort: (target) => {
      seen.push(target)
      return ''
    },
  })
  assert.equal(port, '/dev/cu.usbmodemONLY')
  assert.deepEqual(seen, ['/dev/cu.usbmodemONLY'])
})

test('/dev の cu.usbmodem だけを候補にする', () => {
  const ports = listCandidatePorts(() => ['cu.usbmodem2111301', 'cu.Bluetooth-Incoming-Port', 'tty.usbmodem2111301'])
  assert.deepEqual(ports, ['/dev/cu.usbmodem2111301'])
})
