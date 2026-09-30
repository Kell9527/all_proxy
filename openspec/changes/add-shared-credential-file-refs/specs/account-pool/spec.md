# Spec Delta

## Purpose

定义账号池在「凭据可被多个消费者共享」场景下的保管与刷新行为：文件形式的凭据引用、按凭据单飞的刷新、续期作用于实际选中的账号，以及备份对文件引用的往返。

## ADDED Requirements

### Requirement: 凭据引用的两种形态

系统 SHALL 支持两种凭据引用形态：**内置**（形如 `<PROVIDER>_ACCOUNT_<HEX>`，凭据存于本服务自己的凭据文件）与**文件引用**（形如 `FILE:<绝对路径>`，凭据存于该外部文件）。系统 MUST 依据前缀判定形态，MUST NOT 依据字符串是否「看起来像路径」来猜测。

#### Scenario: 文件引用前缀识别

- **WHEN** 凭据引用以 `FILE:` 开头
- **THEN** 系统 SHALL 按文件引用处理，并把其余部分作为路径

#### Scenario: 内置引用不被误判

- **WHEN** 凭据引用不含 `FILE:` 前缀（例如形如 `C:\x\auth.json` 的字符串）
- **THEN** 系统 SHALL 按内置引用处理，MUST NOT 尝试读盘

#### Scenario: 波浪号展开

- **WHEN** 用户在绑定接口给出以 `~` 或 `~/` 开头的路径
- **THEN** 系统 SHALL 展开为用户主目录后再校验与保存

#### Scenario: 相对路径被拒

- **WHEN** 用户给出相对路径
- **THEN** 系统 SHALL 拒绝绑定并说明必须是绝对路径

### Requirement: 文件引用的读写语义

系统 SHALL 对文件形式的凭据引用提供实时读写：读取时**每次**从文件读取当前内容（MUST NOT 缓存），写入时原子写回该文件。

#### Scenario: 读取反映文件最新内容

- **WHEN** 其它消费者在读取之间修改了该文件
- **THEN** 系统下一次读取 SHALL 返回文件的最新内容

#### Scenario: 写入落回外部文件

- **WHEN** 系统刷新了文件引用账号的凭据
- **THEN** 新凭据 SHALL 写入该外部文件，且 MUST NOT 作为普通键写进本服务的凭据文件

#### Scenario: 原子写

- **WHEN** 系统写回外部凭据文件
- **THEN** 写入 SHALL 通过临时文件加改名完成，MUST NOT 留下半截内容或残留临时文件

#### Scenario: 文件缺失

- **WHEN** 文件引用的目标文件不存在或不可读
- **THEN** 系统 SHALL 视该账号凭据缺失，且 MUST NOT 抛错中断其它账号的处理

### Requirement: 外部凭据文件的所有权

系统 SHALL 把外部凭据文件视为**不属于自己**：删除账号或解除引用时 MUST NOT 删除该文件。

#### Scenario: 删除账号不删文件

- **WHEN** 用户删除一个绑定到共享凭据文件的账号
- **THEN** 系统 SHALL 移除账号条目，且该外部文件 SHALL 保持不变

#### Scenario: 解除引用不删文件

- **WHEN** 系统对文件引用执行凭据删除
- **THEN** 该操作 SHALL 为无操作，外部文件 SHALL 保持不变

### Requirement: 凭据换绑与迁移

系统 SHALL 提供把账号的凭据引用换绑到另一引用（通常为文件引用）的能力；当目标引用下**已有**可读凭据时 SHALL 以该内容为准而不覆盖它；当目标引用下无内容且原引用有内容时 SHALL 迁移内容，使账号不因换绑而失去凭据。

#### Scenario: 绑到尚无内容的文件

- **WHEN** 用户把账号绑到一个尚未存在（或为空）的文件
- **THEN** 系统 SHALL 把当前凭据内容写入该文件，账号继续可用

#### Scenario: 绑到已有内容的文件

- **WHEN** 用户把账号绑到一个已含凭据的文件
- **THEN** 系统 SHALL 保留文件内容，MUST NOT 用账号原有凭据覆盖它

#### Scenario: 解绑转存

