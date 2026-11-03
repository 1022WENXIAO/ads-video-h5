import {defoldStarter} from '../../server/defoldProject';
import type {CreativeProject} from '../../shared/creativeProject';
export async function pixelfxProject():Promise<CreativeProject>{
 const base=await defoldStarter('PixelFX Native Showcase');
 const script=`local pixelfx = require('lib.pixelfx')
local function start(self)
 self.fx:clear()
 self.fx:play('flame',120,200,{scale=2})
 self.fx:play('frost',470,240,{scale=1.2})
 self.pickup=self.fx:play('pickup',790,240,{scale=2})
 self.age=0
end
function init(self)
 gui.set_render_order(3)
 msg.post('.', 'acquire_input_focus')
 self.fx=pixelfx.new();self.paused=false;start(self)
end
function update(self,dt)
 if not self.paused then self.fx:update(dt);self.fx:follow(self.pickup,790,240);self.age=self.age+dt;if self.age>4 then start(self) end end
 if html5 then html5.run('window.__QJ_PIXELFX_STATE='..json.encode(self.fx:stats())) end
end
function on_input(self,action_id,action)
 if action_id==hash('jump') and action.pressed then self.paused=not self.paused;if self.paused then self.fx:clear() else start(self) end
 elseif action_id==hash('restart') and action.pressed then self.paused=false;start(self) end
end
function final(self) self.fx:clear() end
`;
 return {...base,revision:1,updatedAt:'fixture',files:[...base.files,{path:'assets/pixelfx.json',content:JSON.stringify({version:1,effects:[{name:'flame',id:'fire/torch',fps:15,seed:4},{name:'frost',id:'ice/frost-nova',fps:15,seed:4},{name:'pickup',id:'pickups/collect-burst',fps:15,seed:4}]})},{path:'nodes/pixelfx.gui_script',content:script}],nodes:[...base.nodes,{id:'vfx',name:'Reusable pixel effects',kind:'animation',file:'nodes/pixelfx.gui_script',enabled:true}]};
}
