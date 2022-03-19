import fetch, {Response} from 'node-fetch-commonjs'
import {Network} from './networks'
import {wrapPermCache} from './permanentCache'
import {AbiItem} from "web3-utils"

async function fetchAPI(network: Network, search: Record<string, string|number>) {
    const params = Object.entries(search).map(([k, v]) => `${k}=${v}`).join('&')
    for(;;) {
        await network.trottle()
        let response: Response
        try {
            response = await fetch(`${network.scanAPIURL}/api?${params}&apikey=${network.scanAPIKey}`)
        } catch(e) {
            continue
        }
        const result = await response.json() as Record<string, unknown>
        if (result.status === '1') return result.result
        if (result.status === '0' && result.message == 'No records found') return result.result
        if (result.status === '0' && result.message == 'No transactions found') return result.result
        if (result.result == 'Max rate limit reached') continue     // try till success
        console.error(`${network.name} Scan API error: ${result.message} ${result.result}`);
        console.error(`${network.scanAPIURL}/api?${params}&apikey=${network.scanAPIKey}`)
        return
    }
}

interface LogParams {
    tx?: {blockNumber: string, hash: string},
    address: string,
    address1?: string,
    address2?: string,
    event: string,
    topic0?: string | null,
    topic1?: string,
    topic2?: string,
    data?: number | string
}

interface Log {
    transactionHash: string, 
    data: string,
    topics: string[]
}

async function getLogs(network: Network, params: LogParams) {
    const search: Record<string, string> = {module: 'logs', action: 'getLogs'}
    if (params.tx) {
        search.fromBlock = params.tx.blockNumber
        search.toBlock = params.tx.blockNumber
    }
    if (params.address) search.address=params.address
    if (params.event) params.topic0 = network.web3.utils.sha3(params.event)
    if (params.topic0) search.topic0 = params.topic0
    if (params.address1) params.topic1 = '0x000000000000000000000000' + params.address1.substring(2)
    if (params.topic1) search.topic1 = params.topic1
    if (params.address2) params.topic2 = '0x000000000000000000000000' + params.address2.substring(2)
    if (params.topic2) search.topic2 = params.topic2
    let logs =  await fetchAPI(network, search) as Array<Log>
    if (params.tx) logs = logs.filter(l => l.transactionHash == params.tx?.hash)
    if (params.data) {
        if (typeof params.data == 'number') params.data = '0x' + params.data.toString(16).padStart(64, '0')
        return logs.filter(l => l.data == params.data)
    }
    return logs
}

interface Transaction {
    from: string,
    to: string,
    input?: string,
    isError? : string,
}

async function getAddrTransactions(network: Network, address: string, startblock = 0) {
    const txs =  await fetchAPI(network, {
        module: 'account',
        action: 'txlist',
        address,
        startblock,
        endblock: 'latest',
        sort: 'asc'
    }) as Transaction[]
    if (txs === undefined) return []
    return txs.filter(tx => tx.isError === undefined || tx.isError === '0')
}

interface PairData {
    address: string;
    collateral: string;
    collateralSymbol: string;
    asset: string;
    assetSymbol: string;
    oracle: string;
    //oracleData: string;
    borrowers: string[];
    notSolventBorrowers: string[];
    liquidateTxs: Transaction[];
}

// network.web3.utils.keccak256('liquidate(address[],uint256[],address,address,bool)').substring(0, 10);
const liquidateMethodId = '0x76ee101b'

async function getPairDataFromBentoV1Log(network: Network, log: Log): Promise<PairData> {
    const logParsed = await network.web3.eth.abi.decodeLog([{
            type: 'string',
            name: 'LogName',
            indexed: true
        }, {
            type: 'address',
            name: 'masterContract',
            indexed: true
        },{
            type: 'bytes',
            name: 'data'
        },{
            type: 'address',
            name: 'cloneAddress',
            indexed: true
        }],
        log.data,
        log.topics
    );
    const address = logParsed.cloneAddress

    const borrowLogs = await getLogs(network, {
        address,
        event: 'LogBorrow(address,address,uint256,uint256,uint256)'
    })
    const borrowersSet = new Set<string>(borrowLogs.map(b => '0x' + b.topics[1].slice(26)))
    const borrowers = [...borrowersSet]
    
    const pairData = await network.web3.eth.abi.decodeParameters(['address', 'address', 'address', 'bytes'], logParsed.data)
    const collateral = pairData[0] as string
    const collateralSymbol = await getTokenSymbol(network, collateral)
    const asset = pairData[1] as string
    const assetSymbol = await getTokenSymbol(network, asset)
    
    console.log(`Checking pair ${collateralSymbol} -> ${assetSymbol} (${borrowers.length} borrowers)`)    

    const txsAll = await getAddrTransactions(network, address)
    const liquidateTxs = txsAll.filter(t => t.input?.startsWith(liquidateMethodId))
    const notSolventBorrowers = await getNotSolventBorrowersBentoV1(network, address, borrowers)

    return {
        address,
        collateral,
        collateralSymbol,
        asset,
        assetSymbol,
        oracle: pairData[2],
        //oracleData: pairData[3],
        borrowers,
        notSolventBorrowers,
        liquidateTxs
    }
}

