level: 30

日志级别，不是业务字段。
这很像 pino 风格日志，30 一般表示 info。

time: "2026-04-10T11:48:12.698Z"

这条日志产生的时间。
Z 表示 UTC 时间，也就是北京时间 2026-04-10 19:48:12.698。

sessionId: "56594698995@chatroom"

会话 ID。
以 @chatroom 结尾，说明这是群聊，不是私聊。
groupName: "WeChat Robot"

群名称。
这是给人看、给日志看最方便的群显示名。
sourceName: "不知名小机"

这条消息的发送者显示名。
在群里通常就是群成员昵称或可展示名称。
contentPreview: "[图片]"

这条消息的预览文本。
不是完整消息内容，而是摘要。
这里显示 [图片]，说明这条是图片消息。WeFlow 里 localType = 3 时也会映射成 [图片]，见 messagePushService.ts。
messageKey: "server:6809178806134188000:1775821690:1775821690000:920:wxid_ass85tknzqiu22:3"

消息唯一键，用来去重最重要。
这不是随便拼的，WeFlow 里 server 形式的格式是：
server:{serverId}:{createTime}:{sortSeq}:{localId}:{senderUsername}:{localType}
见 chatService.ts。
按这条样例拆开就是：
server: 这是基于服务端消息 ID 生成的 key
6809178806134188000: serverId
1775821690: createTime
1775821690000: sortSeq
920: localId
wxid_ass85tknzqiu22: 发送者微信 ID
3: 消息类型，3 对应图片
triggerReason: "quiet_window"

这不是 WeFlow 原生字段，更像你外层聚合器的内部决策原因。
从命名看，它的意思是：这条消息没有立刻触发后续处理，而是先进入“静默窗口”等待聚合。
也就是先看看接下来短时间内还会不会有更多群消息，再一起分析。
pendingCount: 2

当前这个群在聚合缓冲区里，待处理的消息数量。
这里大概率表示：这条消息进来以后，这个群当前已经累积了 2 条待聚合消息。
msg: "收到新群消息事件，已放入静默窗口等待聚合"

人类可读日志文本。
它说明当前阶段只是“收到事件并入缓冲”，还没有进入真正的话题分析或回复阶段。