const { createHash } = require('node:crypto');
const DAY = 86400000;
const SCALE = 10n ** 18n;
function money(value) {
  const text = String(value);
  const match = text.match(/^([+-]?)(\d+)(?:\.(\d*))?(?:e([+-]?\d+))?$/i);
  if (!match) throw new Error('DeepSeek 历史账单金额无效');
  const power = 18 + Number(match[4] || 0) - (match[3] || '').length;
  if (!Number.isSafeInteger(power) || Math.abs(power) > 100) throw new Error('DeepSeek 历史账单金额精度无效');
  let units = BigInt(match[2] + (match[3] || ''));
  if (power >= 0) units *= 10n ** BigInt(power);
  else {
    const divisor = 10n ** BigInt(-power);
    if (units % divisor) throw new Error('DeepSeek 历史账单金额精度过高');
    units /= divisor;
  }
  return match[1] === '-' ? -units : units;
}
function amount(units) { return Number(units) / Number(SCALE); }
function exactAmount(units) {
  const whole=units/SCALE, fraction=(units%SCALE).toString().padStart(18,'0').replace(/0+$/,'');
  return `${whole}${fraction?'.'+fraction:''}`;
}
function check(condition, message) { if (!condition) throw new Error(message); }
function integer(value) {
  const number = Number(value);
  check(Number.isSafeInteger(number) && number >= 0, 'DeepSeek 历史 Token 或请求计数无效');
  return number;
}
function add(map, key, value) { map.set(key, (map.get(key) || 0n) + value); }
function historyCacheKey(accountKey) { return `deepseek-platform-history:${accountKey}`; }
function dailyEventKey(accountKey, series, timestamp) {
  const identity=JSON.stringify([accountKey,series.api_key?.tracking_id??null,series.model,timestamp]);
  return `deepseek:platform-daily:${createHash('sha256').update(identity).digest('hex')}`;
}

