import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './test/headless',
  timeout: 120_000,
  retries: 0,
  reporter: 'list',
  use: {
    baseURL: 'http://localhost:5188',
    viewport: { width: 1920, height: 1080 },
    // Use system Chrome if CHROME=1 env var is set (better WebGPU support)
    channel: process.env.CHROME ? 'chrome' : undefined,
    headless: process.env.HEADED ? false : true,
    launchOptions: {
      args: [
        '--enable-unsafe-webgpu',
        '--enable-features=Vulkan',
        '--use-gl=angle',
        '--use-angle=metal',  // macOS Metal backend
      ],
    },
  },
  webServer: {
    command: 'npx vite --port 5188',
    port: 5188,
    reuseExistingServer: true,
    timeout: 15_000,
  },
});
