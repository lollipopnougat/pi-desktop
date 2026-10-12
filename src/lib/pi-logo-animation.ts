// Adapted from pi-agent/packages/coding-agent/docs/assets/logo-canvas.html ("blocks" mode).
// Keep the terminal logo's shuffle, lighting, depth test and return choreography.
type Vec3 = [number, number, number];
type Rgb = Vec3;
interface Block {
  home: Vec3;
  color: Rgb;
}
interface Box {
  min: Vec3;
  max: Vec3;
  color: Rgb;
}
interface Pose {
  centerX: number;
  centerY: number;
  scale: number;
  yaw: number;
  pitch: number;
  roll: number;
}
interface Face {
  axis: number;
  u: number;
  v: number;
  plane: number;
  box: Box;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  color: Rgb;
}
interface Exit {
  time: number;
  elapsed: number;
  yaw: number;
  targetYaw: number;
  offsets: Vec3[];
}
export interface PiLogoAnimation {
  close(): void;
  dispose(): void;
}

// Brand colors match the existing welcome SVG.
const COLORS: Record<string, Rgb | undefined> = {
  c: [240, 144, 130],
  b: [77, 154, 191],
  y: [241, 190, 88]
};
const BITMAP = ['ccc.', 'b.c.', 'bb.y', 'b..y'];
const blocks: Block[] = [];
for (let y = 0; y < 4; y++) {
  for (let x = 0; x < 4; x++) {
    const color = COLORS[BITMAP[y][x]];
    if (color) blocks.push({ home: [x, y, 0], color });
  }
}
const DEPTH = 0.7,
  CAMERA = 10;
const FLY_START = 0.1,
  FLY_DURATION = 1.3;
const PUZZLE_START = FLY_START + FLY_DURATION + 3;
const PUZZLE_STEP = 0.3,
  PUZZLE_STEPS = 12,
  PUZZLE_RETURN = 1,
  PUZZLE_HOLD = 0.6;
const PUZZLE_CYCLE = PUZZLE_STEP * PUZZLE_STEPS + PUZZLE_RETURN + PUZZLE_HOLD;
const MOVES: Vec3[] = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1]
];
const EXIT_DURATION = 1.1,
  STARS_START = 2.5,
  STARS_FADE = 2;
const SPIN_RAMP = 1.4,
  SPIN_SPEED = (Math.PI * 2) / PUZZLE_CYCLE,
  SPIN_LINGER = 0.6;
const FIRST_FRONT_VIEW =
  PUZZLE_START + PUZZLE_STEP * PUZZLE_STEPS + PUZZLE_RETURN + PUZZLE_HOLD / 2;
const LIGHT = normalize([-0.45, -0.6, 0.75]);
const HALF_VECTOR = normalize([LIGHT[0], LIGHT[1], LIGHT[2] + 1]);

