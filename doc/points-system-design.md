# Points System Design

这份文档记录 gateway 积分系统第一版设计。

当前只描述核心积分能力，不包含签到规则。签到每次给多少积分、是否每日限制等，会在积分系统完成后单独确定。

## 设计目标

积分系统是 gateway 的平台公共能力，不属于某个插件。

它需要支持：

- 每个群内独立积分账户。
- 查询用户当前余额。
- 增加积分。
- 消耗积分。
- 后台手动调整积分。
- 记录每一次积分变化流水。
- 通过流水知道积分来源、变化量、变化前后余额。
- 余额不允许为负数。
- 后续可供插件和 Web 后台共同调用。

## 作用域

积分账户按以下维度隔离：

```text
session_id + sender_id
```

含义：

- `session_id`：群会话 ID。
- `sender_id`：用户在 WeFlow/微信侧的发送者 ID。

同一个用户在不同群里有不同积分账户，互不影响。

## 初始积分

用户初始积分为：

```text
20
```

第一版建议懒创建账户：

```text
当第一次查询、增加或消耗某个 session_id + sender_id 的积分时，
如果账户不存在，就创建账户并设置 balance = 20。
```

这样不需要提前同步群成员列表。

懒创建账户时必须同步写入一条初始流水：

```text
delta = 20
balance_before = 0
balance_after = 20
source = "initial_grant"
description = "初始积分"
operator_id = "system"
```

这样账户余额可以完全由流水解释。

## 表结构方案

第一版使用两张表：

```text
points_accounts
points_ledger
```

### `points_accounts`

保存当前余额。

建议字段：

```text
id          bigserial 主键
session_id  text，不为空
sender_id   text，不为空
balance     integer，不为空，默认 20，不允许小于 0
created_at  timestamptz，不为空，默认 now()
updated_at  timestamptz，不为空，默认 now()
```

基础约束：

```text
unique(session_id, sender_id)
balance >= 0
```

设计说明：

- `balance` 保存当前余额。
- `session_id + sender_id` 是业务唯一键。
- `id` 只是数据库内部主键，业务代码不应该依赖它做账户标识。

### `points_ledger`

保存积分流水。

建议字段：

```text
id              bigserial 主键
session_id      text，不为空
sender_id       text，不为空
delta           integer，不为空
balance_before  integer，不为空
balance_after   integer，不为空
source          text，不为空
description     text，不为空
operator_id     text，可为空
idempotency_key text，可为空
metadata        jsonb，可为空
created_at      timestamptz，不为空，默认 now()
```

字段含义：

- `delta`：本次积分变化量。
  - 正数表示赚取或增加积分。
  - 负数表示消耗或扣除积分。
  - 业务上不能为 `0`。
- `balance_before`：变化前余额。
- `balance_after`：变化后余额。
- `source`：来源字符串，例如 `checkin`、`expedition`、`admin_adjust`、`initial_grant`。第一版不做枚举约束，但建议插件流水填写自己的插件名。
- `description`：人类可读说明，例如 `每日签到`、`远征报名投入`、`后台补偿`。所有流水必须填写 `description`。
- `operator_id`：触发本次变化的操作者。
  - 用户自己触发时，可以是该用户的 `sender_id`。
  - Web 后台触发时，可以是后台用户 ID。
  - 系统自动结算时，可以是 `system` 或为空。
- `idempotency_key`：业务幂等键，可为空。
  - 用于定时结算、补偿、退款、发奖等可能重试的积分动作。
  - 非空时必须全局唯一。
  - 同一个幂等键再次执行时，如果账户、来源和变化量一致，返回已有流水，不重复改余额。
- `metadata`：业务上下文 JSON。
  - 例如插件 ID、远征策略、报名 ID、后台调整原因等。

基础约束：

```text
not null
unique(idempotency_key)
```

第一版数据库只做基础约束。

以下业务规则由 service 层保证：

```text
delta != 0
balance_before >= 0
balance_after >= 0
balance_after = balance_before + delta
description 非空
```

后续如果需要更强的数据保护，可以再用手写 migration 补充数据库 check constraint。

## 为什么使用 `delta`

流水不拆成 `income_amount` 和 `expense_amount`。

统一使用：

```text
delta
```

这样查询和统计更直接：

```text
赚取 10 积分：delta = 10
消耗 50 积分：delta = -50
```

某个用户累计变化：

```text
sum(delta)
```

某个来源累计发放：

```text
sum(delta) where source = 'checkin' and delta > 0
```

某个来源累计消耗：

```text
sum(abs(delta)) where source = 'expedition' and delta < 0
```

## 余额规则

余额不能为负数。

消耗积分时：

```text
如果 balance < amount，则拒绝本次操作。
```

拒绝时不写流水。

增加积分时：

```text
balance += amount
```

调整积分时：

```text
delta 可以为正数或负数
但最终 balance_after 必须 >= 0
```

## 事务要求

每次积分变化必须在同一个数据库 transaction 里完成：

```text
1. 读取或创建账户
2. 校验余额
3. 更新账户余额
4. 写入积分流水
```

账户余额和流水必须保持一致。

如果更新余额成功但写流水失败，整个事务应该回滚。

积分 Service 支持复用外层业务 transaction。

复杂插件可以在自己的 service 里开启事务，并让积分变更参与同一个事务：

