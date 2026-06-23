import { defineConfig } from 'vite';

// `base: './'` keeps all asset URLs relative, so the same build works both
// at a domain root (local `vite preview`) and under a GitHub Pages subpath
// (https://<user>.github.io/<repo>/) without extra configuration.
export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
  },
});
