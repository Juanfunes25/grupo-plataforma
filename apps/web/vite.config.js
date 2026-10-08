import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  define: { __VERSION__: JSON.stringify(new Date().toISOString().slice(0, 16).replace('T', ' ')) },
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      workbox: { cleanupOutdatedCaches: true, skipWaiting: true, clientsClaim: true, navigateFallbackDenylist: [/^\/api\//] },
      manifest: {
        name: 'Grupo · Plataforma', short_name: 'Grupo', theme_color: '#0e1320', background_color: '#0e1320', display: 'standalone',
        icons: [{ src: '/icono.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' }],
      },
    }),
  ],
  server: { port: 5180, proxy: { '/api': 'http://localhost:4300' } },
});
