import { type FaceState, toPiuColorNumber, toPiuColorString } from 'face-state'
import { type Skin as PiuSkin, Skin } from 'piu/MC'

export type FaceSkinPalette = {
  primary: PiuSkin
  secondary: PiuSkin
  mixed: PiuSkin
  palette: PiuSkin
  primaryState: number
  secondaryState: number
  primaryColor: number
  secondaryColor: number
}

// The face fills the whole screen and the app bar sits on top of it with a
// transparent background, so anything the bar draws in a fixed colour disappears
// when the face background happens to match it (a white face hid the battery
// indicator entirely). Remember the current background so the bar can pick ink
// that stays readable.
let faceBackground = 0x000000

/** Background colour the face is currently painted with (0xRRGGBB). */
export function faceBackgroundColor(): number {
  return faceBackground
}

/** Perceived brightness, 0-255. Rec. 601 luma — cheap and good enough here. */
function luma(color: number): number {
  return 0.299 * ((color >> 16) & 0xff) + 0.587 * ((color >> 8) & 0xff) + 0.114 * (color & 0xff)
}

/**
 * Ink that stays readable on the current face background.
 *
 * Compares the caller's preferred ink against the background rather than
 * thresholding the background alone: the two can collide at any brightness
 * (white on white, but also grey on grey), and the theme's ink is not
 * guaranteed to stay white. Only when they are too close does this flip to
 * whichever end of the scale the background is furthest from.
 */
export function readableInk(preferred: number): number {
  const background = luma(faceBackground)
  if (Math.abs(luma(preferred) - background) >= 96) return preferred
  return background > 127 ? 0x000000 : 0xffffff
}

export function createFaceSkinPalette(primary: number, secondary: number): FaceSkinPalette {
  faceBackground = secondary
  const primaryColor = toPiuColorString(primary)
  const secondaryColor = toPiuColorString(secondary)
  return {
    primary: new Skin({ fill: primaryColor, stroke: primaryColor }),
    secondary: new Skin({ fill: secondaryColor, stroke: secondaryColor }),
    mixed: new Skin({ fill: secondaryColor, stroke: primaryColor }),
    palette: new Skin({ fill: [secondaryColor, primaryColor], stroke: [secondaryColor, primaryColor] }),
    primaryState: 1,
    secondaryState: 0,
    primaryColor: primary,
    secondaryColor: secondary,
  }
}

export function updateFaceSkinPalette(prev: FaceSkinPalette | null, face: FaceState): FaceSkinPalette {
  const primary = toPiuColorNumber(face.theme.primary)
  const secondary = toPiuColorNumber(face.theme.secondary)
  if (prev && prev.primaryColor === primary && prev.secondaryColor === secondary) return prev
  return createFaceSkinPalette(primary, secondary)
}
