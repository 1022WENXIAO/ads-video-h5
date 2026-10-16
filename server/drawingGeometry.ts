import type {Format} from '../src/types';
import type {HtmlDrawing} from './narrativeScenes';

export interface DrawingGeometryIssue{
  code:'node_bounds'|'text_box_height'|'numeric_slot';nodeId:string;
  box:{x:number;y:number;w:number;h:number};
  safeZone?:{left:number;top:number;right:number;bottom:number};
  requiredHeight?:number;
  requiredWidth?:number;
}
/** A structurally valid authored proposal rejected by deterministic geometry.
 * This carries a rejected draft, never an HTML/browser success report. */
export class AuthoredDrawingGeometryError extends Error{
  readonly code='AUTHORED_DRAWING_GEOMETRY';readonly retryable=false;
  readonly draft:HtmlDrawing;readonly issues:DrawingGeometryIssue[];
  constructor(draft:HtmlDrawing,readonly format:Format,issues:DrawingGeometryIssue[],message:string,readonly rawProposal?:string){
    super(message);this.name='AuthoredDrawingGeometryError';this.draft=structuredClone(draft);this.issues=structuredClone(issues);
  }
}
