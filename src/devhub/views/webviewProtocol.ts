const path=require('node:path');
export type WebviewMessage=
  {type:'ready'}|{type:'sendPrompt';text:string;attachments?:string[]}|{type:'cancel'}|{type:'openFile';path:string}|
  {type:'pickProvider'}|{type:'pickProject'}|{type:'pickHistory'}|{type:'newTab'}|{type:'pickModel'}|{type:'pickEffort'}|{type:'permissionResponse';requestId:string;allow:boolean;answers?:Record<string,string>}|{type:'pickSlash'}|{type:'pickChanged'}|{type:'copySessionId'}|{type:'openLink';href:string}|
  {type:'pasteImage';mime:string;data:string;requestId?:string}|{type:'compact'}|{type:'dequeue';index:number};

// Pasted images travel over postMessage as base64, so a hard cap is needed: one
// Retina screenshot is ~4MB of base64; past this threshold it's a wrongly pasted file, not an image.
const MAX_IMAGE_B64=12*1024*1024;
const IMAGE_MIME=new Set(['image/png','image/jpeg','image/gif','image/webp']);

export function parseWebviewMessage(input:any):WebviewMessage|undefined{
  if(!input||typeof input!=='object'||typeof input.type!=='string')return;
  if(input.type==='ready')return {type:'ready'};
  if(input.type==='cancel')return {type:'cancel'};
  if(input.type==='pickProvider')return {type:'pickProvider'};
  if(input.type==='pickProject')return {type:'pickProject'};
  if(input.type==='pickHistory')return {type:'pickHistory'};
  if(input.type==='newTab')return {type:'newTab'};
  if(input.type==='pickModel')return {type:'pickModel'};
  if(input.type==='pickEffort')return {type:'pickEffort'};
  if(input.type==='pickSlash')return {type:'pickSlash'};
  if(input.type==='pickChanged')return {type:'pickChanged'};
  if(input.type==='compact')return {type:'compact'};
  if(input.type==='copySessionId')return {type:'copySessionId'};
  if(input.type==='dequeue'&&Number.isInteger(input.index)&&input.index>=0&&input.index<1000)return {type:'dequeue',index:input.index};
  // http(s) only — don't let markdown pull out file:// or any other scheme.
  if(input.type==='openLink'&&typeof input.href==='string'&&input.href.length<=4096&&/^https?:\/\//i.test(input.href))
    return {type:'openLink',href:input.href};
  if(input.type==='permissionResponse'&&typeof input.requestId==='string'&&input.requestId.length<=200&&typeof input.allow==='boolean'){
    let answers:Record<string,string>|undefined;
    if(input.answers&&typeof input.answers==='object'&&!Array.isArray(input.answers)){
      const out:Record<string,string>={};
      for(const [k,v] of Object.entries(input.answers))
        if(typeof k==='string'&&k.length<=2000&&typeof v==='string'&&v.length<=2000)out[k]=v;
      if(Object.keys(out).length)answers=out;
    }
    return {type:'permissionResponse',requestId:input.requestId,allow:input.allow,answers};
  }
  if(input.type==='sendPrompt'&&typeof input.text==='string'&&input.text.length<=200_000){
    // Images travel as a separate field so the provider attaches them properly (`-i`), not stuffed into the text.
    const attachments=Array.isArray(input.attachments)
      ? input.attachments.filter((x:any)=>typeof x==='string'&&x.length<=32_768&&path.isAbsolute(x)).slice(0,16)
      : undefined;
    return {type:'sendPrompt',text:input.text,...(attachments&&attachments.length?{attachments}:{})};
  }
  if(input.type==='openFile'&&typeof input.path==='string'&&input.path.length<=32_768&&path.isAbsolute(input.path))return {type:'openFile',path:input.path};
  if(input.type==='pasteImage'&&typeof input.mime==='string'&&IMAGE_MIME.has(input.mime)
     &&typeof input.data==='string'&&input.data.length>0&&input.data.length<=MAX_IMAGE_B64
     &&/^[A-Za-z0-9+/=]+$/.test(input.data))return {type:'pasteImage',mime:input.mime,data:input.data,...(typeof input.requestId==='string'&&input.requestId.length<=200?{requestId:input.requestId}:{})};
}