function normalize(v: Vec3): Vec3 {
  const length = Math.hypot(...v);
  return [v[0] / length, v[1] / length, v[2] / length];
}
function clamp01(value: number) {
  return Math.max(0, Math.min(1, value));
}
function smooth(value: number) {
  const t = clamp01(value);
  return t * t * t * (t * (t * 6 - 15) + 10);
}
function mix(a: Vec3, b: Vec3, amount: number): Vec3 {
  return [
    a[0] + (b[0] - a[0]) * amount,
    a[1] + (b[1] - a[1]) * amount,
    a[2] + (b[2] - a[2]) * amount
  ];
}
function rgb(color: Rgb) {
  return `rgb(${color.map(Math.round).join(',')})`;
}
function hash(value: number) {
  let x = Math.imul(value ^ 0x9e3779b9, 0x85ebca6b);
  x ^= x >>> 13;
  x = Math.imul(x, 0xc2b2ae35);
  x ^= x >>> 16;
  return (x >>> 0) / 0x100000000;
}
function rotation(yaw: number, pitch: number, roll: number) {
  const sy = Math.sin(yaw),
    cy = Math.cos(yaw);
  const sx = Math.sin(pitch),
    cx = Math.cos(pitch);
  const sz = Math.sin(roll),
    cz = Math.cos(roll);
  // Rz * Rx * Ry, row-major. Transpose maps camera rays back into model space.
  return [
    cz * cy - sz * sx * sy,
    -sz * cx,
    cz * sy + sz * sx * cy,
    sz * cy + cz * sx * sy,
    cz * cx,
    sz * sy - cz * sx * cy,
    -cx * sy,
    sx,
    cx * cy
  ];
}
function baseSpinPhase(time: number) {
  const elapsed = time - FLY_START;
  if (elapsed <= 0) return 0;
  const u = elapsed / SPIN_RAMP;
  if (u < 1) return SPIN_SPEED * SPIN_RAMP * (u ** 6 - 3 * u ** 5 + 2.5 * u ** 4);
  return SPIN_SPEED * (SPIN_RAMP * 0.5 + elapsed - SPIN_RAMP);
}
const SPIN_ALIGNMENT = Math.PI * 2 - (baseSpinPhase(FIRST_FRONT_VIEW) % (Math.PI * 2));
function spinPhase(time: number) {
  return baseSpinPhase(time) + SPIN_ALIGNMENT * smooth((time - FLY_START) / FLY_DURATION);
}
function spinAngle(time: number) {
  const phase = spinPhase(time);
  return phase - SPIN_LINGER * Math.sin(phase);
}

// Reserve both the source and destination cells within a step, as the terminal version does.
function shuffleSteps(cycle: number) {
  let positions = blocks.map((block) => block.home);
  const steps = [positions],
    lastMoved = new Set<number>();
  let random = cycle * 7919 + 1;
  const next = () => hash(random++);
  const key = ([x, y, z]: Vec3) => ((z + 1) * 4 + y) * 4 + x;
  for (let step = 0; step < PUZZLE_STEPS; step++) {
    const occupied = new Set(positions.map(key));
    const nextPositions = [...positions],
      moved = new Set<number>();
    const moveCount = next() < 0.4 ? 2 : 1;
    for (let move = 0; move < moveCount; move++) {
      const candidates: { block: number; target: Vec3 }[] = [];
      for (let block = 0; block < positions.length; block++) {
        if (moved.has(block)) continue;
        const [x, y, z] = positions[block];
        for (const [dx, dy, dz] of MOVES) {
          const target: Vec3 = [x + dx, y + dy, z + dz];
          if (target[0] < 0 || target[0] >= 4 || target[1] < 0 || target[1] >= 4) continue;
          if (target[2] < -1 || target[2] > 1 || occupied.has(key(target))) continue;
          candidates.push({ block, target });
        }
      }
      const fresh = candidates.filter((candidate) => !lastMoved.has(candidate.block));
      const pool = fresh.length > 0 ? fresh : candidates;
      const choice = pool[Math.floor(next() * pool.length)];
      if (!choice) break;
      occupied.add(key(choice.target));
      nextPositions[choice.block] = choice.target;
      moved.add(choice.block);
    }
    lastMoved.clear();
    for (const block of moved) lastMoved.add(block);
    positions = nextPositions;
    steps.push(positions);
  }
  return steps;
}

