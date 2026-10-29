import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const rootDir = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@main': path.resolve(rootDir, 'src/main')
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      lib: {
        entry: path.resolve(rootDir, 'src/preload/index.ts'),
        formats: ['cjs']
      },
      rollupOptions: {
        output: {
          entryFileNames: '[name].cjs',
          inlineDynamicImports: true
        }
      }
    }
  },
  renderer: {
    root: path.resolve(rootDir, 'src/renderer'),
    plugins: [react()],
    resolve: {
      alias: {
        '@renderer': path.resolve(rootDir, 'src/renderer/src')
      }
    }
  }
})
