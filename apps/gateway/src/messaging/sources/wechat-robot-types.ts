export interface WechatRobotClientResponse<T> {
  Success?: boolean;
  Code?: number;
  Message?: string;
  Data?: T;
  Data62?: string;
  Debug?: string;
}

export interface WechatRobotSyncMessage {
  AddMsgs?: WechatRobotRawMessage[];
  ModContacts?: unknown[];
  DelContacts?: unknown[];
  [key: string]: unknown;
}

export interface WechatRobotBuiltinString {
  string?: string | null;
  String?: string | null;
}

export interface WechatRobotRawMessage {
  MsgId?: string | number;
  FromUserName?: WechatRobotBuiltinString;
  ToUserName?: WechatRobotBuiltinString;
  Content?: WechatRobotBuiltinString;
  CreateTime?: string | number;
  MsgType?: string | number;
  Status?: number;
  ImgStatus?: number;
  MsgSource?: string;
  NewMsgId?: string | number;
  MsgSeq?: string | number;
  PushContent?: string;
  [key: string]: unknown;
}
