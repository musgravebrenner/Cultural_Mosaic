import type { FieldFrame } from './FieldRenderer'

/**
 * Catmull-Rom resampling of the FLOAT field, used only by the high-resolution export.
 *
 * The whole point is ordering: resample rho and each colour channel as floats to the
 * output resolution, and let the caller tone-map afterwards. Tone-mapping at grid
 * resolution and then upscaling anti-aliases the solid/void boundary at 96px and then
 * blurs it; this anti-aliases it at the output resolution instead.
 */

/** Catmull-Rom basis at parameter t, for the four samples around it. */
function catmullRom(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const t2 = t * t
  const t3 = t2 * t
  return (
    0.5 *
    (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3)
  )
}

function sample(
  src: ArrayLike<number>,
  n: number,
  stride: number,
  offset: number,
  x: number,
  y: number,
): number {
  const ix = Math.floor(x)
  const iy = Math.floor(y)
  const fx = x - ix
  const fy = y - iy
  const at = (cx: number, cy: number): number => {
    // Clamp to edge: the disc is surrounded by masked cells anyway, so there is nothing
    // meaningful to wrap or mirror to.
    const qx = cx < 0 ? 0 : cx >= n ? n - 1 : cx
    const qy = cy < 0 ? 0 : cy >= n ? n - 1 : cy
    return src[(qy * n + qx) * stride + offset]!
  }
  const rows: number[] = []
  for (let j = -1; j <= 2; j++) {
    rows.push(
      catmullRom(at(ix - 1, iy + j), at(ix, iy + j), at(ix + 1, iy + j), at(ix + 2, iy + j), fx),
    )
  }
  return catmullRom(rows[0]!, rows[1]!, rows[2]!, rows[3]!, fy)
}

/**
 * Resample a frame to `size` x `size`, in float space. The mask is resampled by nearest
 * neighbour and thresholded, so the disc boundary stays crisp rather than smearing
 * material outside the domain.
 */
export function resampleField(frame: FieldFrame, size: number): FieldFrame {
  const { n, density, hue, kappa, mask, ghost } = frame
  const outDensity = new Float32Array(size * size)
  const outHue = new Float32Array(size * size * 3)
  const outKappa = new Float32Array(size * size)
  const outMask = new Uint8Array(size * size)
  const outGhost = ghost ? new Float32Array(size * size) : undefined

  const scale = n / size
  for (let y = 0; y < size; y++) {
    // Map the output pixel CENTRE into source coordinates.
    const sy = (y + 0.5) * scale - 0.5
    for (let x = 0; x < size; x++) {
      const sx = (x + 0.5) * scale - 0.5
      const o = y * size + x

      const mx = Math.min(n - 1, Math.max(0, Math.round(sx)))
      const my = Math.min(n - 1, Math.max(0, Math.round(sy)))
      if (!mask[my * n + mx]) continue
      outMask[o] = 1

      outDensity[o] = Math.min(1, Math.max(0, sample(density, n, 1, 0, sx, sy)))
      outKappa[o] = Math.max(0, sample(kappa, n, 1, 0, sx, sy))
      let r = Math.max(0, sample(hue, n, 3, 0, sx, sy))
      let g = Math.max(0, sample(hue, n, 3, 1, sx, sy))
      let b = Math.max(0, sample(hue, n, 3, 2, sx, sy))
      // Catmull-Rom overshoots, so renormalize back onto the simplex.
      const s = r + g + b
      if (s > 1e-6) {
        r /= s
        g /= s
        b /= s
      }
      outHue[3 * o] = r
      outHue[3 * o + 1] = g
      outHue[3 * o + 2] = b
      if (outGhost && ghost) {
        outGhost[o] = Math.min(1, Math.max(0, sample(ghost, n, 1, 0, sx, sy)))
      }
    }
  }

  const out: FieldFrame = {
    n: size,
    density: outDensity,
    hue: outHue,
    kappa: outKappa,
    mask: outMask,
  }
  return outGhost ? { ...out, ghost: outGhost } : out
}
