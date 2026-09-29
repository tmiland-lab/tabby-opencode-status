import { Component } from "@angular/core"
import { ConfigService } from "terminus-core"
import { OpencodeStatusBridge } from "./bridge.service"

@Component({
  selector: "opencode-status-settings",
  template: `
<h3>Opencode Status</h3>
<div class="form-group">
  <label>Tab color on status change</label>
  <toggle [(ngModel)]="config.store.opencodeStatus.showTabColor" (ngModelChange)="save()"></toggle>
</div>
<div class="form-group">
  <label>Title emoji prefix</label>
  <toggle [(ngModel)]="config.store.opencodeStatus.showTitleEmoji" (ngModelChange)="save()"></toggle>
</div>
<div class="form-group">
  <label>Progress bar while working</label>
  <toggle [(ngModel)]="config.store.opencodeStatus.showProgress" (ngModelChange)="save()"></toggle>
</div>
<div class="form-group">
  <label>Activity dot when input is needed</label>
  <toggle [(ngModel)]="config.store.opencodeStatus.showActivityDot" (ngModelChange)="save()"></toggle>
</div>
<div class="form-group">
  <label>Auto-resume saved sessions on Tabby launch</label>
  <toggle [(ngModel)]="config.store.opencodeStatus.autoResume" (ngModelChange)="save()"></toggle>
</div>
<div class="form-group">
  <label>Resume command</label>
  <input class="form-control" [(ngModel)]="config.store.opencodeStatus.resumeCommand" (ngModelChange)="save()" />
</div>
<h4 class="mt-3">Saved opencode sessions</h4>
<div class="form-group">
  <button class="btn btn-outline-primary" (click)="bridge.resumeAllSessions()">Resume all now</button>
</div>
<div class="list-group">
  <div class="list-group-item d-flex align-items-center" *ngFor="let s of bridge.getSessions()">
    <div class="mr-auto"><div>{{s.title}}</div><div class="text-muted">{{s.cwd}}</div></div>
    <button class="btn btn-outline-info ml-2" (click)="bridge.resumeSession(s)">Resume</button>
    <button class="btn btn-outline-danger ml-1" (click)="bridge.forgetSession(s.cwd)">Forget</button>
  </div>
</div>
  `,
})
export class OpencodeStatusSettingsTabComponent {
  constructor(
    public config: ConfigService,
    public bridge: OpencodeStatusBridge,
  ) {}

  save(): void {
    this.config.save()
  }
}
