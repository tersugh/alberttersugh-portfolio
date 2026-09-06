import { mkdir, copyFile, writeFile, rm } from "node:fs/promises";
import { build } from "esbuild";
import { publicConfig } from "./config.mjs";
// Explicit allowlist: no other environment variables or source files enter dist.
try {
  process.loadEnvFile(".env");
} catch (e) {
  if (e.code !== "ENOENT") throw e;
}
const config = publicConfig(process.env);
await rm("dist", { recursive: true, force: true });
for (const dir of ["blog", "admin/blog", "assets/blog"])
  await mkdir(`dist/${dir}`, { recursive: true });
for (const file of [
  "index.html",
  "blog/index.html",
  "blog/post.html",
  "admin/blog/index.html",
  "assets/blog/blog.css",
])
  await copyFile(file, `dist/${file}`);
await writeFile(
  "dist/assets/blog/config.js",
  `window.BLOG_CONFIG = Object.freeze(${JSON.stringify(config)});\n`,
);
await build({
  tsconfigRaw: {},
  entryPoints: ["assets/blog/public.js", "assets/blog/admin.js"],
  outdir: "dist/assets/blog",
  bundle: true,
  splitting: true,
  format: "esm",
  minify: true,
  target: ["es2022"],
  legalComments: "eof",
});
await copyFile(
  "node_modules/quill/dist/quill.snow.css",
  "dist/assets/blog/editor.css",
);
console.log("Built static portfolio and blog into dist/");
