/* eslint-disable no-console */
import { ref, watch } from '@vue/composition-api';
import type { BigNumber, Contract, ethers, Event, EventFilter, providers } from 'ethers';
import type { Result } from 'ethers/lib/utils';
// eslint-disable-next-line import/no-extraneous-dependencies
import type { Block, Log } from '@ethersproject/abstract-provider';
import type { RelayRequest } from '@opengsn/common/dist/EIP712/RelayRequest';
import { UsdcAddressInfo, useUsdcAddressStore } from './stores/UsdcAddress';
import { useUsdcNetworkStore } from './stores/UsdcNetwork';
import {
    Transaction as PlainTransaction,
    TransactionState,
    useUsdcTransactionsStore,
} from './stores/UsdcTransactions';
import { useConfig } from './composables/useConfig';
import { ENV_MAIN } from './lib/Constants';
import { USDC_TRANSFER_CONTRACT_ABI, USDC_CONTRACT_ABI } from './lib/usdc/ContractABIs';
import { getBestRelay, getRelayHub, POLYGON_BLOCKS_PER_MINUTE, RelayServerInfo } from './lib/usdc/OpenGSN';
import { getUsdcPrice } from './lib/usdc/Uniswap';

export interface PolygonClient {
    provider: providers.Provider;
    usdc: Contract;
    usdcTransfer: Contract;
    ethers: typeof ethers;
}

let isLaunched = false;

type Balances = Map<string, number>;
const balances: Balances = new Map(); // Balances in USDC-base units, excluding pending txs

let clientPromise: Promise<PolygonClient> | null = null;
let unwatchGetPolygonClientConfig: (() => void) | null = null;
export async function getPolygonClient(): Promise<PolygonClient> {
    if (clientPromise) return clientPromise;

    let resolver: (client: PolygonClient) => void;
    clientPromise = new Promise<PolygonClient>((resolve) => {
        resolver = resolve;
    });

    const { config } = useConfig();
    unwatchGetPolygonClientConfig = watch(() => [
        config.usdc.rpcEndoint,
        config.usdc.networkId,
        config.usdc.usdcContract,
        config.usdc.usdcTransferContract,
    ], () => {
        // Reset clientPromise when the usdc config changes.
        clientPromise = null;
        if (!unwatchGetPolygonClientConfig) return;
        unwatchGetPolygonClientConfig();
        unwatchGetPolygonClientConfig = null;
    }, { lazy: true });

    const ethers = await import(/* webpackChunkName: "ethers-js" */ 'ethers');
    const provider = new ethers.providers.StaticJsonRpcProvider(
        config.usdc.rpcEndoint,
        ethers.providers.getNetwork(config.usdc.networkId),
    );

    await provider.ready;
    console.log('Polygon connection established');
    useUsdcNetworkStore().state.consensus = 'established';

    const usdc = new ethers.Contract(config.usdc.usdcContract, USDC_CONTRACT_ABI, provider);
    const usdcTransfer = new ethers.Contract(config.usdc.usdcTransferContract, USDC_TRANSFER_CONTRACT_ABI, provider);

    resolver!({
        provider,
        usdc,
        usdcTransfer,
        ethers,
    });

    return clientPromise;
}

async function getBalance(address: string) {
    const client = await getPolygonClient();
    const balance = await client.usdc.balanceOf(address) as BigNumber;
    return balance.toNumber(); // With Javascript numbers we can represent up to 9,007,199,254 USDC, enough for now
}

async function updateBalances(addresses: string[] = [...balances.keys()]) {
    if (!addresses.length) return;
    const accounts = await Promise.all(addresses.map((address) => getBalance(address)));
    const newBalances: Balances = new Map(
        accounts.map((balance, i) => [addresses[i], balance]),
    );

    for (const [address, newBalance] of newBalances) {
        if (balances.get(address) === newBalance) {
            // Balance did not change since last check.
            // Remove from newBalances Map to not update the store.
            newBalances.delete(address);
        } else {
            // Update balances cache
            balances.set(address, newBalance);
        }
    }

    if (!newBalances.size) return;
    console.log('Got new USDC balances for', [...newBalances.keys()]);
    const { patchAddress } = useUsdcAddressStore();
    for (const [address, balance] of newBalances) {
        patchAddress(address, { balance });
    }
}

function forgetBalances(addresses: string[]) {
    for (const address of addresses) {
        balances.delete(address);
    }
}

const subscribedAddresses = new Set<string>();
const fetchedAddresses = new Set<string>();

