import { DevHubEvent, DevHubSession } from '../types';

const MAX_EVENTS=1500;

/**
 * Transcript của planner là TRẠNG THÁI SỐNG (plan version, chuỗi state, reminder vừa nổ), không
 * phải file trên đĩa: buffer đọc lúc task còn `ANALYZING` dính mãi câu "no plan stored yet" cho
 * tới khi extension host restart, nên bấm lại hàng đó sau khi plan xong vẫn ra tab cũ. Phải đọc
 * lại mỗi lần mở — nhưng CHỈ khi session không có lượt nào chạy, vì lúc đó buffer là nguồn duy
 * nhất của event live.
 */
export function rereadsTranscript(session:DevHubSession){
  return session.provider==='planner';
}

export interface MergedTranscript { events:DevHubEvent[]; historyLen:number; }

/**
 * Ghép lịch sử vừa đọc với buffer đang có. `historyLen` là số event ĐẦU buffer đến từ lần đọc
 * trước (0 khi buffer rỗng hoặc chỉ chứa event live) — phần đuôi là event live mà không đâu đọc
 * lại được (hội thoại planner sống trong bộ nhớ daemon), nên nó luôn được giữ và lịch sử mới chỉ
 * thay đúng phần tiền tố.
 */
export function mergeTranscript(loaded:DevHubEvent[],buffered:DevHubEvent[],historyLen:number,dedupe:boolean):MergedTranscript{
  const head=loaded.length>MAX_EVENTS
    ?[{type:'warning',message:'Showing the most recent 1,500 transcript events to keep Dev Hub responsive.',timestamp:Date.now()} as DevHubEvent,
      ...loaded.slice(-(MAX_EVENTS-1))]
    :loaded;
  const live=buffered.slice(Math.min(historyLen,buffered.length));
  // Event live đến TRONG lúc chờ đọc transcript đã nằm trong buffer, và transcript trên đĩa có
  // thể đã chứa chính lượt đó (Claude ghi file trong lúc chạy): cắt lịch sử theo mốc event
  // live đầu tiên. Planner thì KHÔNG — plan mang timestamp của daemon, có thể muộn hơn tin nhắn
  // cũ trong tab, cắt là mất luôn plan.
  const history=live.length&&dedupe?head.filter(e=>e.timestamp<live[0].timestamp):head;
  return {events:[...history,...live],historyLen:history.length};
}
