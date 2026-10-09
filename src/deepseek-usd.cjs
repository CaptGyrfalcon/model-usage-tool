const DAY = 86400000;
const {estimateNativeFee} = require('./deepseek-estimate.cjs');
const SOURCE = 'Frankfurter / ECB';
function validDate(date) {
  return typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date)
    && Number.isFinite(Date.parse(date)) && new Date(date).toISOString().slice(0,10) === date;
}
function rateUrl(date) { return `https://api.frankfurter.dev/v2/providers/ecb/rate/cny/usd?date=${date}`; }
function validRate(rate, requested) {
  return rate?.source === SOURCE && rate.requestedDate === requested && validDate(rate.date)
    && Number.isFinite(rate.rate) && rate.rate > 0
    && Date.parse(rate.date) <= Date.parse(requested) && Date.parse(requested)-Date.parse(rate.date) <= 10*DAY;
}
async function fetchHistoricalUsdRate(history, date, { fetchFn = fetch, now = Date.now() } = {}) {
  if (!validDate(date)) throw new Error('DeepSeek 消费日期无效');
  const key=`fx:ecb:CNY:USD:${date}`;
  const cached=history.loadCache(key)?.value;
  if(validRate(cached,date)) return cached;
  const response=await fetchFn(rateUrl(date),{headers:{Accept:'application/json'},redirect:'error',signal:AbortSignal.timeout(15000)});
  if(!response.ok) throw new Error('历史美元汇率暂不可用');
  const body=await response.json();
  const result={requestedDate:date,date:body.date,rate:body.rate,source:SOURCE,url:rateUrl(date),fetchedAt:now};
  if(body.base!=='CNY'||body.quote!=='USD'||!validRate(result,date)) throw new Error('历史美元汇率响应无效');
  history.saveCache(key,result);
  return result;
}
function billingUsdPricing(event) {
  if(!['CNY','USD'].includes(event.billingCurrency)||event.billingAmount==null||event.billingAmount==='') return null;
  const amount=Number(event.billingAmount);
  if(!Number.isFinite(amount)||amount<0) return null;
  if(event.billingCurrency==='CNY' && !validRate({requestedDate:event.billingDate,date:event.fxDate,
    rate:event.fxRate,source:event.fxSource},event.billingDate)) return null;
  const cents=amount*(event.billingCurrency==='USD'?1:event.fxRate)*100;
  if(!Number.isFinite(cents)) return null;
  const estimated = event.billingKind === 'estimated';
  const basis = event.billingBasis;
  const highCents = estimated && basis?.period==='unknown-holiday' ? cents*2 : cents;
  return {equivalentCostCents:cents,equivalentCostLowCents:cents,equivalentCostHighCents:highCents,
    // A currency conversion is display cost, never a subscription allowance.
    quotaEquivalentCostCents:null,quotaEquivalentCostLowCents:null,quotaEquivalentCostHighCents:null,
    inputCostCents:null,cacheReadCostCents:null,cacheWriteCostCents:null,cacheCostCents:null,outputCostCents:null,
    pricingSnapshotId:null,pricingStatus:estimated ? 'estimated-deepseek-cny-fx' : event.billingCurrency==='USD'?'official-billing-usd':'official-billing-fx'};
}
async function addHistoricalUsdPricing(history, events, options) {
  events = events.map(estimateNativeFee);
  const rates=new Map(),errors=[];
  const dates=[...new Set(events.filter(event=>event.source==='deepseek'&&event.billingCurrency==='CNY'&&event.billingAmount!=null
    && !validRate({requestedDate:event.billingDate,date:event.fxDate,rate:event.fxRate,source:event.fxSource},event.billingDate)).map(event=>event.billingDate))];
  for(const date of dates) {
    try {rates.set(date,await fetchHistoricalUsdRate(history,date,options));}
    catch {errors.push({date,error:'历史美元汇率暂不可用，保留原币金额'});}
  }
  const priced=events.map(event=>{
    const rate=rates.get(event.billingDate);
    const row={...event,...(rate?{fxRate:rate.rate,fxDate:rate.date,fxSource:rate.source}:{})};
    return {...row,...(billingUsdPricing(row)||{})};
  });
  return {events:priced,errors};
}
module.exports={fetchHistoricalUsdRate,billingUsdPricing,addHistoricalUsdPricing,rateUrl};
