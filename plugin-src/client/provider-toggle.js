/**
 * 供应商（provider）开关的纯逻辑 —— 分组、开关态、汇总与结果文案。
 *
 * 移植自来源 `plugin-src/client/provider-toggle.js`（同名单测一起移）。
 *
 * ## ⚠️ 与来源的两处**刻意分叉**（不是遗漏，别「修回去」）
 *
 * 1. **开关状态是独立字段，不是推导值**。来源的 `closed` 由「该供应商的模型
 *    是否全关」推导（`models.total > 0 && disabled === total`）；本项目的
 *    provider 开关是 `disabledProviders` 里的**独立键**（`pool.providerEnabled`），
 *    且关闭是**硬拦截**——调用其模型直接 404（AGENTS.md「分叉点」表第一条：
 *    对外提供 API 时目录过滤形同虚设）。故本模块的判据是 `enabled !== false`，
 *    宿主侧 `GET /api/providers` 直接给 `enabled`，**前端不重算**（与来源同一
 *    纪律：判据只留一处，两处实现迟早漂移）。
 * 2. **关闭不停用账号**。来源的关闭 = 关全部模型 + 停全部账号（还要讲究
 *    「先关模型再停账号」的顺序）；本项目只切 provider 开关，账号的 `enabled`
 *    由账号卡片上的独立操作管理。所以这里没有账号批量停用的调用点，也没有
 *    顺序问题——但**影响面文案必须如实**：关闭后自动选号跳过该 provider 的
 *    账号（`getAvailableAccount` 的 provider 层过滤），调用其模型返回 404。
 *
 * ## 状态读不到时怎么办
 *
 * `groupProviders` 把**状态缺失**的供应商归入「已打开」组（宁多勿少：把实际
 * 已关闭的显示成打开，用户看到的是开关与实际不符；把已打开的显示成关闭，
 * 用户会以为功能莫名坏了）。但 `known: false` 会一路带到行数据上，界面据此
 * 禁用该行开关并说明「状态未知」——**显示可以保守，操作必须明确**。
 */

/**
 * 按开关状态把供应商分成「已打开 / 已关闭」两组。
 *
 * @param providers - PROVIDERS 常量（声明顺序即展示顺序）。
 * @param statuses - `GET /api/providers` 的 enabled 映射（`id → { enabled }`）；
 *   整体或单项缺失时该项按「已打开」归组（见文件头）。
 * @returns 两组数组；组内保持 providers 的声明顺序（不重排）。
 */
export function groupProviders(providers, statuses) {
  const open = [];
  const closed = [];
  const map = (statuses && typeof statuses === 'object') ? statuses : {};
  for (const provider of providers || []) {
    // ⚠️ 判据只认**显式 false**：缺失/undefined/非布尔都按打开（保守方向）。
    //    与 account-pool.ts 的 providerEnabled（`!== true` 判关闭）方向一致，
    //    只是这里反过来写——关闭必须显式。
    if (map[provider?.id]?.enabled === false) closed.push(provider);
    else open.push(provider);
  }
  return { open, closed };
}

/**
 * 左侧导航（rail）要显示的供应商：**只列已打开的**。
 *
 * 2026-10-15 用户要求「当供应商[被]关闭时，直接不要在左侧显示」。判据与
 * `groupProviders` 逐字一致（只认显式 `false`，缺失按打开）—— 藏不藏是
 * **展示层**的事，不能反过来改开关语义：状态读不到时若把供应商从导航里
 * 摘掉，用户会以为它莫名消失，且页头弹窗之外再无处可点。故 `statuses`
 * 整体缺失 / 非对象 ⇒ 全量返回。
 *
 * @param providers - PROVIDERS 常量（声明顺序即展示顺序）。
 * @param statuses - `GET /api/providers` 的 enabled 映射（`id → { enabled }`）。
 * @returns 过滤后的数组；组内保持 providers 的声明顺序（不重排）。
 */
export function visibleRailProviders(providers, statuses) {
  const map = (statuses && typeof statuses === 'object') ? statuses : {};
  return (providers || []).filter(p => map[p?.id]?.enabled !== false);
}

/**
 * 左侧导航当前应展示的供应商 id。
 *
 * 选中的那个被关掉时必须换到第一个可见项，否则右侧面板会显示一个左侧
 * 看不见的供应商（用户点不到它，也不知道怎么切回去）。全部关掉时返回
 * `null` —— 界面据此显示「全部已关闭」空态并给出去总开关的入口，
 * 而不是留一片没有任何说明的空白。
 *
 * @param visible - `visibleRailProviders` 的结果（已按声明顺序）。
 * @param selectedId - 用户当前选中的 id（可能已经不可见）。
 * @returns 可见的选中 id、第一个可见 id，或 `null`（无可见供应商）。
 */
