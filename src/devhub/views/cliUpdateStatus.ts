const vscode:any=require('vscode');
import { VersionDrift, checkVersionDrift, updateCommandFor } from '../providers/cliVersion';
import { ProcessRunner } from '../providers/processRunner';

/**
 * A gentle warning when an npm-installed CLI falls behind the registry — a global npm install
 * can't update itself, and when run through Dev Hub the CLI's "update available" banner is swallowed
 * because the transport is stream-json, not a terminal. Fully hidden when versions match.
 */
export class CliUpdateStatus {
  private item:any;private drifts:VersionDrift[]=[];
  constructor(private runner:ProcessRunner,
    private executables:()=>{[provider:string]:string},
    private cache:{get():any;set(v:any):void},
    private enabled:()=>boolean){
    this.item=vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right,79);
    this.item.command='devhub.updateCli';this.item.hide();
  }
  dispose(){this.item.dispose();}
  current(){return this.drifts;}
  async refresh(){
    if(!this.enabled()){this.drifts=[];this.item.hide();return;}
    try{this.drifts=await checkVersionDrift({runner:this.runner,executables:this.executables(),cache:this.cache});}
    catch{this.drifts=[];}
    if(!this.drifts.length){this.item.hide();return;}
    this.item.text=this.drifts.length===1
      ?`$(arrow-up) ${this.drifts[0].provider} ${this.drifts[0].installed} → ${this.drifts[0].latest}`
      :`$(arrow-up) ${this.drifts.length} CLI updates`;
    this.item.tooltip=[...this.drifts.map(d=>`${d.provider}: ${d.installed} → ${d.latest}  (${updateCommandFor(d.pkg)})`),
      '','Click to update in a terminal.'].join('\n');
    this.item.show();
  }
}