function createBlockOffsets() {
  let shuffle: { cycle: number; steps: Vec3[][] } | null = null;
  return function blockOffsets(time: number): Vec3[] {
    if (time < PUZZLE_START) return blocks.map(() => [0, 0, 0]);
    const cycle = Math.floor((time - PUZZLE_START) / PUZZLE_CYCLE);
    const local = time - PUZZLE_START - cycle * PUZZLE_CYCLE;
    if (shuffle?.cycle !== cycle) shuffle = { cycle, steps: shuffleSteps(cycle) };
    const steps = shuffle.steps;
    const offset = (position: Vec3, index: number): Vec3 => [
      position[0] - blocks[index].home[0],
      position[1] - blocks[index].home[1],
      position[2] - blocks[index].home[2]
    ];
    const shuffleEnd = PUZZLE_STEP * PUZZLE_STEPS;
    if (local < shuffleEnd) {
      const step = Math.floor(local / PUZZLE_STEP);
      const progress = smooth((local - step * PUZZLE_STEP) / PUZZLE_STEP);
      return steps[step].map((from, index) =>
        mix(offset(from, index), offset(steps[step + 1][index], index), progress)
      );
    }
    if (local < shuffleEnd + PUZZLE_RETURN) {
      const u = (local - shuffleEnd) / PUZZLE_RETURN;
      const remaining = 1 - smooth(u),
        arc = Math.sin(Math.PI * clamp01(u)) * 0.8;
      return steps[PUZZLE_STEPS].map((position, index) => {
        const [x, y, z] = offset(position, index);
        return [x * remaining, y * remaining, z * remaining + (index % 2 === 0 ? arc : -arc)];
      });
    }
    return blocks.map(() => [0, 0, 0]);
  };
}
function visibleFaces(pose: Pose, offsets: Vec3[], width: number, height: number) {
  const m = rotation(pose.yaw, pose.pitch, pose.roll);
  const origin: Vec3 = [m[6] * CAMERA, m[7] * CAMERA, m[8] * CAMERA];
  const boxes: Box[] = blocks.map((block, index) => {
    const [dx, dy, dz] = offsets[index];
    const x = block.home[0] - 2 + dx,
      y = block.home[1] - 2 + dy;
    return { min: [x, y, dz - DEPTH / 2], max: [x + 1, y + 1, dz + DEPTH / 2], color: block.color };
  });
  const faces: Face[] = [];
  for (const box of boxes) {
    for (let axis = 0; axis < 3; axis++) {
      const u = (axis + 1) % 3,
        v = (axis + 2) % 3;
      for (const side of [-1, 1]) {
        const plane = side > 0 ? box.max[axis] : box.min[axis];
        if ((origin[axis] - plane) * side <= 0) continue;
        if (
          boxes.some(
            (other) =>
              other !== box &&
              (side > 0 ? other.min[axis] : other.max[axis]) === plane &&
              other.min[u] <= box.min[u] &&
              other.max[u] >= box.max[u] &&
              other.min[v] <= box.min[v] &&
              other.max[v] >= box.max[v]
          )
        )
          continue;
        let minX = Infinity,
          minY = Infinity,
          maxX = -Infinity,
          maxY = -Infinity;
        for (const cornerU of [box.min[u], box.max[u]]) {
          for (const cornerV of [box.min[v], box.max[v]]) {
            const corner = [0, 0, 0];
            corner[axis] = plane;
            corner[u] = cornerU;
            corner[v] = cornerV;
            const x = m[0] * corner[0] + m[1] * corner[1] + m[2] * corner[2];
            const y = m[3] * corner[0] + m[4] * corner[1] + m[5] * corner[2];
            const z = m[6] * corner[0] + m[7] * corner[1] + m[8] * corner[2];
            const perspective = (pose.scale * CAMERA) / (CAMERA - z);
            minX = Math.min(minX, pose.centerX + x * perspective);
            maxX = Math.max(maxX, pose.centerX + x * perspective);
            minY = Math.min(minY, pose.centerY + y * perspective);
            maxY = Math.max(maxY, pose.centerY + y * perspective);
          }
        }
        const nx = m[axis] * side,
          ny = m[3 + axis] * side,
          nz = m[6 + axis] * side;
        const diffuse = Math.max(0, nx * LIGHT[0] + ny * LIGHT[1] + nz * LIGHT[2]);
        const rim = Math.max(0, nx * 0.8 - nz * 0.3);
        const specular =
          Math.max(0, nx * HALF_VECTOR[0] + ny * HALF_VECTOR[1] + nz * HALF_VECTOR[2]) ** 24 *
          0.6 *
          255;
        faces.push({
          axis,
          plane,
          u,
          v,
          box,
          minX: Math.max(0, Math.floor(minX)),
          maxX: Math.min(width - 1, Math.ceil(maxX)),
          minY: Math.max(0, Math.floor(minY)),
          maxY: Math.min(height - 1, Math.ceil(maxY)),
          color: box.color.map((value) =>
            Math.min(255, value * (0.45 + diffuse * 0.78 + rim * 0.25) + specular)
          ) as Rgb
        });
      }
    }
  }
  return { matrix: m, origin, faces };
}

