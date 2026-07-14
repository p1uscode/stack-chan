// Trimmed from stack-chan-dock apps/codex-voice/src/types.ts — only the types the
// audio/app-server layer needs. The USB dock's device/approval/event types were
// dropped because the gateway reaches the robot over its own WebSocket instead.

export type PcmChunk = {
  data: Uint8Array
  sampleRate: number
  channels: 1
  format: 's16le'
}

export type ConversationState = 'idle' | 'connecting' | 'listening' | 'recognizing' | 'speaking' | 'error'

export type ApprovalKind = 'command' | 'fileChange'

export type ApprovalRequest = {
  id: string
  kind: ApprovalKind
  title: string
  summary: string
  detail: string
  truncated: boolean
}

export type ApprovalDecision = 'approve' | 'decline'
