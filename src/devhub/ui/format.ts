import { UsageSnapshot } from '../types';
import { quotaIsStale } from '../usage/usageAggregator';
/** Tên hiển thị của provider. Một chỗ duy nhất — trước đây là bảy ternary rải rác, và
 *  provider thứ ba khiến tất cả nói dối là "Codex". */
const LABELS:Record<string,string>={claude:'Claude',planner:'Planner'};
export function providerLabel(id:string|undefined){return LABELS[String(id)]||String(id||'Agent');}
export function compactNumber(n:number|undefined){ if(n===undefined)return '—'; if(Math.abs(n)>=1_000_000)return `${(n/1_000_000).toFixed(n>=10_000_000?0:1).replace(/\.0$/,'')}m`; if(Math.abs(n)>=1_000)return `${(n/1_000).toFixed(n>=100_000?0:1).replace(/\.0$/,'')}k`; return String(n); }
/** Mọi con số quota/context trong UI đều là phần CÒN LẠI — vòng tròn trong chat cũng vậy;
 *  `value` từ CLI là % đã dùng nên lật ở đây. Chữ "left" là thứ duy nhất phân biệt nó với
 *  `/status` của CLI (đọc theo % đã dùng), đừng bỏ. */
function quotaPart(label:string,value:number|undefined,observedAt:number|undefined,now:number){if(value==null)return `${label} —`;return `${label} ${quotaIsStale(observedAt,now)?'~':''}${Math.round(100-value)}% left`;}
export function usageParts(u:UsageSnapshot|undefined,now=Date.now()){
  const usage=u||{}; const out:string[]=[];
  if(usage.inputTokens!==undefined)out.push(`${compactNumber(usage.inputTokens)} in`);
  if(usage.cachedInputTokens!==undefined)out.push(`${compactNumber(usage.cachedInputTokens)} cached`);
  if(usage.cacheWriteInputTokens!==undefined)out.push(`${compactNumber(usage.cacheWriteInputTokens)} cache write`);
  if(usage.outputTokens!==undefined)out.push(`${compactNumber(usage.outputTokens)} out`);
  if(usage.reasoningOutputTokens!==undefined)out.push(`${compactNumber(usage.reasoningOutputTokens)} reasoning`);
  if(usage.contextUsedTokens!==undefined&&usage.contextWindowTokens)out.push(`context ${Math.round(100-usage.contextUsedTokens/usage.contextWindowTokens*100)}% left`);
  out.push(quotaPart('5h',usage.quota5hUsedPercentage,usage.quota5hObservedAt,now));out.push(quotaPart('7d',usage.quota7dUsedPercentage,usage.quota7dObservedAt,now));return out;
}
