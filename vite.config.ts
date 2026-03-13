import { defineConfig, type Plugin } from 'vite';
import glsl from 'vite-plugin-glsl';
import * as fs from 'fs';
import * as path from 'path';

/** Serve onnxruntime WASM/MJS files from public/ even when Vite appends ?import */
function ortWasmPlugin(): Plugin {
  return {
    name: 'ort-wasm-serve',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url || '';
        // Match ort-wasm-*.mjs or ort-wasm-*.wasm with optional ?import query
        const match = url.match(/^\/(ort-wasm[^?]+\.(mjs|wasm))(\?.*)?$/);
        if (match) {
          const filePath = path.join(process.cwd(), 'public', match[1]);
          if (fs.existsSync(filePath)) {
            const mimeType = match[2] === 'wasm' ? 'application/wasm' : 'text/javascript';
            res.setHeader('Content-Type', mimeType);
            res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
            res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
            fs.createReadStream(filePath).pipe(res);
            return;
          }
        }
        next();
      });
    },
  };
}

export default defineConfig({
  plugins: [
    glsl({
      include: ['**/*.wgsl'],
      defaultExtension: 'wgsl',
    }),
    ortWasmPlugin(),
  ],
  assetsInclude: ['**/*.onnx'],
  build: {
    target: 'esnext',
  },
  server: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
});
