import * as esbuild from "esbuild";
import { cpSync, mkdirSync, existsSync } from "node:fs";

const watch = process.argv.includes("--watch");
const outdir = "dist";

if (!existsSync(outdir)) mkdirSync(outdir);

cpSync("manifest.json", `${outdir}/manifest.json`);
cpSync("src/content/panel.css", `${outdir}/panel.css`);
if (existsSync("icons")) cpSync("icons", `${outdir}/icons`, { recursive: true });

const contentCtx = await esbuild.context({
  entryPoints: ["src/content/content.ts"],
  bundle: true,
  outfile: `${outdir}/content.js`,
  format: "iife",
  target: "chrome110",
  sourcemap: true,
  logLevel: "info",
});

const backgroundCtx = await esbuild.context({
  entryPoints: ["src/background/background.ts"],
  bundle: true,
  outfile: `${outdir}/background.js`,
  format: "esm",
  target: "chrome110",
  sourcemap: true,
  logLevel: "info",
});

if (watch) {
  await Promise.all([contentCtx.watch(), backgroundCtx.watch()]);
  console.log("Watching for changes... (load dist/ as an unpacked extension)");
} else {
  await Promise.all([contentCtx.rebuild(), backgroundCtx.rebuild()]);
  await Promise.all([contentCtx.dispose(), backgroundCtx.dispose()]);
  console.log("Build complete -> dist/");
}
