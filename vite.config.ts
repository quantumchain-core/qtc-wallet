import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // Tauri expects a fixed port during dev
  server: { port: 5173, strictPort: true },
  // Inline env vars for Tauri
  envPrefix: ['VITE_', 'TAURI_'],
  build: { target: 'es2020' },
});
