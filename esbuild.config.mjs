import esbuild from "esbuild";
import process from "process";
import builtins from "builtin-modules";
import fs from "fs";
import path from "path";

const production = process.argv[2] === "production";
const artifactDir = process.env.LOCAL_IR_BUILD_DIR;
const installDir = path.resolve("../../.obsidian/plugins/local-ir");

const banner =
  "/* Local Incremental Reading v0.8.9. Inspired by ebAobS/roaming-mode-incremental-reading; see LICENSE_NOTES.md. */";

await esbuild.build({
  banner: {
    js: banner
  },
  entryPoints: ["main.ts"],
  bundle: true,
  external: ["obsidian", "electron", "@codemirror/autocomplete", "@codemirror/collab", "@codemirror/commands", "@codemirror/language", "@codemirror/lint", "@codemirror/search", "@codemirror/state", "@codemirror/view", "@lezer/common", "@lezer/highlight", "@lezer/lr", ...builtins],
  format: "cjs",
  target: "es2018",
  logLevel: "info",
  sourcemap: production ? false : "inline",
  treeShaking: true,
  outfile: artifactDir ? path.join(artifactDir, "main.js") : "main.js"
});

const outputDir = artifactDir || installDir;
fs.mkdirSync(outputDir, { recursive: true });
for (const file of ["main.js", "manifest.json", "styles.css"]) {
  if (artifactDir && file === "main.js") continue;
  fs.copyFileSync(path.resolve(file), path.join(outputDir, file));
}
