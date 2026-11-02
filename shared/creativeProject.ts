export type CreativeKind='canvas'|'animation'|'defold';
export interface CreativeFile {path:string;content:string}
export interface CreativeNode {id:string;kind:'canvas'|'animation'|'game';file:string;enabled:boolean;name:string}
export interface CreativeProject {format:1;kind:CreativeKind;title:string;revision:number;entry:string;files:CreativeFile[];nodes:CreativeNode[];updatedAt:string}
export interface CreativeDiagnostic {file:string;line:number;message:string;severity:'error'|'warning'}
export interface RequirementCheck {id:string;status:'satisfied'|'unverified'|'failed'|'superseded';evidence:string[];supersededBy?:string}
export interface CreativeReview {requirementChecks?:RequirementCheck[];projectHash:string;approved:boolean;summary:string;issues:Array<CreativeDiagnostic&{fix:string}>;reviewedAt:string}
export interface CreativeBuild {projectHash:string;engine:'defold';engineVersion:string;directory:string;entry:string;logs:string;builtAt:string;artifactHash?:string;environmentHash?:string}