const kashiPairABI: AbiItem[] = [{
    inputs: [],
    name: "exchangeRate",
    outputs: [{internalType: 'uint256', name: '', type: 'uint256'}],
    stateMutability: "view",
    type: "function"
}, {
    inputs: [],
    name: "totalBorrow",
    outputs: [
        {internalType: 'uint128', name: 'elastic', type: 'uint128'},
        {internalType: 'uint128', name: 'base', type: 'uint128'}
    ],
    stateMutability: "view",
    type: "function"
}, {
    inputs: [{internalType: 'address', name: '', type: 'address'}],
    name: "userCollateralShare",
    outputs: [{internalType: 'uint256', name: '', type: 'uint256'}],
    stateMutability: "view",
    type: "function"
}, {
    inputs: [{internalType: 'address', name: '', type: 'address'}],
    name: "userBorrowPart",
    outputs: [{internalType: 'uint256', name: '', type: 'uint256'}],
    stateMutability: "view",
    type: "function"
}, {
    inputs: [],
    name: "updateExchangeRate",
    outputs: [
        {internalType: 'bool', name: 'updated', type: 'bool'},
        {internalType: 'uint256', name: 'rate', type: 'uint256'}
    ],
    stateMutability: "nonpayable",
    type: "function"
}, {
    inputs: [
        {internalType: 'address[]', name: 'users', type: 'address[]'},
        {internalType: 'uint256[]', name: 'maxBorrowParts', type: 'uint256[]'},
        {internalType: 'address', name: 'to', type: 'address'},
        {internalType: 'contract ISwapper', name: 'swapper', type: 'address'},
        {internalType: 'bool', name: 'open', type: 'bool'},
    ],
    name: "liquidate",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function"
}, {
    inputs: [],
    name: "accrueInfo",
    outputs: [
        {internalType: 'uint64', name: 'interestPerSecond', type: 'uint64'},
        {internalType: 'uint64', name: 'lastAccrued', type: 'uint64'},
        {internalType: 'uint128', name: 'feesEarnedFraction', type: 'uint128'},
    ],
    stateMutability: "view",
    type: "function",
}]

async function getNotSolventBorrowersBentoV1(network: Network, kashiPair: string, borrowers: string[]) {
    if (borrowers.length === 0) return []
    const kashiPaircontractInstance = new network.web3.eth.Contract(kashiPairABI, kashiPair)
    const liquidated = []
    for (let i = 0; i < borrowers.length; ++i) {
        try {
            await kashiPaircontractInstance.methods.liquidate(
                [borrowers[i]], 
                [0], 
                '0x0000000000000000000000000000000000000000',
                '0x0000000000000000000000000000000000000000',
                true
            ).call()
        } catch(e) {
            continue
        }
        liquidated.push(borrowers[i])
        console.log("Liquidation: ", kashiPair, borrowers[i]);        
    }
    return liquidated
}

async function _getTokenSymbol(network: Network, token: string): Promise<string> {
    const abi: AbiItem[] = [{
        constant: true,
        inputs: [],
        name: "symbol",
        outputs: [{name: '', type: 'string'}],
        payable: false,
        stateMutability: "view",
        type: "function",
    }]
    const contractInstance = new network.web3.eth.Contract(abi, token)
    const result = await contractInstance.methods.symbol().call() as string
    return result
}

const getTokenSymbol = wrapPermCache(_getTokenSymbol, (_n: Network, t: string) => t)

export async function getAllKashiPairsBentoV1(network: Network): Promise<PairData[]> {
    const logs = await getLogs(network, {
        address: network.bentoBoxV1Address,
        event: 'LogDeploy(address,bytes,address)',
        address1: network.kashPairMasterAddress
    })

    const pairs = await Promise.all(logs.map(l => getPairDataFromBentoV1Log(network, l)))
    let totalForLiquidation = 0
    let totalBorrowers = 0
    let totalLiquidates = 0
    const liquidators = new Map<string, number>()
    pairs.forEach(p => {
        totalForLiquidation += p.notSolventBorrowers.length
        totalBorrowers += p.borrowers.length
        totalLiquidates += p.liquidateTxs.length
        p.liquidateTxs.forEach(t => {
            const prev = liquidators.get(t.from)
            if (prev === undefined) liquidators.set(t.from, 1)
            else liquidators.set(t.from, prev+1)
        })
    })
    console.log(`Total number of pairs: ${pairs.length}`)   
    console.log(`Total number of borrowers: ${totalBorrowers}`)   
    console.log(`Total number of insolvent borrowers: ${totalForLiquidation}`)   
    console.log(`Total number of liquidations: ${totalLiquidates}`)
    console.log('Liquidators:');
    liquidators.forEach((num, from) => console.log(`    ${from} - ${num}`))    

    return pairs
}
