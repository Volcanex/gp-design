import { describe, test, expect } from 'vitest';
import { generateCube, generateTorus, generateIcosphere } from '../../src/engine/sources/builtin/mesh-gen';

function normalsUnitLength(vertices: Float32Array, vertexCount: number, tolerance = 1e-5): void {
  for (let i = 0; i < vertexCount; i++) {
    const off = i * 6 + 3;
    const nx = vertices[off]!;
    const ny = vertices[off + 1]!;
    const nz = vertices[off + 2]!;
    const len = Math.hypot(nx, ny, nz);
    expect(Math.abs(len - 1)).toBeLessThan(tolerance);
  }
}

describe('generateCube', () => {
  test('24 vertices, 36 indices, hard face normals unit length', () => {
    const mesh = generateCube();
    expect(mesh.vertexCount).toBe(24);
    expect(mesh.indexCount).toBe(36);
    expect(mesh.vertices.length).toBe(24 * 6);
    expect(mesh.indices.length).toBe(36);
    normalsUnitLength(mesh.vertices, mesh.vertexCount);
  });
});

describe('generateTorus', () => {
  test('vertex/index counts match major*minor segments, normals unit length', () => {
    const mesh = generateTorus(0.35, 0.15, 32, 16);
    expect(mesh.vertexCount).toBe(32 * 16);
    expect(mesh.indexCount).toBe(32 * 16 * 6);
    normalsUnitLength(mesh.vertices, mesh.vertexCount);
  });

  test('smaller segment counts still produce a closed, consistent grid', () => {
    const mesh = generateTorus(0.4, 0.1, 8, 6);
    expect(mesh.vertexCount).toBe(8 * 6);
    expect(mesh.indexCount).toBe(8 * 6 * 6);
    normalsUnitLength(mesh.vertices, mesh.vertexCount);
    // every index must reference a real vertex
    for (const idx of mesh.indices) {
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(idx).toBeLessThan(mesh.vertexCount);
    }
  });
});

describe('generateIcosphere', () => {
  test('subdivision 0 is the base icosahedron: 12 vertices, 20 faces', () => {
    const mesh = generateIcosphere(0);
    expect(mesh.vertexCount).toBe(12);
    expect(mesh.indexCount).toBe(20 * 3);
    normalsUnitLength(mesh.vertices, mesh.vertexCount);
  });

  test('each subdivision quadruples face count (20 * 4^n)', () => {
    for (const subdivisions of [1, 2, 3]) {
      const mesh = generateIcosphere(subdivisions);
      const expectedFaces = 20 * 4 ** subdivisions;
      expect(mesh.indexCount).toBe(expectedFaces * 3);
      normalsUnitLength(mesh.vertices, mesh.vertexCount);
    }
  });

  test('normal equals position (unit sphere centered at origin)', () => {
    const mesh = generateIcosphere(1);
    for (let i = 0; i < mesh.vertexCount; i++) {
      const off = i * 6;
      expect(mesh.vertices[off]).toBeCloseTo(mesh.vertices[off + 3]!, 6);
      expect(mesh.vertices[off + 1]).toBeCloseTo(mesh.vertices[off + 4]!, 6);
      expect(mesh.vertices[off + 2]).toBeCloseTo(mesh.vertices[off + 5]!, 6);
    }
  });
});
