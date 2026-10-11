import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import electron from 'vite-plugin-electron';
import renderer from 'vite-plugin-electron-renderer';
import path from 'path';

export default defineConfig({
  plugins: [
    react(),
    electron([
      {
        entry: { main: 'electron/main.ts', 'usage-worker': 'electron/statistics/usage-worker.ts' },
        onstart({ startup }) {
          startup();
        },
        vite: {
          build: {
            outDir: 'dist-electron',
            sourcemap: false,
            emptyOutDir: true,
            rollupOptions: {
              external: [
                'electron',
                'path',
                'fs',
                'os',
                'node-pty',
                // 扩展加载器(jiti)在运行时用 require.resolve('typebox') 解析 typebox。
                // bundle 后 import.meta.url 指向 dist-electron/main.js，require.resolve
                // 从项目根 node_modules 解析。typebox 必须 external 且在根 node_modules
                // 有链接（见 postinstall 脚本），否则所有插件加载报
                // 'Cannot find module typebox'。
                'typebox',
                'typebox/compile',
                'typebox/value',
                '@sinclair/typebox',
                '@sinclair/typebox/compile',
                '@sinclair/typebox/value'
              ]
            }
          }
        }
      },
      {
        entry: 'preload.ts',
        onstart({ reload }) {
          reload();
        },
        vite: {
          build: {
            outDir: 'dist-electron',
            sourcemap: false
          }
        }
      }
    ]),
    renderer()
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src')
    }
  },
  build: {
    sourcemap: false
  },
  base: './'
});
