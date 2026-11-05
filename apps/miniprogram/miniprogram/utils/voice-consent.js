// Consent belongs to the current app run/account. Login and microphone
// permission never imply agreement to this independent recording policy.
const version = '2026-10-26.1';
const sections = [
  { title: '收集的信息与目的', text: '使用“按住说”时，我们会通过麦克风录制你主动说出的语音。录音包含声音、说话内容及可能识别个人的声纹特征，仅用于将语音转为文字并提交你的视频制作指令。当前语音录入功能不提取声纹模板进行身份识别，也不使用这些录音克隆声音。' },
  { title: '收集和处理方式', text: '只有你同意本协议、允许麦克风权限并再次按住说话后才会录音；每次最长 60 秒，松开结束，上滑可取消。录音通过 HTTPS 上传至轻喵LightMao服务端，转换为语音识别所需的音频后，交由所配置的模型服务进行转写；转写成功的文字将作为创作指令提交。' },
  { title: '存储与使用范围', text: '语音识别期间，轻喵LightMao服务端会临时保存原始录音及转换音频，请求处理结束后清理这些临时文件。识别后的文字会随创作会话保存。模型服务会接收本次识别所需的音频，其处理和保存适用该服务方的隐私政策。录音不会作为素材自动加入你的素材库。' },
  { title: '你的选择与撤回方式', text: '本授权独立于微信登录和通用隐私授权。选择“暂不使用语音”不影响浏览及文字输入。你可以在“我的 → 设置 → 语音授权”中撤回授权，之后再次使用语音时需要重新同意；也可在微信设置中关闭麦克风权限。撤回不影响此前已经完成的处理。' },
];
function hasVoiceConsent(app) { return Boolean(app.voiceConsent && app.voiceConsent.version === version); }
module.exports = { version, sections, hasVoiceConsent };
