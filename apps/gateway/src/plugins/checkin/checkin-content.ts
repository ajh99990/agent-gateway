const EXPEDITION_ENTRY_COST = 10;

const EXPEDITION_READY_GUIDES = [
  (points: number, balance: number) =>
    `签到成功，获得 ${points} 积分。\n当前积分：${balance}\n\n咪露探出头来：\n“积分到手了喵。要不要拿 10 分试试远征？发送「远征」就行。”`,
  (points: number, balance: number) =>
    `签到成功，获得 ${points} 积分。\n当前积分：${balance}\n\n咪露晃了晃尾巴：\n“新鲜积分！不拿去远征一下吗？放心，死得很快也很有纪念意义喵。”`,
  (points: number, balance: number) =>
    `签到成功，获得 ${points} 积分。\n当前积分：${balance}\n\n咪露把远征申请表推过来：\n“稳健、冒险、疯狂，随便挑喵。想刺激点也可以「远征 疯狂 梭哈」。”`,
  (points: number, balance: number) =>
    `签到成功，获得 ${points} 积分。\n当前积分：${balance}\n\n咪露踮起脚拍了拍任务板：\n“走过路过不要错过喵！10 积分一次远征，发送「远征」就能上车，死了也算体验过！”`,
  (points: number, balance: number) =>
    `签到成功，获得 ${points} 积分。\n当前积分：${balance}\n\n咪露把远征申请表摆成一排：\n“新鲜远征刚开张喵！发送「远征」试试手气，活着回来还能赚积分哦。”`,
  (points: number, balance: number) =>
    `签到成功，获得 ${points} 积分。\n当前积分：${balance}\n\n咪露摇着小铃铛喊：\n“今日裂隙大促销喵！发送「远征」只要 10 积分，暴富、暴毙、捡遗物，随机发货！”`,
] as const;

export function formatCheckinSuccessText(points: number, balance: number): string {
  if (balance < EXPEDITION_ENTRY_COST) {
    return `签到成功，获得 ${points} 积分。\n当前积分：${balance}\n\n咪露看了看你的钱包：\n“还差一点点喵。攒到 10 积分，就可以报名远征啦。”`;
  }

  const guide = EXPEDITION_READY_GUIDES[Math.floor(Math.random() * EXPEDITION_READY_GUIDES.length)]!;
  return guide(points, balance);
}
