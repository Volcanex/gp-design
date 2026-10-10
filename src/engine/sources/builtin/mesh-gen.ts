/**
 * Procedural mesh generators for core.3d. Each returns interleaved
 * [px,py,pz, nx,ny,nz] vertex data (stride 24 bytes) plus a uint32 index
 * buffer. Pure CPU/math (no GPU handles), so these are unit-testable
 * without a device.
 */

export interface MeshData {
  /** Interleaved position(3) + normal(3) per vertex. */
  vertices: Float32Array;
  indices: Uint32Array;
  vertexCount: number;
  indexCount: number;
}

function pushVertex(out: number[], p: readonly [number, number, number], n: readonly [number, number, number]): void {
  out.push(p[0], p[1], p[2], n[0], n[1], n[2]);
}

/** Unit cube (half-extent 0.5), hard face normals: 24 vertices, 36 indices. */
export function generateCube(): MeshData {
  const verts: number[] = [];
  const indices: number[] = [];

  const faces: Array<{ normal: [number, number, number]; corners: [number, number, number][] }> = [
    { normal: [0, 0, 1], corners: [[-0.5, -0.5, 0.5], [0.5, -0.5, 0.5], [0.5, 0.5, 0.5], [-0.5, 0.5, 0.5]] },
    { normal: [0, 0, -1], corners: [[0.5, -0.5, -0.5], [-0.5, -0.5, -0.5], [-0.5, 0.5, -0.5], [0.5, 0.5, -0.5]] },
    { normal: [1, 0, 0], corners: [[0.5, -0.5, 0.5], [0.5, -0.5, -0.5], [0.5, 0.5, -0.5], [0.5, 0.5, 0.5]] },
    { normal: [-1, 0, 0], corners: [[-0.5, -0.5, -0.5], [-0.5, -0.5, 0.5], [-0.5, 0.5, 0.5], [-0.5, 0.5, -0.5]] },
    { normal: [0, 1, 0], corners: [[-0.5, 0.5, 0.5], [0.5, 0.5, 0.5], [0.5, 0.5, -0.5], [-0.5, 0.5, -0.5]] },
    { normal: [0, -1, 0], corners: [[-0.5, -0.5, -0.5], [0.5, -0.5, -0.5], [0.5, -0.5, 0.5], [-0.5, -0.5, 0.5]] },
  ];

  for (const face of faces) {
    const base = verts.length / 6;
    for (const c of face.corners) pushVertex(verts, c, face.normal);
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }

  return {
    vertices: new Float32Array(verts),
    indices: new Uint32Array(indices),
    vertexCount: verts.length / 6,
    indexCount: indices.length,
  };
}

/**
 * Torus, analytic smooth normals. No seam duplication (indices wrap via
 * modulo), so vertexCount = majorSegments * minorSegments exactly.
 * Normal = (cos(phi)cos(theta), cos(phi)sin(theta), sin(phi)) is already
 * unit length by construction (cos^2+sin^2 identity), no normalize needed.
 */
export function generateTorus(
  majorRadius = 0.35,
  minorRadius = 0.15,
  majorSegments = 32,
  minorSegments = 16,
): MeshData {
  const verts: number[] = [];
  const indices: number[] = [];

  for (let i = 0; i < majorSegments; i++) {
    const theta = (i / majorSegments) * Math.PI * 2;
    const ct = Math.cos(theta);
    const st = Math.sin(theta);
    for (let j = 0; j < minorSegments; j++) {
      const phi = (j / minorSegments) * Math.PI * 2;
      const cp = Math.cos(phi);
      const sp = Math.sin(phi);
      const pos: [number, number, number] = [
        (majorRadius + minorRadius * cp) * ct,
        (majorRadius + minorRadius * cp) * st,
        minorRadius * sp,
      ];
      const normal: [number, number, number] = [cp * ct, cp * st, sp];
      pushVertex(verts, pos, normal);
    }
  }

  for (let i = 0; i < majorSegments; i++) {
    const ni = (i + 1) % majorSegments;
    for (let j = 0; j < minorSegments; j++) {
      const nj = (j + 1) % minorSegments;
      const a = i * minorSegments + j;
      const b = ni * minorSegments + j;
      const c = ni * minorSegments + nj;
      const d = i * minorSegments + nj;
      indices.push(a, b, c, a, c, d);
    }
  }

  return {
    vertices: new Float32Array(verts),
    indices: new Uint32Array(indices),
    vertexCount: verts.length / 6,
    indexCount: indices.length,
  };
}

type Vec3 = [number, number, number];

function normalize(v: Vec3): Vec3 {
  const len = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / len, v[1] / len, v[2] / len];
}

function midpoint(a: Vec3, b: Vec3): Vec3 {
  return normalize([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2]);
}

/**
 * Icosphere: base icosahedron (12 verts, 20 faces), subdivided `subdivisions`
 * times with a midpoint cache so shared edges don't duplicate vertices.
 * Radius 1, centered at origin, so normal = position for every vertex
 * (already unit length after normalize()).
 */
export function generateIcosphere(subdivisions = 2): MeshData {
  const t = (1 + Math.sqrt(5)) / 2;

  let positions: Vec3[] = [
    normalize([-1, t, 0]), normalize([1, t, 0]), normalize([-1, -t, 0]), normalize([1, -t, 0]),
    normalize([0, -1, t]), normalize([0, 1, t]), normalize([0, -1, -t]), normalize([0, 1, -t]),
    normalize([t, 0, -1]), normalize([t, 0, 1]), normalize([-t, 0, -1]), normalize([-t, 0, 1]),
  ];

  let faces: [number, number, number][] = [
    [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11],
    [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
    [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9],
    [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
  ];

  for (let s = 0; s < subdivisions; s++) {
    const midCache = new Map<string, number>();
    const nextFaces: [number, number, number][] = [];

    function getMidIndex(ia: number, ib: number): number {
      const key = ia < ib ? `${ia}_${ib}` : `${ib}_${ia}`;
      const cached = midCache.get(key);
      if (cached !== undefined) return cached;
      const idx = positions.length;
      positions.push(midpoint(positions[ia]!, positions[ib]!));
      midCache.set(key, idx);
      return idx;
    }

    for (const [a, b, c] of faces) {
      const ab = getMidIndex(a, b);
      const bc = getMidIndex(b, c);
      const ca = getMidIndex(c, a);
      nextFaces.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]);
    }
    faces = nextFaces;
  }

  const verts: number[] = [];
  for (const p of positions) pushVertex(verts, p, p);
  const indices = faces.flat();

  return {
    vertices: new Float32Array(verts),
    indices: new Uint32Array(indices),
    vertexCount: positions.length,
    indexCount: indices.length,
  };
}
