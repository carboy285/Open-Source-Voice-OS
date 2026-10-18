// Bundles the core and CLI into one ESM file for the installers: build/core/murmur-core.mjs
import { build } from "esbuild";
import { mkdir } from "node:fs/promises";

await mkdir("build/core", { recursive: true });
await build({
  entryPoints: ["src/cli/main.ts"],
  outfile: "build/core/murmur-core.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  minify: false,
  sourcemap: false,
  legalComments: "external",
  // Some dependencies still call require(); give the ESM bundle one.
  banner: {
    js: "import { createRequire as __murmurRequire } from 'node:module'; const require = __murmurRequire(import.meta.url);",
  },
  logLevel: "info",
});
