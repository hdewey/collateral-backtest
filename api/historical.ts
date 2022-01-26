import { VercelRequest, VercelResponse } from "@vercel/node";

// types
import { fetchLatestBlock, PriceSet, tokenToUSD } from "../modules/utils";

// functions
import { twap, blocksToQuery } from '../modules/utils';

// query sushiswap
import sushiswap from "../modules/fetch/sushiFetch";
import uniswap   from "../modules/fetch/uniFetch";

// cache historical data on vercel for each asset
// eslint-disable-next-line import/no-anonymous-default-export
export default async (request: VercelRequest, response: VercelResponse) => {

  // financials = liquidation incentive and collateral factor (used for calculating tokenDown)
  // const { financials } = request.body as BacktestConfig;

  const { address } = request.query as { [key: string]: string };

  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Cache-Control", "max-age=2592000, s-maxage=2592000");

  response.setHeader('Access-Control-Allow-Credentials', 'true');
  response.setHeader('Access-Control-Allow-Methods', 'GET');

  const testConfig: BacktestConfig = {
    address: address,
    period : 68,
    segmentsBack: 6500,
    end : 14077409,
    financials: {
      collateralFactor: 0.75,
      liquidationIncentive: 0.15
    },
    provider: "sushiswap"
  }
  

  const priceData: PriceSet = await queryExchange(testConfig);
  const tokenDown: number   = await calcTokenDown(priceData, testConfig.financials);

  // send token down
  response.json(
    { tokenDown }
  );
}

export interface BacktestConfig {
  address     : string,
  period      : number, // normally 68 blocks is 15 mins
  segmentsBack: number, // should be divisible by 100 (amt of blocks to go back)
  end         : number // getLatestBlock() from web3
  
  financials : {
    liquidationIncentive: number,
    collateralFactor    : number
  }

  provider: string
}

// calculate token down given a set of prices
const calcTokenDown = async (priceSet: PriceSet, financials: {liquidationIncentive: number, collateralFactor: number}): Promise<number> => {

  const { prices } = priceSet

  const li = parseFloat(financials.liquidationIncentive.toFixed(4));

  // need a more adaptive system for calculating slippage :/
  const slippage = financials.collateralFactor / 8;

  let tokenDowns:number[] = [];

  try {

    for (let i = 0; i < prices.length - 1; i++) {

      for (let x = 0; x + i < prices.length - 1; x++) {

        // block to calculate change from beginning of liquidation period to successful liquidation
        let blockOriginal = prices[i];

        let block0 = prices[i + x];
        let block1 = prices[i + x + 1];

        let currentTWAP = twap(block0, block1);

        if (li > ((currentTWAP - block1) / currentTWAP) + slippage) {
          // liquidation successful
          
          // token down = (beginning of liquidation price - period of liquidation average price) / beginning of liquidation price
          let td = Math.abs((blockOriginal - currentTWAP) / blockOriginal);
          
          // push token down to array of all token downs
          tokenDowns.push(td);
          break;
        } else if ( x + i > prices.length) {
          // liquidation never feasible
          console.log('this is bad');
          break;
        } else {
          // debug
          // console.log(`block ${i} cannot be liquidated at period ${x}`)
        }
      }
    }
  } finally {
    // max array of token downs
    return Math.max(...tokenDowns);
  }
}

const queryExchange = async (exchangeParameters: BacktestConfig) => {

  const { address, provider } = exchangeParameters;

  const blocks:number[] = blocksToQuery(exchangeParameters);

  const exchangePrices = async () => {
    switch (provider) {
      case 'sushiswap':
        return await sushiswap(blocks, address);
      case 'uniswap':
        return await uniswap(blocks, address);
      default: 
        // should never happen
        return [] as number[];
    }
  }

  const pricesUSD = await tokenToUSD(blocks, await exchangePrices());
  
  return {
    block: {
      start: blocks[0], 
      end: blocks[blocks.length - 1] 
    },
    prices: pricesUSD
  } as PriceSet
}