let currentSubscriptionFilter: EventFilter | undefined;
function subscribe(addresses: string[]) {
    getPolygonClient().then((client) => {
        // Only subscribe to incoming logs
        const newFilterIncoming = client.usdc.filters.Transfer(null, [...subscribedAddresses]);
        client.usdc.on(newFilterIncoming, transactionListener);
        if (currentSubscriptionFilter) client.usdc.off(currentSubscriptionFilter, transactionListener);
        currentSubscriptionFilter = newFilterIncoming;
    });
    updateBalances(addresses);
    return true;
}

async function transactionListener(from: string, to: string, value: BigNumber, log: TransferEvent) {
    if (!balances.has(from) && !balances.has(to)) return;

    log.getBlock().then((block) => {
        const plain = logAndBlockToPlain(log, block);
        const { addTransactions } = useUsdcTransactionsStore();
        addTransactions([plain]);
    });

    const addresses: string[] = [];
    if (balances.has(from)) {
        addresses.push(from);
    }
    if (balances.has(to)) {
        addresses.push(to);
    }
    updateBalances(addresses);
}

export async function launchPolygon() {
    if (isLaunched) return;
    isLaunched = true;

    const client = await getPolygonClient();

    const { state: network$ } = useUsdcNetworkStore();
    const transactionsStore = useUsdcTransactionsStore();
    const { config } = useConfig();

    // Start block listener
    client.provider.on('block', (height: number) => {
        console.debug('Polygon is now at', height);
        network$.height = height;
    });

    // Subscribe to new addresses (for balance updates and transactions)
    // Also remove logged out addresses from fetched (so that they get fetched on next login)
    const addressStore = useUsdcAddressStore();
    watch(addressStore.addressInfo, () => {
        const newAddresses: string[] = [];
        const removedAddresses = new Set(subscribedAddresses);

        for (const address of Object.keys(addressStore.state.addressInfos)) {
            if (subscribedAddresses.has(address)) {
                removedAddresses.delete(address);
                continue;
            }

            subscribedAddresses.add(address);
            newAddresses.push(address);
        }

        if (removedAddresses.size) {
            for (const removedAddress of removedAddresses) {
                subscribedAddresses.delete(removedAddress);
                fetchedAddresses.delete(removedAddress);
            }
            // Let the network forget the balances of the removed addresses,
            // so that they are reported as new again at re-login.
            forgetBalances([...removedAddresses]);
        }

        if (!newAddresses.length) return;

        console.log('Subscribing USDC addresses', newAddresses);
        subscribe(newAddresses);
    });

    // Fetch transactions for active address
    const txFetchTrigger = ref(0);
    watch([addressStore.addressInfo, txFetchTrigger, () => config.usdc], ([addressInfo]) => {
        const address = (addressInfo as UsdcAddressInfo | null)?.address;
        if (!address || fetchedAddresses.has(address)) return;
        fetchedAddresses.add(address);

        console.log('Scheduling USDC transaction fetch for', address);

        const knownTxs = Object.values(transactionsStore.state.transactions)
            .filter((tx) => tx.sender === address || tx.recipient === address);
        const lastConfirmedHeight = knownTxs
            .filter((tx) => Boolean(tx.blockHeight))
            .reduce((maxHeight, tx) => Math.max(tx.blockHeight!, maxHeight), config.usdc.startHistoryScanHeight);

        network$.fetchingTxHistory++;

        updateBalances([address]);

        console.log('Fetching USDC transaction history for', address, knownTxs);
        // EventFilters only allow to query with an AND condition between arguments (topics). So while
        // we could specify an array of parameters to match for each topic (which are OR'd), we cannot
        // OR two AND pairs. That requires two separate requests.
        const filterIncoming = client.usdc.filters.Transfer(null, address);
        const filterOutgoing = client.usdc.filters.Transfer(address);
        Promise.all([
            client.usdc.queryFilter(filterIncoming, lastConfirmedHeight - 10),
            client.usdc.queryFilter(filterOutgoing, lastConfirmedHeight - 10),
            // TODO Check limitations of start block in the RPC server
        ])
            .then(([logsIn, logsOut]) => {
                // Filter known txs
                const knownHashes = knownTxs.map(
                    (tx) => tx.transactionHash,
                );

                console.log('Got', logsIn.length, 'incoming and', logsOut.length, 'outgoing logs');

                const newLogs = logsIn.concat(logsOut).filter((log, index, logs) => {
                    if (knownHashes.includes(log.transactionHash)) return false;
                    if (!log.args) return false;

                    // Transfer to the usdcTransferContract is the fee paid to OpenGSN
                    if (
                        log.args.to === config.usdc.usdcTransferContract
                        || (
                            config.environment !== ENV_MAIN
                            && log.args.to === '0x703EC732971cB23183582a6966bA70E164d89ab1' // v1 USDC transfer contract
                        )
                    ) {
                        // Find the main transfer log
                        const mainTransferLog = logs.find((otherLog, otherIndex) =>
                            otherLog.transactionHash === log.transactionHash
                            && otherIndex !== index);

                        if (mainTransferLog && mainTransferLog.args) {
                            // Write this log's `value` as the main transfer log's `fee`
                            mainTransferLog.args = addFeeToArgs(mainTransferLog.args, log.args.value);
                        }

                        // Then ignore this log
                        return false;
                    }

                    return true;
                }) as TransferEvent[];

                return Promise.all(newLogs.map(async (log) => ({
                    log,
                    block: await log.getBlock(),
                })));
            })
            .then((logsAndBlocks) => {
                transactionsStore.addTransactions(logsAndBlocks.map(
                    ({ log, block }) => logAndBlockToPlain(log, block),
                ));
            })
            .catch((error) => {
                console.log('error', error);
                fetchedAddresses.delete(address);
            })
            .then(() => network$.fetchingTxHistory--);
    });
}