```ts
await db.transaction(async (tx) => {
  const points = pointsService.withTransaction(tx);

  await somePluginStore.writeBusinessState(tx, input);
  await points.spend({
    sessionId,
    senderId,
    amount,
    source: "some-plugin",
    description: "插件业务扣除积分",
    idempotencyKey,
  });
});
```

并发安全由积分 store 的原子更新保证：

```text
update points_accounts
set balance = balance + delta
where session_id = ?
  and sender_id = ?
  and balance + delta >= 0
returning balance_before, balance_after
```

如果传入 `idempotency_key`，积分 store 会在当前 transaction 内对该 key 加 advisory transaction lock，再检查已有流水，避免同一个业务动作在 BullMQ 重试或并发执行时重复扣款、退款或发奖。

## 推荐 Service 接口

积分系统应作为公共 service 注入到插件和后台能力中。

推荐接口草案：

```ts
export interface PointsAccountSnapshot {
  sessionId: string;
  senderId: string;
  balance: number;
}

export interface PointsLedgerEntry {
  id: number;
  sessionId: string;
  senderId: string;
  delta: number;
  balanceBefore: number;
  balanceAfter: number;
  source: string;
  description: string;
  operatorId?: string;
  idempotencyKey?: string;
  metadata?: JsonValue;
  createdAt: Date;
}

export interface ChangePointsInput {
  sessionId: string;
  senderId: string;
  amount: number;
  source: string;
  description: string;
  operatorId?: string;
  idempotencyKey?: string;
  metadata?: JsonValue;
}

export interface AdjustPointsInput {
  sessionId: string;
  senderId: string;
  delta: number;
  source: string;
  description: string;
  operatorId?: string;
  idempotencyKey?: string;
  metadata?: JsonValue;
}

export interface PointsService {
  withTransaction(tx: GatewayTransaction): PointsService;
  getBalance(sessionId: string, senderId: string): Promise<PointsAccountSnapshot>;
  earn(input: ChangePointsInput): Promise<PointsLedgerEntry>;
  spend(input: ChangePointsInput): Promise<PointsLedgerEntry>;
  adjust(input: AdjustPointsInput): Promise<PointsLedgerEntry>;
}
```

接口语义：

- `getBalance`：查询余额，如果账户不存在则懒创建。
- `earn`：增加积分，`amount` 必须大于 0。
- `spend`：消耗积分，`amount` 必须大于 0，余额不足则失败。
- `adjust`：后台或系统调整积分，`delta` 可正可负，但最终余额不能为负。

`earn` 和 `spend` 使用正数 `amount`，service 内部负责转换成流水里的 `delta`：

```text
earn:  delta = +amount
spend: delta = -amount
```

`adjust` 直接使用 `delta`，适合后台手动调整。

第一版先不实现 `listLedger`。

流水查询、账户列表、分页和筛选能力留给 Web 后台接入时再补。

## 推荐错误

第一版可以定义少量明确错误：

```text
InvalidPointsAmountError
InsufficientPointsError
```

建议错误中带上：

```text
sessionId
senderId
balance
requestedAmount
```

这样插件可以给出清晰提示，后台也方便排查。

## 典型流水示例

### 签到发放

```text
session_id = "123@chatroom"
sender_id = "wxid_xxx"
delta = 5
balance_before = 20
balance_after = 25
source = "checkin"
description = "每日签到"
operator_id = "wxid_xxx"
metadata = { "pluginId": "checkin" }
```

签到规则暂未确定，这里只是展示流水形式。

### 远征报名扣款

```text
session_id = "123@chatroom"
sender_id = "wxid_xxx"
delta = -100
balance_before = 200
balance_after = 100
source = "expedition"
description = "远征报名投入"
operator_id = "wxid_xxx"
metadata = {
  "pluginId": "expedition",
  "action": "stake",
  "strategy": "疯狂",
  "stake": 100
}
```

### 远征取消返还

```text
session_id = "123@chatroom"
sender_id = "wxid_xxx"
delta = 100
balance_before = 100
balance_after = 200
source = "expedition"
description = "取消远征返还投入"
operator_id = "wxid_xxx"
metadata = {
  "pluginId": "expedition",
  "action": "refund",
  "entryId": "..."
}
```

### 后台手动调整

```text
session_id = "123@chatroom"
sender_id = "wxid_xxx"
delta = 500
balance_before = 25
balance_after = 525
source = "admin_adjust"
description = "后台补偿"
operator_id = "admin:yangguang"
metadata = {
  "reason": "补偿测试积分"
}
```

## 推荐目录

积分系统是平台公共能力，推荐放在 `src/db` 下：

```text
src/db/
  schema/
    points.ts
  stores/
    points-store.ts
  services/
    index.ts
    points-service.ts
```

接入方式：

```text
src/index.ts
  new PointsStore(postgresStore.db)
  new PointsService(pointsStore)
  new PluginRouter({ points: pointsService, ... })
```

`PluginServices` 中后续可以增加：

```ts
points: PointsService;
```

这样签到、远征、后台管理和未来其他插件都可以复用同一套积分能力。

## 非目标

第一版暂不处理：

- 签到具体奖励规则。
- 每日签到限制。
- 积分排行榜。
- 积分过期。
- 跨群共享积分。
- 复杂审计审批流程。

这些可以在核心积分账户和流水稳定后再扩展。
