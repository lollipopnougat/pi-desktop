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
          resolve: {
            alias: {
              // SDK 的 exports 地图只开放 `.`/`./rpc-entry`/`./client`/`./experimental/plugin`，
              // 而 exportSessionToHtml/exportFromFile 只存在于 dist 里。用 alias 指到真实文件，
              // 随主进程一起 bundle（见 electron/sdk-export-html.ts）。
              '@pi-export-html': path.resolve(
                __dirname,
                'node_modules/@earendil-works/pi-coding-agent/dist/core/export-html/index.js'
              )
            }
          },
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
