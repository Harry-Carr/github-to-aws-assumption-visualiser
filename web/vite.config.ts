import { defineConfig } from "vite";

/**
 * Relative base so the same build works on:
 * - https://<user>.github.io/<repo>/  (project Pages)
 * - https://<user>.github.io/         (user/org site root)
 * - local `vite preview`
 *
 * Override with VITE_BASE=/custom/ if you need an absolute subpath.
 */
export default defineConfig({
  base: process.env.VITE_BASE || "./",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    assetsDir: "assets",
  },
});
