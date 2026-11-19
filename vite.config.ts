import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'
import { fileURLToPath } from 'node:url'

// PunchIn build config. `--mode mock` swaps the live database for sample data (UI tests only).
export default defineConfig(({ mode }) => ({
  base: './',
  resolve: {
    alias: {
      '@backend': fileURLToPath(new URL(mode === 'mock' ? './src/lib/backend.mock.ts' : './src/lib/backend.live.ts', import.meta.url)),
    },
  },
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icon.svg', 'apple-touch-icon.png'],
      manifest: {
        name: 'PunchIn — Office Attendance',
        short_name: 'PunchIn',
        description: 'Check in, check out, leaves and reports for your office. Developed by Hitesh Dubey.',
        theme_color: '#F26B1D',
        background_color: '#FFFFFF',
        display: 'standalone',
        orientation: 'portrait',
        start_url: './',
        scope: './',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        navigateFallback: 'index.html',
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        runtimeCaching: [{ urlPattern: /config\.json$/, handler: 'NetworkFirst' }],
      },
    }),
  ],
}))
