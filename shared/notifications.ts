export interface CompletionNotice {
  id:string; ownerId:string; jobId:string; sessionId:string; kind:'reply'|'task'; title:string; result:string;
  status:'succeeded'|'failed'; at:string; readAt?:string;
  push:'pending'|'sending'|'sent'|'failed'|'unknown'|'unsubscribed'; pushCode?:number;
}
export type PublicNotice = Omit<CompletionNotice,'ownerId'>;
export interface NoticeInbox {items:PublicNotice[];unread:number;unreadBySession:Record<string,number>;cursor:string;revision:number}
