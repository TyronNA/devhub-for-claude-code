import { UsageSnapshot } from '../types';
import { quotaIsStale } from '../usage/usageAggregator';
/** A provider's display name. One single place — it used to be seven scattered ternaries, and
 *  a third provider made all of them lie and say "Codex". */
const LABELS:Record<string,string>={claude:'Claude',planner:'Planner'};
export function providerLabel(id:string|undefined){return LABELS[String(id)]||String(id||'Agent');}
export function compactNumber(n:number|undefined){ if(n===undefined)return '—'; if(Math.abs(n)>=1_000_000)return `${(n/1_000_000).toFixed(n>=10_000_000?0:1).replace(/\.0$/,'')}m`; if(Math.abs(n)>=1_000)return `${(n/1_000).toFixed(n>=100_000?0:1).replace(/\.0$/,'')}k`; return String(n); }
/** Every quota/context number in the UI is what is LEFT — the chat rings too;
 *  the CLI's `value` is % used, so it is flipped here. The word "left" is the only thing telling it apart from
 *  the CLI's `/status` (which reads as % used); don't drop it. */
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
