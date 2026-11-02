import {Type} from 'typebox';
import type {AgentTool} from '@earendil-works/pi-agent-core';
import type {CreativeWorkspace} from './creativeWorkspace';
import type {CreativeNode} from '../shared/creativeProject';
const revision=Type.Integer({minimum:1}),file=Type.String({minLength:1,maxLength:160}),content=Type.String({maxLength:160000});
const result=(value:unknown)=>({content:[{type:'text' as const,text:JSON.stringify(value)}],details:value});
export function creativeEditingTools(workspace:CreativeWorkspace,onChange:()=>void):AgentTool[]{
 const changed=async(action:Promise<unknown>)=>{await action;onChange();return result(workspace.list());};
 return [
 {name:'list_project_files',label:'查询工程文件与节点',description:'读取当前版本、文件哈希、入口与实际节点。修改时必须使用当前revision。',parameters:Type.Object({}),execute:async()=>result(workspace.list())},
 {name:'read_project_file',label:'读取代码与行号',description:'读取当前工程文件的实际内容、行号与SHA，供精确编辑；不访问服务端其他文件。',parameters:Type.Object({path:file,startLine:Type.Integer({minimum:1}),endLine:Type.Integer({minimum:1})}),execute:async(_id,a:any)=>result(workspace.read(a.path,a.startLine,a.endLine))},
 {name:'search_project_files',label:'搜索变量和引用',description:'按原文搜索全部文件中的变量、函数和资源引用，返回行号。',parameters:Type.Object({query:Type.String({minLength:1,maxLength:200})}),execute:async(_id,a:any)=>result(workspace.search(a.query))},
 {name:'create_project_file',label:'增加代码文件',description:'新增当前工程的文本模块或资源。已存在时必须先读取再修改。',parameters:Type.Object({expectedRevision:revision,path:file,content}),execute:async(_id,a:any)=>changed(workspace.create(a.expectedRevision,a.path,a.content))},
 {name:'update_project_file',label:'按行修改代码文件',description:'用当前revision和文件SHA修改一个或多个不重叠行区间；endLine=startLine-1表示插入，content空表示删除。失败时重新读取，不可重复猜测补丁。',parameters:Type.Object({expectedRevision:revision,path:file,expectedSha256:Type.String({minLength:64,maxLength:64}),edits:Type.Array(Type.Object({startLine:Type.Integer({minimum:1}),endLine:Type.Integer({minimum:0}),content}),{minItems:1,maxItems:20})}),execute:async(_id,a:any)=>changed(workspace.update(a.expectedRevision,a.path,a.edits,a.expectedSha256))},
 {name:'delete_project_file',label:'删除工程文件',description:'删除未被入口或节点引用的文件；历史版本保留，可恢复。',parameters:Type.Object({expectedRevision:revision,path:file}),execute:async(_id,a:any)=>changed(workspace.delete(a.expectedRevision,a.path))},
 {name:'create_project_node',label:'增加可编程节点',description:'将已存在的代码文件注册为Canvas、动画或游戏节点；预览/构建实际消费这些节点。',parameters:Type.Object({expectedRevision:revision,id:Type.String(),kind:Type.Union([Type.Literal('canvas'),Type.Literal('animation'),Type.Literal('game')]),file,name:Type.String({maxLength:80})}),execute:async(_id,a:any)=>changed(workspace.node(a.expectedRevision,'create',{id:a.id,kind:a.kind,file:a.file,name:a.name,enabled:true}))},
 {name:'update_project_node',label:'修改节点属性或代码引用',description:'修改现有节点的代码引用、名称、类型和启用状态。',parameters:Type.Object({expectedRevision:revision,node:Type.Object({id:Type.String(),kind:Type.Union([Type.Literal('canvas'),Type.Literal('animation'),Type.Literal('game')]),file,name:Type.String({maxLength:80}),enabled:Type.Boolean()})}),execute:async(_id,a:any)=>changed(workspace.node(a.expectedRevision,'update',a.node))},
 {name:'delete_project_node',label:'删除可编程节点',description:'移除指定节点，后续构建/预览不再执行该节点；源码和历史不自动删除。',parameters:Type.Object({expectedRevision:revision,id:Type.String()}),execute:async(_id,a:any)=>{const node=workspace.snapshot().nodes.find(n=>n.id===a.id);if(!node)throw Error('节点不存在。');return changed(workspace.node(a.expectedRevision,'delete',node));}},
 {name:'restore_project_revision',label:'恢复工程历史版本',description:'将指定历史快照恢复为一个新版本，保留全部操作历史。恢复后必须重新验证与自检。',parameters:Type.Object({expectedRevision:revision,revision}),execute:async(_id,a:any)=>changed(workspace.restore(a.expectedRevision,a.revision))},
 ];
}
