import esbuild from "esbuild";
import process from "process";
import builtins from "builtin-modules";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "node:url";
import paths from "./scripts/paths.cjs";

const production = process.argv[2] === "production";
const projectDir = path.dirname(fileURLToPath(import.meta.url));
const { buildDir } = paths;
const manifest = JSON.parse(fs.readFileSync(path.join(projectDir, "manifest.json"), "utf8"));
const pkg = JSON.parse(fs.readFileSync(path.join(projectDir, "package.json"), "utf8").replace(/^\uFEFF/, ""));
if (manifest.version !== pkg.version) throw new Error("Manifest and package versions differ.");
fs.mkdirSync(buildDir, { recursive: true });

const banner =
  `/* Local Incremental Reading v${manifest.version}. Inspired by ebAobS/roaming-mode-incremental-reading; see LICENSE_NOTES.md. */`;

await esbuild.build({
  banner: {
    js: banner
  },
  entryPoints: ["main.ts"],
  absWorkingDir: projectDir,
  bundle: true,
  external: ["obsidian", "electron", "node:*", "@codemirror/autocomplete", "@codemirror/collab", "@codemirror/commands", "@codemirror/language", "@codemirror/lint", "@codemirror/search", "@codemirror/state", "@codemirror/view", "@lezer/common", "@lezer/highlight", "@lezer/lr", ...builtins],
  format: "cjs",
  target: "es2018",
  logLevel: "info",
  sourcemap: production ? false : "inline",
  treeShaking: true,
  outfile: path.join(buildDir, "main.js")
});

for (const file of ["manifest.json", "styles.css"]) {
  fs.copyFileSync(path.join(projectDir, file), path.join(buildDir, file));
}
console.log(`Built ${manifest.version}: ${buildDir} (not deployed)`);
