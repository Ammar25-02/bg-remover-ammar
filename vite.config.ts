import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // Relative asset paths so the build works on GitHub Pages under /<repo-name>/.
  base: './',
  // onnxruntime-web ships its own .wasm files; let it load them at runtime.
  optimizeDeps: { exclude: ['@huggingface/transformers'] },
  worker: { format: 'es' },
})