- **WHEN** 用户解除共享文件绑定
- **THEN** 系统 SHALL 把当前凭据内容转存到内置引用，账号继续可用

### Requirement: 刷新按凭据单飞

系统 SHALL 保证对同一凭据引用的并发刷新只向上游发起一次请求；不同凭据的刷新 MUST 可并行。

#### Scenario: 并发刷新同一凭据

- **WHEN** 同一账号的刷新被并发触发（请求路径与定时任务重叠）
- **THEN** 上游 SHALL 只收到一次刷新请求

#### Scenario: 多账号共享同一凭据

- **WHEN** 多个账号条目指向同一个凭据引用且同时需要刷新
- **THEN** 上游 SHALL 只收到一次刷新请求，且各账号的过期时间 SHALL 都被更新

#### Scenario: 失败不被缓存

- **WHEN** 一次刷新失败后再次触发刷新
- **THEN** 系统 SHALL 重新尝试，MUST NOT 复用先前的失败结果

### Requirement: 续期作用于实际选中的账号

系统 SHALL 请求级续期**实际被选中的账号**，MUST NOT 改用该 provider 的其它账号。

#### Scenario: 选中账号临期

- **WHEN** 适配器选中的账号凭据临期或上游返回鉴权失败
- **THEN** 系统 SHALL 刷新该账号的凭据，且 MUST NOT 刷新该 provider 的其它账号

### Requirement: 刷新前重读凭据

系统 SHALL 在每次刷新前**重新读取**该凭据的最新内容，并使用其中的续期材料。系统中所有触发刷新的路径（请求前临期、上游鉴权失败重试、定时任务）SHALL 共用同一份实现。

#### Scenario: 使用文件中的最新续期材料

- **WHEN** 凭据引用的续期材料在别处已被更新
- **THEN** 系统发起的刷新请求 SHALL 携带更新后的材料

### Requirement: 备份对文件引用的往返

系统 SHALL 在导出备份时把文件引用的凭据内容**内联**进备份，使备份自包含；导入时 SHALL 按引用语义写回原路径。写回失败时 SHALL 记录并跳过，MUST NOT 把内容降级写进内置凭据存储。

#### Scenario: 导出内联内容

- **WHEN** 导出含文件引用账号的备份
- **THEN** 备份中该引用的值 SHALL 是文件当时的内容

#### Scenario: 导入写回原路径

- **WHEN** 导入的备份含文件引用
- **THEN** 系统 SHALL 把内容写入该引用指向的文件，且 MUST NOT 在凭据文件中留下该键

#### Scenario: 路径不可写

- **WHEN** 导入时文件引用的路径不可写
- **THEN** 系统 SHALL 跳过该条并记入跳过清单，其账号 SHALL 计为凭据缺失，且整体导入 SHALL 继续完成

## MODIFIED Requirements

### Requirement: 凭据引用格式

系统 SHALL 支持两种凭据引用格式：内置引用形如 `<PROVIDER>_ACCOUNT_<HEX>`（在同一 provider 内唯一），文件引用形如 `FILE:<绝对路径>`。

#### Scenario: 内置引用格式

- **WHEN** 系统为某账号生成凭据引用
- **THEN** 引用形如 `<PROVIDER>_ACCOUNT_<HEX>`，且在同一 provider 内唯一

#### Scenario: 文件引用格式

- **WHEN** 用户把账号绑定到共享凭据文件
- **THEN** 引用 SHALL 形如 `FILE:<绝对路径>`，路径 SHALL 为展开后的绝对路径

### Requirement: 删除账号连带清理凭据

系统 SHALL 在删除账号时清理其凭据本体，不留下孤立凭据；当凭据为文件引用时，SHALL 只移除账号条目，MUST NOT 删除该外部文件。

#### Scenario: 删除内置凭据账号

- **WHEN** 用户删除一个使用内置引用的账号
- **THEN** 系统 SHALL 同时删除该账号的凭据本体，不留下孤立凭据

#### Scenario: 删除共享文件账号

- **WHEN** 用户删除一个使用文件引用的账号
- **THEN** 系统 SHALL 移除账号条目，且外部凭据文件 SHALL 保持不变
