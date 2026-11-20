import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/ws': {
        target: 'ws://localhost:3000',
        ws: true,
      },
      '/preview': {
        target: 'http://localhost:3000',
      },
      // 添付のアップロード。changeOrigin は付けない（Host を書き換えるとサーバーの Origin 照合に落ちる）
      '/attachments': {
        target: 'http://localhost:3000',
      },
    },
  },
});
