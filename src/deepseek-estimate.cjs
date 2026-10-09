// Verified against https://api-docs.deepseek.com/zh-cn/quick_start/pricing/.
// Never apply today's prices retroactively to older unbilled sessions.
const PRICE_DATE = '2026-10-05';
const PRICE_URL = 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/';
const HOLIDAY_URL = 'https://www.beijing.gov.cn/fuwu/bmfw/sy/jrts/202511/t20251104_4258838.html';
const HOLIDAYS = {2026: [[1,1,3],[2,15,23],[4,4,6],[5,1,5],[6,19,21],[9,25,27],[10,1,7]]};
const PRICES = {
  'deepseek-flash': {input:1, cacheRead:0.02, output:4},
  'deepseek-v4-pro': {input:4.5, cacheRead:0.15, output:13.5},
};
function estimateNativeFee(event) {
  if(event.source !== 'deepseek' || event.pool === 'deepseek-platform-daily' || event.billingAmount != null) return event;
  const local = new Date(Number(event.timestamp) + 8*3600000);
  if(!Number.isFinite(+local)) return event;
  const date = local.toISOString().slice(0,10);
  if(date < PRICE_DATE) return event;
  const model = ['deepseek-v4-flash','deepseek-v4-flash-vision-exp'].includes(event.model) ? 'deepseek-flash' : event.model;
  const rates = PRICES[model];
  if(!rates) return event;
  const tokens = Object.fromEntries(['input','output','cacheRead','cacheWrite'].map(key=>[key,Number(event[key] ?? 0)]));
  if(!Object.values(tokens).every(value=>Number.isSafeInteger(value)&&value>=0)) return event;
  const weekday = local.getUTCDay(), minutes = local.getUTCHours()*60 + local.getUTCMinutes();
  const peakWindow = weekday>=1 && weekday<=5 && ((minutes>=540&&minutes<720)||(minutes>=840&&minutes<1080));
  const holidays = HOLIDAYS[local.getUTCFullYear()];
  const holiday = holidays?.some(([month,start,end])=>local.getUTCMonth()+1===month&&local.getUTCDate()>=start&&local.getUTCDate()<=end);
  const uncertain = peakWindow && !holidays;
  const multiplier = peakWindow && !holiday && !uncertain ? 2 : 1;
  const amount = ((tokens.input+tokens.cacheWrite)*rates.input + tokens.cacheRead*rates.cacheRead + tokens.output*rates.output)/1e6*multiplier;
  return {...event,billingCurrency:'CNY',billingAmount:String(amount),billingDate:date,billingKind:'estimated',
    billingBasis:{priceDate:PRICE_DATE,url:PRICE_URL,holidayUrl:HOLIDAY_URL,model,rates,multiplier,
      period:uncertain?'unknown-holiday':multiplier===2?'peak':'offpeak',highMultiplier:uncertain?2:multiplier}};
}
function updateNativeEstimate(event, previous) {
  if(previous?.billingKind !== 'estimated' || !previous.billingBasis?.rates) return event;
  const basis = previous.billingBasis, rates = basis.rates;
  const amount = ((Number(event.input||0)+Number(event.cacheWrite||0))*rates.input + Number(event.cacheRead||0)*rates.cacheRead + Number(event.output||0)*rates.output)/1e6*basis.multiplier;
  return {...event,billingCurrency:previous.billingCurrency,billingAmount:String(amount),billingDate:previous.billingDate,
    billingKind:'estimated',billingBasis:basis,fxRate:previous.fxRate,fxDate:previous.fxDate,fxSource:previous.fxSource};
}
module.exports = {estimateNativeFee,updateNativeEstimate,PRICE_DATE};
