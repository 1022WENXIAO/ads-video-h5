export interface TaskRequirement {id:string;messageId:string;text:string}
export interface TaskSpec {
 id:string;revision:number;objective:string;requirements:TaskRequirement[];
 constraints:TaskRequirement[];templateId?:string;createdAt:string;
}
export interface TaskEvidence {contractHash:string;projectHash:string;artifactHash?:string;environmentHash:string;technicalPassed:boolean;requirementsReviewed:boolean;userAccepted:false}
export interface TaskCheckpoint {id?:string;stage:string;inputHash:string;status:'started'|'completed'|'failed';updatedAt:string;outputHash?:string;error?:string}
