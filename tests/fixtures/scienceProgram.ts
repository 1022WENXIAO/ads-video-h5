import { scienceFixture } from './scienceScene';
import type { ScienceScene } from '../../shared/scienceScene';

export function scienceProgramFixture():ScienceScene {
  const scene=scienceFixture();
  scene.program={apiVersion:2,capabilities:['stream','custom-orbit'],motionPlan:scene.panels.map((p,i)=>({panel:i+1,mechanism:p.name,objects:['确定性数据点'],continuousMotion:'数据点持续沿轨迹移动',feedback:'到达节点后扩散'})),source:`function createScene(api){
    return {
      stateAt(t,i,cfg){return {stage:'数据持续流入',phase:t%4};},
      paintPanel(ui,x,y,state,i,t,rect){
        for(let k=0;k<36;k++){
          const u=(t*.45+k/36)%1,yy=y+125+(k%4)*39;
          ui.dot(x+30+u*(rect.w-60),yy,5,api.config.panels[i].color,.9);
        }
        ui.stream([[x+35,y+165],[x+rect.w-35,y+165]],t,{color:api.config.panels[i].color,count:4,period:1,travel:.6,duration:.6});
      },
      checkModels(cfg){return cfg.panels.map((p,i)=>({name:p.name+'轨迹范围',passed:api.pointAt([[0,0],[10,0]],.5)[0]===5}));}
    };
  }`};
  return scene;
}