function logAndBlockToPlain(log: TransferEvent | TransferLog, block?: Block): PlainTransaction {
    return {
        transactionHash: log.transactionHash,
        logIndex: log.logIndex,
        sender: log.args.from,
        recipient: log.args.to,
        value: log.args.value.toNumber(), // With Javascript numbers we can represent up to 9,007,199,254 USDC
        fee: log.args.fee?.toNumber(),
        state: block ? TransactionState.MINED : TransactionState.PENDING,
        blockHeight: block?.number,
        timestamp: block?.timestamp,
    };
}

async function calculateFee(
    method: 'transfer' | 'transferWithApproval' = 'transferWithApproval', // eslint-disable-line default-param-last
    forceRelay?: RelayServerInfo,
) {
    const client = await getPolygonClient();

    const dataSize = {
        transfer: undefined,
        transferWithApproval: 292,
    }[method];

    if (!dataSize) throw new Error(`No dataSize set yet for ${method} method!`);

    let relay = forceRelay;

    const [
        networkGasPrice,
        gasLimit,
        [acceptanceBudget],
        dataGasCost,
        usdcPrice,
    ] = await Promise.all([
        client.provider.getGasPrice().then((price) => price.mul(110).div(100)),
        client.usdcTransfer.requiredRelayGas() as Promise<BigNumber>,
        relay
            ? Promise.resolve([client.ethers.BigNumber.from(0)])
            : client.usdcTransfer.getGasAndDataLimits() as Promise<[BigNumber, BigNumber, BigNumber, BigNumber]>,
        relay
            ? Promise.resolve(client.ethers.BigNumber.from(0))
            : getRelayHub(client).calldataGasCost(dataSize) as Promise<BigNumber>,
        getUsdcPrice(client),
    ]);

    if (!relay) {
        const requiredMaxAcceptanceBudget = acceptanceBudget.add(dataGasCost);
        relay = await getBestRelay(client, requiredMaxAcceptanceBudget);
    }

    const { baseRelayFee, pctRelayFee, minGasPrice } = relay;

    const gasPrice = networkGasPrice.gte(minGasPrice) ? networkGasPrice : minGasPrice;
    // (gasPrice * gasLimit) * (1 + pctRelayFee) + baseRelayFee
    const chainTokenFee = gasPrice.mul(gasLimit).mul(pctRelayFee.add(100)).div(100).add(baseRelayFee);

    // main 10%, test 25% as it is more volatile
    const uniswapBufferPercentage = useConfig().config.environment === ENV_MAIN ? 110 : 125;
    const fee = chainTokenFee.div(usdcPrice).mul(uniswapBufferPercentage).div(100);

    return {
        chainTokenFee,
        fee,
        gasPrice,
        gasLimit,
        relay,
    };
}

