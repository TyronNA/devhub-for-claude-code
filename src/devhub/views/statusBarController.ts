const vscode:any=require('vscode');
import { SessionStore } from '../storage/sessionStore';
import { DevHubSession } from '../types';
import { compactNumber, providerLabel, usageParts } from '../ui/format';
export class StatusBarController {
  private item:any;private account:any;private selected?:DevHubSession;
  /** `accountOf` returns the Claude account label for a cwd, `undefined` = no second account configured (hide the button). */
  constructor(private store:SessionStore,private accountOf:(cwd:string)=>string|undefined=()=>undefined){this.item=vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right,80);this.item.command='devhub.openChat';this.account=vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right,79);}
  dispose(){this.item.dispose();this.account.dispose();}
  async setSelected(session?:DevHubSession){this.selected=session;await this.update();}
  private updateAccount(){
    const s=this.selected;const label=s?.provider==='claude'&&s.cwd?this.accountOf(s.cwd):undefined;
    if(!label){this.account.hide();return;}
    this.account.text=`$(account) ${label}`;this.account.tooltip=`Claude account for ${s!.cwd}\nClick to switch (takes effect on the next turn)`;
    this.account.command={command:'devhub.switchClaudeAccount',title:'Switch Claude Account',arguments:[s!.cwd]};this.account.show();
  }
  async update(){
    this.updateAccount();
    const all=await this.store.list();const running=all.filter(s=>s.status==='running').length;
    if(!this.selected&&!running){this.item.hide();return;}
    if(this.selected){
      const u=this.selected.usage;const bits=[`$(hubot) ${providerLabel(this.selected.provider)}`];
      if(u?.quota5hUsedPercentage!=null)bits.push(usageParts(u).find(x=>x.startsWith('5h '))||'5h —');
      else if(u?.inputTokens!==undefined||u?.outputTokens!==undefined)bits.push(`\u2193${compactNumber(u?.inputTokens)} \u2191${compactNumber(u?.outputTokens)}`);
      if(running)bits.push(`${running} running`);this.item.text=bits.join(' · ');
      const lines=[this.selected.title,this.selected.cwd,`Status: ${this.selected.status}`,`Input: ${u?.inputTokens??'—'}`,`Cached input: ${u?.cachedInputTokens??'—'}`,`Cache write: ${u?.cacheWriteInputTokens??'—'}`,`Output: ${u?.outputTokens??'—'}`,`Reasoning: ${u?.reasoningOutputTokens??'—'}`];
      if(u?.contextUsedTokens!==undefined||u?.contextWindowTokens!==undefined)lines.push(`Context: ${u?.contextUsedTokens??'—'} / ${u?.contextWindowTokens??'—'}`);
      lines.push(`5h quota: ${usageParts(u).find(x=>x.startsWith('5h '))?.slice(3)??'—'}`,`7d quota: ${usageParts(u).find(x=>x.startsWith('7d '))?.slice(3)??'—'}`);
      if(u?.quota5hResetsAt)lines.push(`5h resets: ${new Date(u.quota5hResetsAt).toLocaleString()}`);if(u?.quota7dResetsAt)lines.push(`7d resets: ${new Date(u.quota7dResetsAt).toLocaleString()}`);
      this.item.tooltip=lines.join('\n');
    }else{this.item.text=`$(hubot) Dev Hub · ${running} running`;this.item.tooltip='Dev Hub active sessions';}
    this.item.show();
  }
}
