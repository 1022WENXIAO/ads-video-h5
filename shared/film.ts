export interface FilmShot {
  id:string;index:number;start:number;end:number;status:'pending'|'ready'|'failed';
  summary?:string;scene?:string;people?:string[];shotType?:string;movement?:string;usage?:string;tags?:string[];quote?:string;error?:string;thumbnailUrl?:string;
}
export interface FilmReport {
  id:string;sourceId:string;sourceHash:string;sourceName:string;duration:number;modelId:string;detector:'ffmpeg-content';
  status:'running'|'ready'|'partial';createdAt:string;updatedAt:string;warnings:string[];shots:FilmShot[];
}
export interface FilmIndex {id:string;sourceHash:string;status:FilmReport['status'];shotCount:number;completed:number;updatedAt:string}
export type FilmTask={action:'analyze';sourceId:string}|{action:'archive';sourceId:string;reportId:string;shotId:string;targetId:string;name?:string;tags?:string[]};
