import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy: { '/api': `http://127.0.0.1:${process.env.SERVER_PORT ?? 7331}` } },
  build: {
    target: 'es2022',
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('pdfjs-dist')) return 'pdf';
          if (id.includes('@tiptap') || id.includes('prosemirror')) return 'editor';
          if (id.includes('@xyflow')) return 'graph';
          if (id.includes('katex')) return 'math';
        },
      },
    },
  },
});