const MAX_RASTER_PIXELS = 4_000_000;
const SUPERSAMPLE_SCALE = 2;
const BUFFER_TILE = 64;

/** Supersample the model's bounds, keeping the original per-sample depth test. */
class BlockRaster {
  private canvas = document.createElement('canvas');
  private context = this.canvas.getContext('2d')!;
  private image: ImageData | null = null;
  private depth = new Float32Array(0);

  render(context: CanvasRenderingContext2D, pose: Pose, offsets: Vec3[], background: Rgb) {
    const { width, height } = context.canvas;
    const { matrix, origin, faces: projectedFaces } = visibleFaces(pose, offsets, width, height);
    const faces = projectedFaces.filter((face) => face.minX <= face.maxX && face.minY <= face.maxY);
    if (faces.length === 0) return;

    // A transparent pixel around the model lets downsampling blend silhouettes cleanly.
    const left = Math.max(0, Math.min(...faces.map((face) => face.minX)) - 1);
    const top = Math.max(0, Math.min(...faces.map((face) => face.minY)) - 1);
    const right = Math.min(width, Math.max(...faces.map((face) => face.maxX)) + 2);
    const bottom = Math.min(height, Math.max(...faces.map((face) => face.maxY)) + 2);
    const cropWidth = right - left;
    const cropHeight = bottom - top;
    const sampleScale = Math.min(
      SUPERSAMPLE_SCALE,
      Math.sqrt(MAX_RASTER_PIXELS / (cropWidth * cropHeight))
    );
    const sampleWidth = Math.ceil(cropWidth * sampleScale);
    const sampleHeight = Math.ceil(cropHeight * sampleScale);
    const scaleX = sampleWidth / cropWidth;
    const scaleY = sampleHeight / cropHeight;

    if (!this.image || this.canvas.width < sampleWidth || this.canvas.height < sampleHeight) {
      // Grow in tiles and reuse allocations while the rotating bounds shrink and expand.
      let bufferWidth =
        Math.ceil(Math.max(this.image?.width ?? 0, sampleWidth) / BUFFER_TILE) * BUFFER_TILE;
      let bufferHeight =
        Math.ceil(Math.max(this.image?.height ?? 0, sampleHeight) / BUFFER_TILE) * BUFFER_TILE;
      if (bufferWidth * bufferHeight > MAX_RASTER_PIXELS) {
        bufferWidth = sampleWidth;
        bufferHeight = sampleHeight;
      }
      this.canvas.width = bufferWidth;
      this.canvas.height = bufferHeight;
      this.image = this.context.createImageData(bufferWidth, bufferHeight);
      this.depth = new Float32Array(bufferWidth * bufferHeight);
    }
    const pixels = this.image.data;
    pixels.fill(0);
    this.depth.fill(Infinity);
    for (const face of faces) {
      const { axis: a, u, v } = face;
      const minX = Math.max(0, Math.floor((face.minX - left) * scaleX));
      const maxX = Math.min(sampleWidth - 1, Math.ceil((face.maxX + 1 - left) * scaleX) - 1);
      const minY = Math.max(0, Math.floor((face.minY - top) * scaleY));
      const maxY = Math.min(sampleHeight - 1, Math.ceil((face.maxY + 1 - top) * scaleY) - 1);
      const sx = (left + (minX + 0.5) / scaleX - pose.centerX) / pose.scale;
      const stepA = matrix[a] / (pose.scale * scaleX);
      const stepU = matrix[u] / (pose.scale * scaleX);
      const stepV = matrix[v] / (pose.scale * scaleX);
      for (let y = minY; y <= maxY; y++) {
        const sy = (top + (y + 0.5) / scaleY - pose.centerY) / pose.scale;
        let da = matrix[a] * sx + matrix[3 + a] * sy - matrix[6 + a] * CAMERA;
        let du = matrix[u] * sx + matrix[3 + u] * sy - matrix[6 + u] * CAMERA;
        let dv = matrix[v] * sx + matrix[3 + v] * sy - matrix[6 + v] * CAMERA;
        for (let x = minX; x <= maxX; x++) {
          const index = y * this.image.width + x;
          const distance = (face.plane - origin[a]) / da;
          if (distance > 0 && distance < this.depth[index]) {
            const hitU = origin[u] + distance * du;
            const hitV = origin[v] + distance * dv;
            if (
              hitU >= face.box.min[u] &&
              hitU <= face.box.max[u] &&
              hitV >= face.box.min[v] &&
              hitV <= face.box.max[v]
            ) {
              this.depth[index] = distance;
              const fog = clamp01(0.15 - CAMERA * (1 - distance) * 0.12);
              for (let c = 0; c < 3; c++) {
                const lit = face.color[c];
                pixels[index * 4 + c] = lit + (background[c] - lit) * fog;
              }
              pixels[index * 4 + 3] = 255;
            }
          }
          da += stepA;
          du += stepU;
          dv += stepV;
        }
      }
    }
    // Clear unused buffer tiles too, so the downsampling filter cannot pick up an older frame.
    this.context.putImageData(this.image, 0, 0);
    context.save();
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    context.drawImage(
      this.canvas,
      0,
      0,
      sampleWidth,
      sampleHeight,
      left,
      top,
      cropWidth,
      cropHeight
    );
    context.restore();
  }
}

