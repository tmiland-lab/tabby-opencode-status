// Bundle smoke test: loads dist/index.js with stubbed Tabby/Angular externals,
// instantiates the real bridge + module with fake services, starts/stops clean.
// Proves the UMD bundle is well-formed and the startup path doesn't crash.
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
// Isolate: the real bridge writes its load marker + spool files under
// os.tmpdir() — keep smoke artifacts out of the live /tmp Tabby watches.
process.env.TMPDIR = fs.mkdtempSync(path.join(os.tmpdir(), "tabby-os-smoke-"))
const Module = require("node:module")
require("reflect-metadata")

const noOpDeco = () => () => {}
const Identity = class {}

const stubs = {
  "@angular/core": { Injectable: noOpDeco, Component: noOpDeco, NgModule: noOpDeco, Input: noOpDeco, Injector: Identity },
  "@angular/common": { CommonModule: Identity },
  "@angular/forms": { FormsModule: Identity },
  "terminus-core": {
    ConfigService: Identity,
    AppService: Identity,
    ConfigProvider: Identity,
    BaseTabComponent: Identity,
    SplitTabComponent: Identity,
  },
  "terminus-terminal": { BaseTerminalTabComponent: Identity },
  "terminus-settings": { SettingsTabProvider: Identity },
  "tabby-local": { TerminalService: Identity },
}

const origLoad = Module._load
Module._load = function (request, ...rest) {
  if (request in stubs) return stubs[request]
  return origLoad.call(this, request, ...rest)
}

const bundle = require("../dist/index.js")
if (typeof bundle.default !== "function") throw new Error("default export is not the module class")

const { OpencodeStatusBridge } = require("../dist-test/src/tabby/bridge.service.js")
const bridge = new OpencodeStatusBridge({ tabs: [] }, { store: {}, save: () => {} }, {})
new (bundle.default)(bridge) // module ctor starts polling
bridge.stop()
console.log("OK bundle: default-export module + bridge start/stop clean")