export function resolveRailSelection(visible, selectedId) {
  if (!visible || visible.length === 0) return null;
  if (visible.some(p => p.id === selectedId)) return selectedId;
  return visible[0].id;
}

/**
 * 单个供应商的开关态。
 *
 * @param status - `GET /api/providers` 里该项（`{ enabled, accountCount, … }`）。
 * @returns `checked`（开关位置）、`known`（状态是否明确读到）、`reason`
 *   （禁用原因；本项目没有「没有可关闭的模型」这种服务端约束，故只有
 *   「状态未知」一种）。
 */
export function providerSwitchState(status) {
  const known = typeof status === 'object' && status !== null;
  return {
    checked: known ? status.enabled !== false : true,
    known,
    reason: known ? null : '状态未知（未能读取该供应商的开关状态），请稍后重试',
  };
}

/**
 * 弹窗行数据（分组 + 开关态 + 计数）。
 *
 * 已打开组在前、已关闭组在后；`accountCount` / `enabledAccountCount` 直接
 * 透传（`GET /api/providers` 已带），界面用来显示「N 个账号（M 个启用）」。
 */
export function providerSwitchRows(providers, statuses) {
  const map = (statuses && typeof statuses === 'object') ? statuses : {};
  const { open, closed } = groupProviders(providers, statuses);
  const toRow = (provider) => {
    const status = map[provider?.id];
    const state = providerSwitchState(status);
    return {
      id: provider.id,
      label: provider.label,
      checked: state.checked,
      known: state.known,
      reason: state.reason,
      accountCount: typeof status?.accountCount === 'number' ? status.accountCount : null,
      enabledAccountCount: typeof status?.enabledAccountCount === 'number' ? status.enabledAccountCount : null,
    };
  };
  return [...open.map(toRow), ...closed.map(toRow)];
}

/**
 * 页头按钮 tooltip / 弹窗副标题的汇总计数。
 *
 * @returns `{ open, closed, known }`；`known: false` 表示整体状态没读到
 *   （界面据此不显示计数，而不是显示「已打开 0 个」——「不知道」与「确实是 0」
 *   必须能区分）。
 */
export function providerToggleSummary(providers, statuses) {
  if (typeof statuses !== 'object' || statuses === null) {
    return { open: 0, closed: 0, known: false };
  }
  const { open, closed } = groupProviders(providers, statuses);
  return { open: open.length, closed: closed.length, known: true };
}

/**
 * 一次开关操作的结果文案。
 *
 * ⚠️ 必须讲清**本项目的实际语义**（与来源不同）：关闭 = 该 provider 的模型
 * 全部不可用（调用返回 404）+ 自动选号跳过它的账号；**不停用账号**、不删
 * 凭据。写成「已关闭，账号已停用」会让用户去账号卡片里找不存在的停用态。
 *
 * @param label - 供应商展示名。
 * @param enabled - 变更**后**的状态。
 * @param status - 该供应商的状态（取账号数；读不到时省略括号部分）。
 */
export function summarizeProviderToggle(label, enabled, status) {
  const accounts = typeof status?.accountCount === 'number' ? status.accountCount : null;
  const scope = accounts === null ? '' : `（${accounts} 个账号）`;
  if (enabled) {
    return `已打开 ${label}${scope}：它的模型重新可用，自动选号恢复参与。`;
  }
  return `已关闭 ${label}${scope}：调用它的模型将返回 404，自动选号跳过它的账号。`
    + '账号与凭据不受影响，随时可以重新打开。';
}

/**
 * 关闭前的确认文案（影响面如实告知）。
 *
 * ⚠️ 与来源的最大差异就在这里：来源是「从对话框的模型选择里移除」（仍可
 * 按 id 调用），本项目是**硬拦截 404**。文案必须让用户知道这一点的分量——
 * 正在用该 provider 模型的客户端会立刻开始报错。
 */
export function providerCloseConfirmCopy(label, status) {
  const accounts = typeof status?.accountCount === 'number' ? status.accountCount : null;
  const lines = [
    `确认关闭供应商「${label}」？`,
    '',
    '关闭后：',
    '· 该供应商的全部模型立即不可用——调用它们会返回 404 model_not_found；',
    '· 自动选号不再选择它的账号（账号本身保持启用，凭据不受影响）；',
    '· 随时可以重新打开，重新打开后全部恢复。',
  ];
  if (accounts !== null && accounts > 0) {
    lines.splice(2, 0, `· 影响 ${accounts} 个已配置账号的可用性（不会被停用）。`);
  }
  return lines.join('\n');
}