// The Platform's daily exports are account-wide, not per-request Harness logs.
// Reconstruct balances only when every debit and credit reconciles exactly with
// today's individual wallets and lifetime costs. Never invent missing adjustments.
function buildDeepSeekArchive({ accountKey, amountWindows, costWindows, walletCosts, invoices, summary,
  start, end, closedBefore, tz = 28800, now = Date.now() }) {
  check(accountKey && Number.isFinite(start) && end > start && closedBefore <= end && closedBefore > start,
    'DeepSeek 历史导入范围无效');
  check(Number.isInteger(tz) && tz % 900 === 0 && tz >= -43200 && tz <= 50400 && (closedBefore + tz*1000) % DAY === 0,
    'DeepSeek 历史导入的时区或日边界无效');
  const events = [], eventKeys = new Set(), apiCosts = new Map(), csvCosts = new Map(), eventBills = new Map();
  for (const window of amountWindows) {
    check(window.bucket === 86400 && Array.isArray(window.series), 'DeepSeek 历史用量不是日汇总');
    for (const series of window.series) for (const bucket of series.buckets) {
      const timestamp = integer(bucket.time) * 1000;
      check(timestamp >= start && timestamp < end, 'DeepSeek 历史用量越界');
      const input = integer(bucket.usage.PROMPT_CACHE_MISS_TOKEN), output = integer(bucket.usage.RESPONSE_TOKEN);
      const cacheRead = integer(bucket.usage.PROMPT_CACHE_HIT_TOKEN), count = integer(bucket.usage.REQUEST);
      if (!count && !input && !output && !cacheRead) continue;
      check(count > 0, 'DeepSeek 日汇总缺少请求次数');
      if (timestamp >= closedBefore) continue;
      const eventKey = dailyEventKey(accountKey,series,timestamp);
      check(!eventKeys.has(eventKey), 'DeepSeek 历史查询窗口重叠');
      eventKeys.add(eventKey);
      events.push({ source: 'deepseek', eventKey, timestamp, model: series.model,
        pool: 'deepseek-platform-daily', input, output, cacheRead, cacheWrite: 0, count,
        fast: false, fastKnown: false, costCents: null, pricingStatus: 'unavailable' });
    }
  }
  for (const window of costWindows) {
    check(window.bucket === 86400 && Array.isArray(window.data), 'DeepSeek 历史消费不是日汇总');
    for (const entry of window.data) {
      check(['CNY','USD'].includes(entry.currency), 'DeepSeek 历史消费币种无效');
      for (const series of entry.series) for (const bucket of series.buckets) {
        const debit = money(bucket.cost);
        check(debit >= 0n, 'DeepSeek 历史消费含未知调整');
        if (debit) {
          add(apiCosts, JSON.stringify([Number(bucket.time)*1000, series.model, entry.currency]), debit);
          const eventKey=dailyEventKey(accountKey,series,Number(bucket.time)*1000);
          const existing=eventBills.get(eventKey);
          check(!existing||existing.currency===entry.currency,'DeepSeek 同一日记录含多个计费币种');
          eventBills.set(eventKey,{currency:entry.currency,units:(existing?.units||0n)+debit});
        }
      }
    }
  }
  const debits = [], totals = new Map(), paidDebits = new Map(), bonusDebits = new Map();
  for (const row of walletCosts) {
    const timestamp = Date.parse(row.start), finish = Date.parse(row.end), cost = money(row.cost);
    check(['Paid','Granted'].includes(row.walletType) && ['CNY','USD'].includes(row.currency) && cost >= 0n,
      'DeepSeek 导出账单含不支持的钱包扣款');
    check(timestamp >= start && finish <= end && finish - timestamp === DAY, 'DeepSeek 导出账单日期无效');
    add(csvCosts, JSON.stringify([timestamp, row.model, row.currency]), cost);
    add(totals, row.currency, cost);
    add(row.walletType === 'Paid' ? paidDebits : bonusDebits, row.currency, cost);
    debits.push({ timestamp, currency: row.currency, wallet: row.walletType === 'Paid' ? 'toppedUp' : 'granted', units: cost });
  }
  check(apiCosts.size === csvCosts.size && [...apiCosts].every(([key,value]) => csvCosts.get(key) === value),
    'DeepSeek 消费接口与导出账单不一致，未回算余额');
  for(const event of events) {
    const bill=eventBills.get(event.eventKey);
    if(bill) Object.assign(event,{billingCurrency:bill.currency,billingAmount:exactAmount(bill.units),
      billingDate:new Date(event.timestamp+tz*1000).toISOString().slice(0,10)});
  }
  const lifetime = new Map(summary.total_costs.map(row => [row.currency, money(row.amount)]));
  const currencies = new Set([...totals.keys(), ...lifetime.keys(), ...summary.normal_wallets.map(row=>row.currency), ...summary.bonus_wallets.map(row=>row.currency)]);
  for (const currency of currencies) check((lifetime.get(currency)||0n) === (totals.get(currency)||0n),
    'DeepSeek 历史范围未覆盖累计消费，未回算余额');
  const credits = [];
  for (const row of invoices.payment_orders) {
    check(!['REFUNDED','CHARGEBACK'].includes(row.payment_order_status), 'DeepSeek 历史含退款，未回算余额');
    if (row.payment_order_status !== 'SUCCESS') continue;
    credits.push({ timestamp: Date.parse(row.paid_at), currency: row.currency, wallet:'toppedUp', units:money(row.amount) });
  }
  for (const row of invoices.bonus_orders) {
    check(['ACTIVE','EXHAUSTED'].includes(row.bonus_order_status), 'DeepSeek 历史含赠送过期调整，未回算余额');
    credits.push({ timestamp:Date.parse(row.inserted_at), currency:row.currency, wallet:'granted', units:money(row.amount) });
  }
  for (const credit of credits) check(Number.isFinite(credit.timestamp) && credit.timestamp >= start && credit.timestamp < now
    && ['CNY','USD'].includes(credit.currency) && credit.units >= 0n, 'DeepSeek 历史收入不在完整账单范围内');
  const samples = [];
  for (const currency of currencies) {
    const incomes = credits.filter(row=>row.currency===currency), expenses = debits.filter(row=>row.currency===currency);
    const sum = (rows, wallet) => rows.filter(row=>row.wallet===wallet).reduce((n,row)=>n+row.units,0n);
    const currentPaid = summary.normal_wallets.filter(row=>row.currency===currency).reduce((n,row)=>n+money(row.balance),0n);
    const currentBonus = summary.bonus_wallets.filter(row=>row.currency===currency).reduce((n,row)=>n+money(row.balance),0n);
    check(sum(incomes,'toppedUp')-(paidDebits.get(currency)||0n)===currentPaid
      && sum(incomes,'granted')-(bonusDebits.get(currency)||0n)===currentBonus,
      'DeepSeek 充值、赠送与当前钱包未对平，未回算余额');
    if (!incomes.length && !expenses.length) continue;
    const first = Math.min(...incomes.map(row=>row.timestamp), ...expenses.map(row=>row.timestamp));
    const firstDay = Math.floor((first+tz*1000)/DAY)*DAY-tz*1000;
    const state = { toppedUp:0n, granted:0n };
    const point = timestamp => ({ source:'deepseek',accountKey,currency,timestamp,
      total:amount(state.toppedUp+state.granted), toppedUp:amount(state.toppedUp),granted:amount(state.granted),origin:'platform-ledger-daily' });
    samples.push(point(firstDay));
    for (let day=firstDay;day<closedBefore;day+=DAY) {
      for (const row of incomes) if(row.timestamp>=day&&row.timestamp<day+DAY) state[row.wallet]+=row.units;
      for (const row of expenses) if(row.timestamp>=day&&row.timestamp<day+DAY) state[row.wallet]-=row.units;
      samples.push(point(day+DAY-1));
    }
  }
  const metadata = { start,end:closedBefore,queriedEnd:end,importedAt:now,origin:'platform-daily',
    requests:events.reduce((n,event)=>n+event.count,0), tokens:events.reduce((n,event)=>n+event.input+event.output+event.cacheRead,0),
    eventRows:events.length,balancePoints:samples.length,
    costs:[...totals].map(([currency,units])=>({currency,amount:amount(units)})),
    balanceStart:samples.length?Math.min(...samples.map(row=>row.timestamp)):null };
  return { accountKey, events, samples, metadata };
}
function importDeepSeekArchive(history, archive) {
  history.db.exec('BEGIN IMMEDIATE');
  try {
    history.upsertEvents(archive.events, {transaction:false});
    for(const sample of archive.samples) history.saveBalanceSample(sample);
    history.saveCache(historyCacheKey(archive.accountKey), archive.metadata);
    history.db.exec('COMMIT');
  } catch(error) { history.db.exec('ROLLBACK'); throw error; }
  return archive.metadata;
}
function uncoveredHarnessEvents(events, metadata) {
  return metadata ? events.filter(event=>event.timestamp < metadata.start || event.timestamp >= metadata.end) : events;
}
module.exports = { money, buildDeepSeekArchive, importDeepSeekArchive, historyCacheKey, uncoveredHarnessEvents };
