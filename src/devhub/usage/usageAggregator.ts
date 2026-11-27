import { DevHubSession, ProviderId, UsageSnapshot } from '../types';

export interface ProviderUsageSummary extends UsageSnapshot { provider:ProviderId; inputTokens:number; outputTokens:number; cachedInputTokens:number; cacheWriteInputTokens:number; reasoningOutputTokens:number; costUsd:number; }
const counterKeys:Array<keyof UsageSnapshot>=['inputTokens','outputTokens','cachedInputTokens','cacheWriteInputTokens','reasoningOutputTokens','costUsd'];

export function mergeSessionUsage(previous:UsageSnapshot|undefined,next:UsageSnapshot):UsageSnapshot {
  const merged:UsageSnapshot={...(previous||{})};
  for(const key of counterKeys){
    const value=next[key] as number|undefined;
    if(value!==undefined) (merged as any)[key]=((previous?.[key] as number|undefined)||0)+value;
  }
  for(const key of ['contextUsedTokens','contextWindowTokens','quota5hUsedPercentage','quota5hResetsAt','quota5hObservedAt','quota5hAuthoritative','quota7dUsedPercentage','quota7dResetsAt','quota7dObservedAt','quota7dAuthoritative','model','cacheAnchorAt','cacheTtlMs','cacheTokens','usageInsights'] as Array<keyof UsageSnapshot>){
    if(next[key]!==undefined) (merged as any)[key]=next[key];
  }
  return merged;
}

export function quotaIsStale(observedAt:number|undefined,now=Date.now(),maxAgeMs=15*60_000){return observedAt!==undefined && now-observedAt>maxAgeMs;}

export class UsageAggregator {
  summarizeWorkspace(workspaceId:string,sessions:DevHubSession[]):ProviderUsageSummary[]{
    const groups=new Map<ProviderId,ProviderUsageSummary>(); const latestQuota=new Map<ProviderId,{at:number;u:UsageSnapshot}>();
    for(const s of sessions.filter(x=>x.workspaceId===workspaceId)){
      const g=groups.get(s.provider) ?? {provider:s.provider,inputTokens:0,outputTokens:0,cachedInputTokens:0,cacheWriteInputTokens:0,reasoningOutputTokens:0,costUsd:0}; const u=s.usage||{};
      g.inputTokens+=u.inputTokens||0; g.outputTokens+=u.outputTokens||0; g.cachedInputTokens+=u.cachedInputTokens||0; g.cacheWriteInputTokens+=u.cacheWriteInputTokens||0; g.reasoningOutputTokens+=u.reasoningOutputTokens||0; g.costUsd+=u.costUsd||0;
      if(u.contextUsedTokens!==undefined)g.contextUsedTokens=u.contextUsedTokens;if(u.contextWindowTokens!==undefined)g.contextWindowTokens=u.contextWindowTokens;
      // Xếp theo LÚC ĐO, không theo updatedAt: mở lại một session cũ ghi lại quota cũ của nó
      // kèm updatedAt=now, và lấy updatedAt làm mốc thì ảnh 3 tuần trước đè ảnh mới đo.
      const observed=Math.max(u.quota5hObservedAt||0,u.quota7dObservedAt||0);const q=latestQuota.get(s.provider);if(observed&&(!q||observed>q.at))latestQuota.set(s.provider,{at:observed,u});
      groups.set(s.provider,g);
    }
    for(const [provider,q] of latestQuota){const g=groups.get(provider)!;const u=q.u;for(const key of ['quota5hUsedPercentage','quota5hResetsAt','quota5hObservedAt','quota5hAuthoritative','quota7dUsedPercentage','quota7dResetsAt','quota7dObservedAt','quota7dAuthoritative'] as Array<keyof UsageSnapshot>)if(u[key]!==undefined)(g as any)[key]=u[key];}
    return [...groups.values()];
  }
}
