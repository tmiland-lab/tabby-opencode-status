// Copies the built plugin into Tabby's plugin dir.
// Tabby discovers the package dir and then resolves it with nodeRequire(),
// which follows package.json.main. The installed layout MUST mirror that:
// bundle files go under <dest>/dist/, package.json stays at <dest>/package.json.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..")
const dest =
  process.env.TABBY_PLUGINS_DIR || path.join(os.homedir(), ".config", "tabby", "plugins", "node_modules", "tabby-opencode-status")

for (const f of ["index.js", "index.js.map"]) {
  const src = path.join(root, "dist", f)
  if (!fs.existsSync(src)) {
    console.error(`missing ${src} — run npm run build first`)
    process.exit(1)
  }
}
fs.mkdirSync(path.join(dest, "dist"), { recursive: true })
for (const f of ["index.js", "index.js.map"]) {
  fs.copyFileSync(path.join(root, "dist", f), path.join(dest, "dist", f))
}
for (const f of ["package.json", "README.md"]) {
  fs.copyFileSync(path.join(root, f), path.join(dest, f))
}

// Guard: fail loudly if the installed layout would not resolve, mirroring
// Tabby's loader (nodeRequire on the package dir -> package.json.main).
const pkg = JSON.parse(fs.readFileSync(path.join(dest, "package.json"), "utf8"))
if (!pkg?.main) {
  console.error(`installed package.json has no "main" — Tabby cannot load this plugin`)
  process.exit(1)
}
if (!fs.existsSync(path.join(dest, pkg.main))) {
  console.error(`installed layout mismatches "main" (${pkg.main}): ${path.join(dest, pkg.main)} does not exist — Tabby would silently skip this plugin`)
  process.exit(1)
}
console.log(`installed tabby-opencode-status to ${dest} (main: ${pkg.main})`)