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

const DUPLICATE_CHECKIN_READY_GUIDES = [
  (balance: number) =>
    `今天已经签到过啦。\n当前积分：${balance}\n\n咪露按住签到簿，笑得很甜：\n“还想领第二份？不可以喵。但是你这副不甘心的样子，很适合发送「远征」去赌一把。”`,
  (balance: number) =>
    `重复签到失败。\n当前积分：${balance}\n\n咪露把签到章举高高：\n“不给喵。签到奖励没有第二份，死亡报告倒是可以给你新开一份。发送「远征」。”`,
  (balance: number) =>
    `今天的签到奖励已经领过了。\n当前积分：${balance}\n\n咪露敲了敲柜台：\n“别盯着签到簿啦，它不会生积分。倒是你发送「远征」以后，可能会生很多事故。”`,
  (balance: number) =>
    `你今天已经签到过了。\n当前积分：${balance}\n\n咪露把你的名字从签到簿上划了一道小尾巴：\n“贪心的爪子被抓到了喵。既然这么想多拿点，就发送「远征」去裂隙里捡。”`,
  (balance: number) =>
    `重复签到没有奖励。\n当前积分：${balance}\n\n咪露眯起眼睛：\n“同一枚签到章不能盖两次喵。但同一条命，可以每天拿去远征一次。”`,
] as const;

const DUPLICATE_CHECKIN_LOW_BALANCE_GUIDES = [
  (balance: number) =>
    `今天已经签到过啦。\n当前积分：${balance}\n\n咪露看了看你的钱包，语气突然变得很温柔：\n“穷得很稳定喵。先攒到 10 分，咪露再亲手把你推进远征入口。”`,
  (balance: number) =>
    `重复签到没有奖励。\n当前积分：${balance}\n\n咪露把签到章藏到身后：\n“没有第二份喵。你现在这点积分，连远征入口的门把手都摸不起。”`,
] as const;

export function formatCheckinSuccessText(points: number, balance: number): string {
  if (balance < EXPEDITION_ENTRY_COST) {
    return `签到成功，获得 ${points} 积分。\n当前积分：${balance}\n\n咪露看了看你的钱包：\n“还差一点点喵。攒到 10 积分，就可以报名远征啦。”`;
  }

  const guide = EXPEDITION_READY_GUIDES[Math.floor(Math.random() * EXPEDITION_READY_GUIDES.length)]!;
  return guide(points, balance);
}

export function formatDuplicateCheckinText(balance: number): string {
  const guides = balance < EXPEDITION_ENTRY_COST
    ? DUPLICATE_CHECKIN_LOW_BALANCE_GUIDES
    : DUPLICATE_CHECKIN_READY_GUIDES;
  const guide = guides[Math.floor(Math.random() * guides.length)]!;
  return guide(balance);
}
