import { ProviderId } from '../types';
import { parseWebviewMessage, WebviewMessage } from '../views/webviewProtocol';

/**
 * A phone has no QuickPick, so the webview's `pick*` messages change meaning: the client builds
 * its own picker sheet and sends the chosen value DIRECTLY. This is an addition; `parseWebviewMessage`
 * stays the source of truth for the shared messages — don't loosen it here.
 */
export type MobileOnlyMessage=
  {type:'setOption';kind:'model'|'effort';value?:string}|
  {type:'setProvider';provider:ProviderId}|
  {type:'openProject';projectId:string}|
  {type:'switchAccount';projectId:string}|
  {type:'openSession';provider:ProviderId;id:string}|
  {type:'loadOlder'};

export type MobileMessage=WebviewMessage|MobileOnlyMessage;

/** Starting a new chat is CLI-only: the planner isn't opened from a project. */
const NEW_PROVIDERS=new Set(['claude']);
/** Reopening an existing session works for every provider, planner included — docs/DESIGN.md promises exactly this. */
const PROVIDERS=new Set(['claude','planner']);
const id=(v:any,max=400)=>typeof v==='string'&&v.length>0&&v.length<=max?v:undefined;

export function parseMobileMessage(input:any):MobileMessage|undefined{
  if(!input||typeof input!=='object'||typeof input.type!=='string')return;
  if(input.type==='setOption'&&(input.kind==='model'||input.kind==='effort')){
    const value=typeof input.value==='string'&&input.value.trim()?input.value.trim().slice(0,200):undefined;
    return {type:'setOption',kind:input.kind,value};
  }
  if(input.type==='setProvider'&&NEW_PROVIDERS.has(input.provider))return {type:'setProvider',provider:input.provider};
  if(input.type==='openProject'&&id(input.projectId))return {type:'openProject',projectId:input.projectId};
  if(input.type==='switchAccount'&&id(input.projectId))return {type:'switchAccount',projectId:input.projectId};
  if(input.type==='openSession'&&PROVIDERS.has(input.provider)&&id(input.id))
    return {type:'openSession',provider:input.provider,id:input.id};
  if(input.type==='loadOlder')return {type:'loadOlder'};
  return parseWebviewMessage(input);
}