/** Created only while the welcome easter egg is open; all resources belong to this instance. */
export function createPiLogoAnimation(
  canvas: HTMLCanvasElement,
  logo: SVGSVGElement,
  onFinish: () => void
): PiLogoAnimation {
  const context = canvas.getContext('2d');
  if (!context) {
    onFinish();
    return { close() {}, dispose() {} };
  }
  const raster = new BlockRaster();
  const blockOffsets = createBlockOffsets();
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  let clock = reducedMotion.matches ? FIRST_FRONT_VIEW : 0;
  let exit: Exit | null = null;
  let request: number | null = null;
  let last: number | null = null;
  let disposed = false;
  let background: Rgb = [0, 0, 0];
  let foreground: Rgb = [255, 255, 255];
  let startX = 0,
    startY = 0,
    startScale = 1;

  function readColor(name: string): Rgb {
    return getComputedStyle(canvas).getPropertyValue(name).trim().split(/\s+/).map(Number) as Rgb;
  }

  function poseAt(progress: number, time: number): Pose {
    const radius = Math.hypot(2, 2, 1 + DEPTH / 2);
    const reach = (radius * CAMERA) / (CAMERA - radius);
    const endScale = Math.max(
      startScale,
      Math.min(canvas.width * 0.35, canvas.height * 0.42) / reach
    );
    return {
      centerX: startX + (canvas.width / 2 - startX) * progress,
      centerY: startY + (canvas.height / 2 - startY) * progress,
      scale: startScale * (endScale / startScale) ** progress,
      yaw: spinAngle(time),
      pitch: 0.3 * Math.sin(spinPhase(time)) * progress,
      roll: 0.06 * Math.sin(2 * spinPhase(time)) * progress
    };
  }

  function render() {
    if (disposed || !context) return;
    const time = exit ? exit.time : clock;
    const progress = exit ? clamp01(exit.elapsed / EXIT_DURATION) : 0;
    const landing = clamp01(progress / 0.8);
    const settle = 1 - smooth(landing);
    const flight = smooth((time - FLY_START) / FLY_DURATION);
    const pose = poseAt(flight * settle, time);
    let offsets = blockOffsets(time);
    if (exit) {
      pose.yaw = exit.yaw + (exit.targetYaw - exit.yaw) * (1 - (1 - landing) ** 3);
      pose.pitch *= settle;
      pose.roll *= settle;
      const gather = 1 - smooth(progress / 0.5);
      offsets = exit.offsets.map((offset) => mix([0, 0, 0], offset, gather));
    }
    if (reducedMotion.matches) {
      pose.yaw = 0;
      pose.pitch = 0;
      pose.roll = 0;
      offsets = blocks.map(() => [0, 0, 0]);
    }
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.globalAlpha = smooth(time / 0.6) * (1 - smooth(progress));
    context.fillStyle = rgb(background);
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.globalAlpha = 1;

    const starLevel = smooth((time - STARS_START) / STARS_FADE) * (1 - smooth(progress / 0.3));
    context.fillStyle = rgb(foreground);
    for (let i = 0; i < 70; i++) {
      context.globalAlpha =
        starLevel *
        (0.08 + hash(i + 140) * 0.12) *
        (0.7 + 0.3 * Math.sin(time * (0.4 + hash(i + 210)) + i));
      context.fillRect(hash(i) * canvas.width, hash(i + 70) * canvas.height, 1.5, 1.5);
    }
    context.globalAlpha = 1;
    raster.render(context, pose, offsets, background);
  }

  function cancelFrame() {
    if (request !== null) cancelAnimationFrame(request);
    request = null;
    last = null;
  }

  function schedule() {
    if (!disposed && request === null && !document.hidden && !reducedMotion.matches) {
      request = requestAnimationFrame(step);
    }
  }

  function step(now: number) {
    request = null;
    // The software rasterizer follows the terminal's 30 FPS, including high-refresh displays.
    if (last === null || now - last >= 1000 / 30 - 1) {
      const delta = last === null ? 0 : Math.min((now - last) / 1000, 0.1);
      last = now;
      if (exit) exit.elapsed += delta;
      else clock += delta;
      if (exit && exit.elapsed >= EXIT_DURATION) {
        finish();
        return;
      }
      render();
    }
    schedule();
  }

  function resize() {
    const bounds = canvas.getBoundingClientRect();
    const logoBounds = logo.getBoundingClientRect();
    // Preserve Retina detail; the rasterizer separately caps its cropped sampling buffers.
    const ratio = Math.min(
      devicePixelRatio || 1,
      2,
      Math.sqrt(4_000_000 / Math.max(1, bounds.width * bounds.height))
    );
    canvas.width = Math.max(1, Math.round(bounds.width * ratio));
    canvas.height = Math.max(1, Math.round(bounds.height * ratio));
    const scaleX = canvas.width / Math.max(1, bounds.width);
    const scaleY = canvas.height / Math.max(1, bounds.height);
    // The 4x4 artwork occupies 165.29..634.72 inside the existing SVG's 800x800 viewBox.
    startX = (logoBounds.left + logoBounds.width / 2 - bounds.left) * scaleX;
    startY = (logoBounds.top + logoBounds.height / 2 - bounds.top) * scaleY;
    startScale = Math.max(
      1,
      (logoBounds.width * (117.36 / 800) * scaleX * (CAMERA - DEPTH / 2)) / CAMERA
    );
    background = readColor('--od-bg');
    foreground = readColor('--od-text');
    render();
  }

  function onVisibilityChange() {
    cancelFrame();
    schedule();
  }

  function onMotionChange() {
    cancelFrame();
    if (exit) {
      finish();
      return;
    }
    clock = reducedMotion.matches ? FIRST_FRONT_VIEW : 0;
    render();
    schedule();
  }

  function close() {
    if (disposed) return;
    if (exit || reducedMotion.matches) {
      finish();
      return;
    }
    const yaw = spinAngle(clock);
    exit = {
      time: clock,
      elapsed: 0,
      yaw,
      targetYaw: Math.ceil(yaw / (Math.PI * 2)) * Math.PI * 2,
      offsets: blockOffsets(clock)
    };
    last = null;
    schedule();
  }

  function finish() {
    if (disposed) return;
    dispose();
    onFinish();
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    cancelFrame();
    resizeObserver.disconnect();
    themeObserver.disconnect();
    document.removeEventListener('visibilitychange', onVisibilityChange);
    window.removeEventListener('resize', resize);
    reducedMotion.removeEventListener('change', onMotionChange);
  }

  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(canvas);
  resizeObserver.observe(logo);
  const themeObserver = new MutationObserver(resize);
  themeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['style', 'data-theme']
  });
  document.addEventListener('visibilitychange', onVisibilityChange);
  window.addEventListener('resize', resize);
  reducedMotion.addEventListener('change', onMotionChange);
  resize();
  schedule();
  return { close, dispose };
}
