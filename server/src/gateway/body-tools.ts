// Channel-scoped body tools (physical robot ops). Primitives (set_emotion /
// move_head / set_led) plus one `action` tool whose `type` selects a compound
// motion (nod / shake / dance) — gateway-side sequences of the primitives, so the
// LLM (one `action` tool) and the UI (body.tool=action, args.type) share them.

export const EMOTION_NAMES = ['NEUTRAL', 'ANGRY', 'SAD', 'HAPPY', 'SLEEPY', 'DOUBTFUL']

// Named compound motions selectable via the `action` tool's `type`.
export const ACTION_TYPES = ['nod', 'shake', 'dance']

export const CHANNEL_TOOL_NAMES = ['set_emotion', 'move_head', 'set_led', 'action']

type Step = { body: Array<{ tool: string; args: Record<string, unknown> }>; wait: number }

// Head range after the servo rework: pitch 下13(-13)〜上75, yaw ±90.
// Keep sequence amplitudes inside that so nothing clips.
export const NOD_STEPS: Step[] = [
  { body: [{ tool: 'move_head', args: { yaw: 0, pitch: 0 } }], wait: 350 },
  { body: [{ tool: 'move_head', args: { yaw: 0, pitch: -13 } }], wait: 450 },
  { body: [{ tool: 'move_head', args: { yaw: 0, pitch: 0 } }], wait: 450 },
  { body: [{ tool: 'move_head', args: { yaw: 0, pitch: -13 } }], wait: 450 },
  { body: [{ tool: 'move_head', args: { yaw: 0, pitch: 0 } }], wait: 0 },
]

// 拒否・いやいや: 首を左右に振る。
export const SHAKE_STEPS: Step[] = [
  { body: [{ tool: 'move_head', args: { yaw: 0, pitch: 0 } }], wait: 250 },
  { body: [{ tool: 'move_head', args: { yaw: 35, pitch: 0 } }], wait: 300 },
  { body: [{ tool: 'move_head', args: { yaw: -35, pitch: 0 } }], wait: 300 },
  { body: [{ tool: 'move_head', args: { yaw: 35, pitch: 0 } }], wait: 300 },
  { body: [{ tool: 'move_head', args: { yaw: -35, pitch: 0 } }], wait: 300 },
  { body: [{ tool: 'move_head', args: { yaw: 0, pitch: 0 } }], wait: 0 },
]

export const DANCE_STEPS: Step[] = [
  { body: [{ tool: 'set_emotion', args: { emotion: 'HAPPY' } }, { tool: 'set_led', args: { r: 64, g: 0, b: 32 } }], wait: 250 },
  { body: [{ tool: 'move_head', args: { yaw: 60, pitch: 30 } }, { tool: 'set_led', args: { r: 0, g: 64, b: 32 } }], wait: 500 },
  { body: [{ tool: 'move_head', args: { yaw: -60, pitch: 30 } }, { tool: 'set_led', args: { r: 32, g: 32, b: 0 } }], wait: 500 },
  { body: [{ tool: 'move_head', args: { yaw: 60, pitch: -13 } }, { tool: 'set_led', args: { r: 0, g: 32, b: 64 } }], wait: 500 },
  { body: [{ tool: 'move_head', args: { yaw: -60, pitch: -13 } }, { tool: 'set_led', args: { r: 64, g: 0, b: 0 } }], wait: 500 },
  { body: [{ tool: 'move_head', args: { yaw: 0, pitch: 40 } }, { tool: 'set_led', args: { r: 32, g: 0, b: 64 } }], wait: 400 },
  { body: [{ tool: 'move_head', args: { yaw: 0, pitch: 0 } }, { tool: 'set_led', args: { r: 0, g: 0, b: 0 } }, { tool: 'set_emotion', args: { emotion: 'NEUTRAL' } }], wait: 0 },
]

// action type -> steps
export const ACTION_STEPS: Record<string, Step[]> = { nod: NOD_STEPS, shake: SHAKE_STEPS, dance: DANCE_STEPS }

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))

// Run a compound-motion sequence. Each step's primitive ops go through the
// SAME sendBody (so per-channel handling still applies), then wait.
export const runSequence = async (
  sendBody: (tool: string, args: Record<string, unknown>) => unknown,
  steps: Step[],
) => {
  for (const step of steps) {
    for (const b of step.body) sendBody(b.tool, b.args)
    if (step.wait) await delay(step.wait)
  }
}

// Body tools exposed to the LLM. sendBody dispatches primitives to the robot and
// `action` (type=nod/shake/dance) to the matching sequence (handled in sendBody).
export const makeBodyTools = (sendBody: (tool: string, args: Record<string, unknown>) => unknown) => {
  return [
    {
      name: 'set_emotion',
      description: 'ロボット自身の表情を変える',
      inputSchema: {
        type: 'object',
        properties: { emotion: { type: 'string', description: `次のいずれか: ${EMOTION_NAMES.join(', ')}` } },
        required: ['emotion'],
      },
      execute: (args: Record<string, unknown>) => {
        sendBody('set_emotion', args)
        return `emotion set to ${args.emotion}`
      },
    },
    {
      name: 'move_head',
      description: 'ロボット自身の首の向きを変える(正面は0,0)。方向はロボット自身から見た向き',
      inputSchema: {
        type: 'object',
        properties: {
          yaw: { type: 'number', description: '左右の角度(度)。-90(自分の右)〜90(自分の左)' },
          pitch: { type: 'number', description: '上下の角度(度)。-13(下・お辞儀)〜75(上・見上げ)' },
        },
      },
      execute: (args: Record<string, unknown>) => {
        sendBody('move_head', args)
        return `head moved to yaw=${args.yaw ?? 0} pitch=${args.pitch ?? 0}`
      },
    },
    {
      name: 'set_led',
      description: '頭のLEDリングの色を変える。消すときはr,g,b全て0',
      inputSchema: {
        type: 'object',
        properties: {
          r: { type: 'number', description: '赤 0-64' },
          g: { type: 'number', description: '緑 0-64' },
          b: { type: 'number', description: '青 0-64' },
        },
        required: ['r', 'g', 'b'],
      },
      execute: (args: Record<string, unknown>) => {
        sendBody('set_led', args)
        return `led set to rgb(${args.r},${args.g},${args.b})`
      },
    },
    {
      name: 'action',
      description: '決まった動作をする。nod=うなずく(同意・あいづち), shake=首を横に振る(拒否・いやいや), dance=踊る(喜び・盛り上げ)',
      inputSchema: {
        type: 'object',
        properties: { type: { type: 'string', enum: ACTION_TYPES, description: 'nod / shake / dance のいずれか' } },
        required: ['type'],
      },
      execute: async (args: Record<string, unknown>) => {
        await sendBody('action', { type: args.type })
        return `action: ${args.type}`
      },
    },
  ]
}
