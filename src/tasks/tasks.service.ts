import axios from 'axios';
import * as qs from 'qs';
import * as moment from 'moment'

import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';

import { bitmexOrder, upbitOrder } from '../utils/request/order';
import getGimp from '../utils/math/gimp';
import { Config } from '../utils/config';
import { upbitAccountLookUp } from '../utils/request/lookup'

import { UsersService } from '../users/users.service'
import { GimpsService } from '../gimps/gimps.service'
import { TradeLogsService } from '../trade-logs/trade-logs.service'
import { User } from '../users/user.entity'
import { Gimp } from '../gimps/gimp.entity'
import { TradeLog } from '../trade-logs/trade-log.entity'

const {
  FIXED_USDKRW,
  BITMEX_API_URL,
  UPBIT_API_URL,
  FREEFORE_API_URL,
  SELL, 
  BUY,
} = Config;

@Injectable()
export class TasksService {
  private isSync = false;
  private readonly logger = new Logger(TasksService.name);

  constructor(private usersService: UsersService, private gimpsService: GimpsService, private tradeLogsService: TradeLogsService) {}

  async syncData() : Promise<any>{
    const lastIndex: Gimp = await this.gimpsService.findLastUpdatedGimp()
    const lastUpdatedDatetime = lastIndex ? moment(lastIndex.datetime).utc() : moment().subtract(1,'months').utc();
    const lastCheckTime = lastUpdatedDatetime.add(1, 'minutes').seconds(0).milliseconds(0)

    while(true) {
      const currentTime = moment()
        .seconds(0)
        .milliseconds(0)
        .utc()
      if (lastCheckTime >= currentTime) break;

      const searchStartPoint = moment(lastCheckTime);
      lastCheckTime.add(199, 'minutes');

      const bitmexRequest = await axios
        .get(
          `https://www.bitmex.com/api/v1/trade/bucketed?binSize=1m&symbol=XBT&reverse=true&endTime=${lastCheckTime}&count=200`,
        )
      const upbitRequest = await axios
        .get(
          `https://api.upbit.com/v1/candles/minutes/1?market=KRW-BTC&count=200&to=${lastCheckTime
            .add(1, 'minutes')
            .format('YYYY-MM-DD HH:mm:ss')}`,
        )

      const bitmexData = bitmexRequest.data.reverse();
      const upbitData = upbitRequest.data.reverse();

      let bitmexIterator = 0
      let upbitIteratior = 0

      for (let i = 0 ; i < 200 && searchStartPoint < currentTime; i++ ){
        let bitmex_price;
        let upbit_price;

        for (;bitmexIterator < bitmexData.length && searchStartPoint >= moment(bitmexData[bitmexIterator].timestamp); bitmexIterator++){
          if (searchStartPoint.diff(moment(bitmexData[bitmexIterator].timestamp)) === 0)
            bitmex_price = bitmexData[bitmexIterator].close;
        }

        for (;upbitIteratior < upbitData.length && searchStartPoint >= moment(upbitData[upbitIteratior].candle_date_time_kst); upbitIteratior++){
          if (searchStartPoint.diff(moment(upbitData[upbitIteratior].candle_date_time_kst)) === 0)
            upbit_price = upbitData[upbitIteratior].trade_price;
        }

        const fixed_gimp =
        bitmex_price && upbit_price
          ? getGimp(upbit_price, Number(FIXED_USDKRW), bitmex_price)
          : null;

        this.gimpsService.create({
          datetime: searchStartPoint.toDate(),
          upbit_price,
          bitmex_price,
          gimp: 0,
          fixed_gimp,
          usdkrw_rate: 0
        })
        searchStartPoint.add(1, 'm');
      }
    }
  }

  @Interval(6000)
  async test(): Promise<any>{
    try {
      if (this.isSync === false) {
        this.isSync = true
        // critical section start
        await this.syncData();
        // critical section end
        this.isSync=false
      }
    } catch (err){
      this.isSync=false
    }
  }

