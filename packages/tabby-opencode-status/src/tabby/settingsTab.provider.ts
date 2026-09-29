import { Injectable } from "@angular/core"
import { SettingsTabProvider } from "terminus-settings"
import { OpencodeStatusSettingsTabComponent } from "./settingsTab.component"

@Injectable()
export class OpencodeStatusSettingsTabProvider extends SettingsTabProvider {
  id = "opencode-status"
  title = "Opencode Status"

  getComponentType(): new (...args: never[]) => unknown {
    return OpencodeStatusSettingsTabComponent
  }
}
