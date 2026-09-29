import { Injectable } from "@angular/core"
import { ConfigProvider } from "terminus-core"
import { DEFAULT_CONFIG } from "../interfaces/types"

@Injectable()
export class OpencodeStatusConfigProvider extends ConfigProvider {
  defaults = {
    opencodeStatus: {
      ...DEFAULT_CONFIG,
      spoolDir: "",
      pollMs: 500,
      autoResume: false,
      resumeCommand: "opencode --continue",
      sessions: [],
    },
  }
  platformDefaults = {}
}
