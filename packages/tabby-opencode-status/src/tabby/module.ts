import { NgModule } from "@angular/core"
import { CommonModule } from "@angular/common"
import { FormsModule } from "@angular/forms"
import TerminusCoreModule, { ConfigProvider } from "terminus-core"
import { SettingsTabProvider } from "terminus-settings"
import fs from "fs"
import os from "os"
import path from "path"
import { OpencodeStatusBridge } from "./bridge.service"
import { OpencodeStatusConfigProvider } from "./config.provider"
import { OpencodeStatusSettingsTabComponent } from "./settingsTab.component"
import { OpencodeStatusSettingsTabProvider } from "./settingsTab.provider"

// Black-box load marker: proves the bundle executed inside Tabby (or captures
// the exact error if it dies during startup).
function marker(data: Record<string, unknown>): void {
  try {
    fs.writeFileSync(
      path.join(os.tmpdir(), "tabby-opencode-status.marker.json"),
      JSON.stringify({ ts: Date.now(), ...data }),
    )
  } catch {
    // ignore
  }
}

@NgModule({
  // TerminusCoreModule declares/exports <toggle>; without it the settings
  // toggles are unknown elements and silently render nothing.
  imports: [CommonModule, FormsModule, TerminusCoreModule],
  providers: [
    OpencodeStatusBridge,
    { provide: ConfigProvider, useClass: OpencodeStatusConfigProvider, multi: true },
    { provide: SettingsTabProvider, useClass: OpencodeStatusSettingsTabProvider, multi: true },
  ],
  declarations: [OpencodeStatusSettingsTabComponent],
})
export default class OpencodeStatusModule {
  // Instantiating the bridge starts the spool poll loop.
  constructor(bridge: OpencodeStatusBridge) {
    try {
      bridge.start()
      marker({ loaded: true })
    } catch (e) {
      marker({ loaded: false, error: String(e), stack: (e as Error)?.stack })
    }
  }
}

// Bundle-evaluation probe: runs at require() time, before Angular touches us.
// If this marker exists but no loaded:true marker, DI/instantiation failed.
// If neither exists, the bundle never evaluated (discovery/require problem).
marker({ phase: "import" })