  @Interval(1000)
  gimpTrade(): any {
    if (process.env.NODE_ENV != 'production'){
      return;
    }

    const bitmexPriceUrl = BITMEX_API_URL + '/trade?' + qs.stringify({
      symbol: 'XBT',
      reverse: true,
      count: 1
    })

    const upbitPriceUrl = UPBIT_API_URL + '/ticker?' + qs.stringify({
      markets: 'KRW-BTC'
    })

    const rateUrl = FREEFORE_API_URL + '/live?' + qs.stringify({
      pairs: 'USDKRW'
    })

    const requests = [axios.get(bitmexPriceUrl), axios.get(upbitPriceUrl), axios.get(rateUrl), upbitAccountLookUp() ];

    Promise.all(requests)
      .then(async ([btcUsd, btcKrw, usdKrw, userAcountKrw]) => {
        const btcUsdPrice: number = btcUsd.data[0].price
        const btcKrwPrice: number = btcKrw.data[0].trade_price
        // const usdKrwRate = usdKrw.data.rates.USDKRW.rate.toFixed(1)
        // 고정김프
        const currentGimp = getGimp(btcKrwPrice, Number(FIXED_USDKRW), btcUsdPrice);
        const user: User = await this.usersService.findById(1);
        const tradeState: string = user.state
        // BUY
        if (tradeState === BUY && Number(user.buy_target_gimp) >= currentGimp) {
          const krwTradeAmount: number = user.krw_trade_amount;
          const currentAcountKrw = userAcountKrw.data.find(o => o.currency === "KRW").balance
          if (currentAcountKrw < krwTradeAmount * 1.001) {
            // TODO: Add log
            console.log('too high krwTradeAmount')
            return;
          }
          const btcTradeAmount: number = krwTradeAmount / btcKrwPrice;
          const usdTradeAmount: number = Math.round(btcTradeAmount * btcUsdPrice);

          const trade_currency = [
            upbitOrder({
              market: 'KRW-BTC',
              side: 'bid',
              price: krwTradeAmount,
              ord_type: 'price',
            }),
            bitmexOrder('POST', 'order', {
              symbol: 'XBTUSD',
              orderQty: -usdTradeAmount,
              ordType: 'Market',
            })
          ]

          Promise.all(trade_currency)
            .then(([upbitRes, bitmexRes])=>{
              const upbitAvgPrice = upbitRes.data.avg_price;
              const upbitVolume: number = upbitRes.data.executed_volume;
              const bitmexUsdTradeAmount = bitmexRes.data.cumQty;
              const upbitFee = upbitRes.data.paid_fee;
              const bitmexFee = bitmexUsdTradeAmount*0.75;
              
              const tradeLog = new TradeLog()
              tradeLog.krw_trade_amount= Math.round(upbitAvgPrice*upbitVolume),
              tradeLog.btc_trade_amount= Number(upbitVolume.toFixed(5)),
              tradeLog.usd_trade_amount= Math.round(bitmexUsdTradeAmount),
              tradeLog.krw_trade_fee = Math.round(upbitFee),
              tradeLog.usd_trade_fee = Number(bitmexFee.toFixed(3)),
              tradeLog.type = BUY,
              tradeLog.datetime = moment().toDate()
              
              this.tradeLogsService.addTradeLog(tradeLog)
              this.usersService.stateTransition(user, upbitVolume, SELL)
            })
            .catch((err)=>{
              throw new Error(err)
            })
        } else if (tradeState === SELL && Number(user.sell_target_gimp) <= currentGimp) {
          const btcTradeAmount: number = user.btc_trade_amount
   
          const usdTradeAmount: number = Math.round(btcTradeAmount * btcUsdPrice);

          const trade_currency = [
            upbitOrder({
              market: 'KRW-BTC',
              side: 'ask',
              volume: btcTradeAmount,
              ord_type: 'market',
            }),
            bitmexOrder('POST', 'order', {
              symbol: 'XBTUSD',
              orderQty: usdTradeAmount,
              ordType: 'Market',
            })
          ]

          Promise.all(trade_currency)
            .then(([upbitRes, bitmexRes])=>{
              const upbitAvgPrice = upbitRes.data.avg_price;
              const upbitVolume = upbitRes.data.executed_volume;
              const bitmexUsdTradeAmount = bitmexRes.data.cumQty;
              const upbitFee = upbitRes.data.paid_fee;
              const bitmexFee = bitmexUsdTradeAmount*0.75;

              const tradeLog = new TradeLog()
              tradeLog.krw_trade_amount = Math.round(upbitAvgPrice*upbitVolume),
              tradeLog.btc_trade_amount = Number(upbitVolume.toFixed(5)),
              tradeLog.usd_trade_amount = Math.round(bitmexUsdTradeAmount),
              tradeLog.krw_trade_fee = Math.round(upbitFee),
              tradeLog.usd_trade_fee = Number(bitmexFee.toFixed(3)),
              tradeLog.type = SELL,
              tradeLog.datetime = moment().toDate()
              
              this.tradeLogsService.addTradeLog(tradeLog)
              this.usersService.stateTransition(user, 0, BUY)
              
            })
            .catch((err)=>{
              throw new Error(err)
            })
        }
      })
    .catch(e => {
        throw new Error(e);
    });
  }
}
