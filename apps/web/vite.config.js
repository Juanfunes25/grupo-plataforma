import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  define: { __VERSION__: JSON.stringify(new Date().toISOString().slice(0, 16).replace('T', ' ')) },
  plugins: [
    react(),
    VitePWA({
      // «prompt»: la versión nueva se descarga sola y la app avisa con un botón (no recarga a media venta); ver ui/AvisoVersion.jsx.
      registerType: 'prompt',
      workbox: { globPatterns: ['**/*.{js,css,html,woff2}'], cleanupOutdatedCaches: true, skipWaiting: false, clientsClaim: true, navigateFallbackDenylist: [/^\/api\//, /^\/manifiestos\//, /^\/icons\//] },
      // Manifiesto base (sin empresa). Al entrar a una empresa, la app cambia al de public/manifiestos/<empresa>.webmanifest
      // (iconos, color y atajos propios; cada empresa se instala como su propia app).
      manifest: {
        id: '/', name: 'Grupo · Plataforma', short_name: 'Grupo', description: 'Plataforma del Grupo: Italo, Origen, EcoStone y DISERCO',
        lang: 'es-HN', start_url: '/', scope: '/', display: 'standalone', display_override: ['standalone', 'minimal-ui'], orientation: 'any',
        theme_color: '#0e1320', background_color: '#0e1320', categories: ['business', 'productivity'],
        icons: [
          { src: '/icons/base-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: '/icons/base-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: '/icons/base-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          { src: '/icono.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
        ],
      },
    }),
  ],
  build: {
    rollupOptions: {
      output: {
        // React y el enrutador cambian poco: en un archivo aparte se quedan en la caché del teléfono aunque la app se actualice todos los días.
        manualChunks(id) {
          if (/node_modules\/(react|react-dom|scheduler|react-router|react-router-dom|@remix-run\/router)\//.test(id)) return 'vendor-react';
          return undefined;
        },
      },
    },
  },
  server: { port: 5180, proxy: { '/api': 'http://localhost:4300' } },
});
