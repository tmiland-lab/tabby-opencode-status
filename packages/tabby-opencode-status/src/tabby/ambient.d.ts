// Ambient declarations for the Tabby/Angular modules this plugin consumes.
// At runtime inside Tabby these are provided as externals (proven by the
// installed tabby-quick-cmds bundle, which requires the same specifiers).
// The shapes belowmirror the installed Tabby 1.0.231 typings
// (tabby-core / tabby-terminal / tabby-settings); keep them in sync when
// upgrading the target Tabby version.

declare module "@angular/core" {
  export declare function Injectable(): ClassDecorator
  export declare function Component(meta: Record<string, unknown>): ClassDecorator
  export declare function NgModule(meta: Record<string, unknown>): ClassDecorator
  export declare function Input(): PropertyDecorator
  export declare class Injector {
    get<T>(token: new (...args: never[]) => T, notFoundValue?: T): T
  }
}

declare module "@angular/common" {
  export declare class CommonModule {}
}

declare module "@angular/forms" {
  export declare class FormsModule {}
}

declare module "terminus-core" {
  // Default export is the core Angular module (AppModule). It declares and
  // exports ToggleComponent, so plugin modules must import it for <toggle>.
  const coreModule: unknown
  export default coreModule
  export declare class ConfigService {
    store: Record<string, any>
    save(): void
    changed$: { subscribe(cb: () => void): { unsubscribe(): void } }
  }
  export declare class AppService {
    tabs: BaseTabComponent[]
    activeTab: BaseTabComponent | null
    tabOpened$: { subscribe(cb: (tab: BaseTabComponent) => void): { unsubscribe(): void } }
  }
  export declare class ConfigProvider {
    defaults: Record<string, unknown>
    platformDefaults: Record<string, unknown>
  }
  export declare class BaseTabComponent {
    title: string
    customTitle: string
    color: string | null
    hasActivity: boolean
    parent: BaseTabComponent | null
    titleChange$: { subscribe(cb: (t: string) => void): { unsubscribe(): void } }
    destroyed$: { subscribe(cb: () => void): { unsubscribe(): void } }
    setTitle(title: string): void
    setProgress(p: number | null): void
    displayActivity(): void
    clearActivity(): void
  }
  export declare class SplitTabComponent extends BaseTabComponent {
    getAllTabs(): BaseTabComponent[]
  }
}

declare module "terminus-terminal" {
  // session is typed any: local/SSH/serial sessions differ, the bridge
  // feature-detects getChildProcesses structurally at runtime.
  export declare class BaseTerminalTabComponent {
    session: any
    sessionChanged$: { subscribe(cb: () => void): { unsubscribe(): void } }
  }
}

declare module "terminus-settings" {
  export declare class SettingsTabProvider {
    id: string
    title: string
    getComponentType(): new (...args: any[]) => unknown
  }
}

declare module "tabby-local" {
  export declare class TerminalService {
    openTab(profile?: any, cwd?: string | null, pause?: boolean): Promise<any>
  }
}
