-- Generated resource data and pinned raster frames; no effect code is rewritten by the model.
local resources = require('lib.pixelfx_data')
local M = {}
M.__index = M
function M.new() return setmetatable({active={},plays=0},M) end
function M:stop(handle)
 for i=#self.active,1,-1 do if self.active[i]==handle then gui.delete_node(handle.root);table.remove(self.active,i);return end end
end
function M:clear()
 for _,handle in ipairs(self.active) do gui.delete_node(handle.root) end
 self.active={}
end
local function show(handle,frame)
 local first=0
 for index,page in ipairs(handle.effect.pages) do
  if frame<first+page.frames then
   if handle.page~=index then
    gui.set_texture(handle.node,page.texture)
    gui.play_flipbook(handle.node,'play',nil,{playback_rate=0})
    handle.page=index
   end
   gui.set_flipbook_cursor(handle.node,(frame-first+.25)/page.frames)
   handle.frame=frame
   return
  end
  first=first+page.frames
 end
end
function M:play(name,x,y,options)
 local effect=resources[name]
 assert(effect,'Unknown imported pixelfx binding: '..tostring(name))
 options=options or {}
 local scale=options.scale or 1
 assert(type(scale)=='number' and scale>0 and scale<=12,'pixelfx scale must be in (0,12]')
 if #self.active>=32 then self:stop(self.active[1]) end
 local anchor=gui.new_box_node(vmath.vector3(x,y,0),vmath.vector3(0,0,0))
 local image=gui.new_box_node(vmath.vector3(effect.w/2-effect.ox,effect.oy-effect.h/2,0),vmath.vector3(effect.w,effect.h,0))
 gui.set_parent(image,anchor,false)
 gui.set_scale(anchor,vmath.vector3(options.flip and -scale or scale,scale,1))
 gui.set_euler(anchor,vmath.vector3(0,0,options.angle or 0))
 local handle={root=anchor,node=image,effect=effect,age=0,name=name}
 table.insert(self.active,handle);self.plays=self.plays+1
 show(handle,0)
 return handle
end
function M:follow(handle,x,y)
 for _,current in ipairs(self.active) do if current==handle then gui.set_position(handle.root,vmath.vector3(x,y,0));return true end end
 return false
end
function M:update(dt)
 for i=#self.active,1,-1 do
  local handle=self.active[i];handle.age=handle.age+dt
  local frame=math.floor(handle.age*handle.effect.fps)
  if not handle.effect.loop and frame>=handle.effect.frames then self:stop(handle)
  else show(handle,frame%handle.effect.frames) end
 end
end
function M:stats()
 local active={}
 for _,handle in ipairs(self.active) do table.insert(active,{name=handle.name,frame=handle.frame}) end
 return {plays=self.plays,active=active}
end
return M
