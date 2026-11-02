export interface ScienceNode { id:string; kind:'box'|'token'; text:string; x:number; y:number; w:number; h:number; visible?:boolean; active?:boolean }
export interface ScienceChange { nodeId:string; x?:number; y?:number; text?:string; visible?:boolean; active?:boolean }
export interface SciencePanel {
  name:string; english:string; sub:string; color:string; difference:string;
  nodes:ScienceNode[]; steps:Array<{label:string;changes:ScienceChange[]}>;
  transfers:Array<{from:string;to:string;step:number}>;
  checks:Array<{name:string;step:number;nodeId:string;text?:string;visible?:boolean;active?:boolean}>;
}
export interface ScienceScene {
  title:string; subtitle:string; kicker:string; prompt:string; footerNote:string; author:string; duration:number; bgm:boolean;
  comparison:string; boundary:string; basis:string[]; panels:SciencePanel[];
  program?: ScienceProgram;
}

export interface ScienceProgram {
  apiVersion: 2;
  source: string;
  selfCheck?: {approved:true;sourceHash:string;sceneHash:string;projectHash:string;reviewedAt:string};
  files?: import("./creativeProject").CreativeFile[];
  entry?: string;
  nodes?: import("./creativeProject").CreativeNode[];
  capabilities: string[];
  motionPlan: Array<{ panel:number; mechanism:string; objects:string[]; continuousMotion:string; feedback:string }>;
}
