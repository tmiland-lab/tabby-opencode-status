// Production bundle for Tabby: UMD, Tabby/Angular externals provided by the
// host at runtime (same shape as the installed tabby-quick-cmds bundle).
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.dirname(fileURLToPath(import.meta.url))

export default {
  mode: "production",
  target: "node",
  context: root,
  entry: "./src/tabby/index.ts",
  output: {
    path: path.join(root, "dist"),
    filename: "index.js",
    library: { type: "umd" },
  },
  externals: [/^@angular\//, "terminus-core", "terminus-terminal", "terminus-settings", "tabby-local", /^rxjs/],
  resolve: { extensions: [".ts", ".js"] },
  module: {
    rules: [{ test: /\.ts$/, use: { loader: "ts-loader", options: { transpileOnly: true } } }],
  },
  devtool: "source-map",
}
