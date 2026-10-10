import { defineConfig } from '@playwright/test';

// SwiftShader WebGPU flags empirically confirmed on this host (no GPU).
// Do NOT add --enable-features=Vulkan/--use-angle=vulkan/--use-vulkan=swiftshader:
// that set hangs adapter acquisition on this Chromium build.
export const webgpuFlags = [
  '--enable-unsafe-webgpu',
  '--use-webgpu-adapter=swiftshader',
  '--no-sandbox',
  '--disable-dev-shm-usage',
];

// Tests run against the systemd-served dist on :8095 (unit `gdesign`):
// ad-hoc vite preview processes don't survive this host's session sandbox.
// ALWAYS `npm run build` before `npm run e2e`, or you test stale code.
export default defineConfig({
  testDir: 'tests/e2e',
  workers: 1,
  fullyParallel: false,
  timeout: 120_000,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: process.env.GDESIGN_BASE_URL ?? 'http://127.0.0.1:8095',
    launchOptions: { args: webgpuFlags },
    trace: 'retain-on-failure',
  },
});
