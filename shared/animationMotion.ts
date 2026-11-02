export interface MotionSummary { framePairs:number;meanChangedAreaPct:number;medianChangedAreaPct:number;p90ChangedAreaPct:number;activeFramePct:number;longestStillSeconds:number }
export interface AnimationMotion extends MotionSummary { frames:number;width:number;height:number;pixelThreshold:number;panels:Array<MotionSummary&{panel:number}> }