export async function createTransactionRequest(recipient: string, amount: number, forceRelay?: RelayServerInfo) {
    const addressInfo = useUsdcAddressStore().addressInfo.value;
    if (!addressInfo) throw new Error('No active USDC address');
    const fromAddress = addressInfo.address;

    const { config } = useConfig();

    const client = await getPolygonClient();

    const method = 'transferWithApproval' as 'transfer' | 'transferWithApproval';

    const [
        usdcNonce,
        forwarderNonce,
        { chainTokenFee, fee, gasPrice, gasLimit, relay },
    ] = await Promise.all([
        client.usdc.getNonce(fromAddress) as Promise<BigNumber>,
        client.usdcTransfer.getNonce(fromAddress) as Promise<BigNumber>,
        calculateFee(method, forceRelay),
    ]);

    const data = await client.usdcTransfer.interface.encodeFunctionData(method, [
        /* address token */ config.usdc.usdcContract,
        /* uint256 amount */ amount,
        /* address target */ recipient,
        /* uint256 fee */ fee,
        /* uint256 chainTokenFee */ chainTokenFee,
        ...(method === 'transferWithApproval' ? [
            /* uint256 approval */ fee.add(amount),

            // Dummy values, replaced by real signature bytes in Keyguard
            /* bytes32 sigR */ '0x0000000000000000000000000000000000000000000000000000000000000000',
            /* bytes32 sigS */ '0x0000000000000000000000000000000000000000000000000000000000000000',
            /* uint8 sigV */ 0,
        ] : []),
    ]);

    const relayRequest: RelayRequest = {
        request: {
            from: fromAddress,
            to: config.usdc.usdcTransferContract,
            data,
            value: '0',
            nonce: forwarderNonce.toString(),
            gas: gasLimit.toString(),
            validUntil: (useUsdcNetworkStore().state.height + 2 * 60 * POLYGON_BLOCKS_PER_MINUTE).toString(), // 2 hours
        },
        relayData: {
            gasPrice: gasPrice.toString(),
            pctRelayFee: relay.pctRelayFee.toString(),
            baseRelayFee: relay.baseRelayFee.toString(),
            relayWorker: relay.relayWorkerAddress,
            paymaster: config.usdc.usdcTransferContract,
            paymasterData: '0x',
            clientId: Math.floor(Math.random() * 1e6).toString(),
            forwarder: config.usdc.usdcTransferContract,
        },
    };

    return {
        relayRequest,
        approval: {
            tokenNonce: usdcNonce.toNumber(),
        },
        relay: {
            url: relay.url,
        },
    };
}

export async function sendTransaction(relayRequest: RelayRequest, signature: string, relayUrl: string) {
    const { config } = useConfig();
    const client = await getPolygonClient();
    const [{ HttpClient, HttpWrapper }, relayNonce] = await Promise.all([
        import('@opengsn/common'),
        client.provider.getTransactionCount(relayRequest.relayData.relayWorker),
    ]);
    const httpClient = new HttpClient(new HttpWrapper(), console);
    const relayTx = await httpClient.relayTransaction(relayUrl, {
        relayRequest,
        metadata: {
            approvalData: '0x',
            relayHubAddress: config.usdc.relayHubContract,
            relayMaxNonce: relayNonce + 3,
            signature,
        },
    });

    // TODO: Audit and validate transaction like in
    // https://github.com/opengsn/gsn/blob/v2.2.5/packages/provider/src/RelayClient.ts#L270

    let txResponse = await client.provider.sendTransaction(relayTx)
        .catch((error) => {
            console.debug('Failed to also send relay transaction:', error);
        });

    if (!txResponse) {
        const tx = client.ethers.utils.parseTransaction(relayTx);
        txResponse = await client.provider.getTransaction(tx.hash!);
    }

    const receipt = await txResponse.wait(1);
    const logs = receipt.logs.map((log) => {
        try {
            const { args, name } = client.usdc.interface.parseLog(log);
            return {
                ...log,
                args,
                name,
            };
        } catch (error) {
            return null;
        }
    });

    let fee: BigNumber | undefined;

    const relevantLog = logs.find((log) => {
        if (!log) return false;
        if (log.name !== 'Transfer') return false;
        if (log.args.from !== relayRequest.request.from) return false;

        // Transfer to the usdcTransferContract is the fee paid to OpenGSN
        if (log.args.to === config.usdc.usdcTransferContract) {
            fee = log.args.value;
            return false;
        }

        if (fee) {
            log.args = addFeeToArgs(log.args, fee);
        }

        return true;
    }) as TransferLog;
    const block = await client.provider.getBlock(relevantLog.blockHash);
    return logAndBlockToPlain(relevantLog, block);
}

function addFeeToArgs(readonlyArgs: Result, fee: BigNumber): Result {
    // Clone args as writeable
    type Writeable<T> = { -readonly [P in keyof T]: T[P] };
    const args = [...readonlyArgs] as Writeable<Result>;
    [args.from, args.to, args.value] = args;

    // Add the fee
    args.push(fee);
    args.fee = args[3]; // eslint-disable-line prefer-destructuring

    return Object.freeze(args);
}

// @ts-expect-error debugging
window.gimmePolygonClient = async () => getPolygonClient();

interface TransferResult extends ReadonlyArray<any> {
    0: string;
    1: string;
    2: BigNumber;
    3?: BigNumber;
    from: string;
    to: string;
    value: BigNumber;
    fee?: BigNumber;
}

interface TransferLog extends Log {
    args: TransferResult;
    name: string;
}

interface TransferEvent extends Event {
    args: TransferResult;
}