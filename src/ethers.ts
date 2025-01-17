/* eslint-disable no-console */
import { ref, watch } from '@vue/composition-api';
import type { BigNumber, Contract, ethers, Event, EventFilter, providers } from 'ethers';
import type { Result } from 'ethers/lib/utils';
// eslint-disable-next-line import/no-extraneous-dependencies
import type { Block, Log, TransactionReceipt } from '@ethersproject/abstract-provider';
import type { RelayRequest } from '@opengsn/common/dist/EIP712/RelayRequest';
import { UsdcAddressInfo, useUsdcAddressStore } from './stores/UsdcAddress';
import { useUsdcNetworkStore } from './stores/UsdcNetwork';
import {
    HtlcEvent,
    Transaction,
    TransactionState,
    useUsdcTransactionsStore,
    UniswapEvent,
} from './stores/UsdcTransactions';
import { useConfig } from './composables/useConfig';
import { ENV_MAIN } from './lib/Constants';
import {
    USDC_TRANSFER_CONTRACT_ABI,
    USDC_CONTRACT_ABI,
    USDC_HTLC_CONTRACT_ABI,
    NATIVE_USDC_CONTRACT_ABI,
    NATIVE_USDC_TRANSFER_CONTRACT_ABI,
    SWAP_CONTRACT_ABI,
    NATIVE_USDC_HTLC_CONTRACT_ABI,
} from './lib/usdc/ContractABIs';
import {
    getBestRelay,
    getRelayAddr,
    getRelayHub,
    POLYGON_BLOCKS_PER_MINUTE,
    RelayServerInfo,
} from './lib/usdc/OpenGSN';
import { getPoolAddress, getUsdcPrice } from './lib/usdc/Uniswap';
import { replaceKey } from './lib/KeyReplacer';

export async function loadEthersLibrary() {
    return import(/* webpackChunkName: "ethers-js" */ 'ethers');
}

export interface PolygonClient {
    provider: providers.Provider;
    /** @deprecated */
    usdc: Contract;
    /** @deprecated */
    usdcTransfer: Contract;
    nativeUsdc: Contract;
    nativeUsdcTransfer: Contract;
    ethers: typeof ethers;
}

function consensusEstablishedHandler(height: number) {
    useUsdcNetworkStore().state.outdatedHeight = height;
    console.log('Polygon connection established');
    useUsdcNetworkStore().state.consensus = 'established';
}

let isLaunched = false;

type Balances = Map<string, number>;
/**
 * Balances in bridged USDC-base units, excluding pending txs.
 */
const balances: Balances = new Map();
/**
 * Balances in native USDC-base units, excluding pending txs.
 */
const nativeBalances: Balances = new Map();

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
        config.usdc.rpcEndpoint,
        config.usdc.networkId,
        config.usdc.usdcContract,
        config.usdc.transferContract,
        config.usdc.htlcContract,
        config.usdc.nativeUsdcContract,
        config.usdc.nativeTransferContract,
        config.usdc.nativeHtlcContract,
    ], () => {
        // Reset clientPromise when the usdc config changes.
        clientPromise = null;
        if (!unwatchGetPolygonClientConfig) return;
        unwatchGetPolygonClientConfig();
        unwatchGetPolygonClientConfig = null;
    }, { lazy: true });

    let provider: providers.BaseProvider;
    const [ethers, rpcEndpoint] = await Promise.all([
        loadEthersLibrary(),
        replaceKey(config.usdc.rpcEndpoint),
    ]);
    if (rpcEndpoint.substring(0, 4) === 'http') {
        provider = new ethers.providers.StaticJsonRpcProvider(
            rpcEndpoint,
            ethers.providers.getNetwork(config.usdc.networkId),
        );
    } else if (rpcEndpoint.substring(0, 2) === 'ws') {
        // No need to optimize this import as it's the ethers-js chunk which is already loaded via loadEthersLibrary.
        const SturdyWebsocket = (await import(/* webpackChunkName: "ethers-js" */ 'sturdy-websocket')).default;
        const socket = new SturdyWebsocket(rpcEndpoint, {
            debug: true,
        });
        socket.addEventListener('down', () => {
            console.log('Polygon connection lost');
            useUsdcNetworkStore().state.consensus = 'connecting';
        });
        socket.addEventListener('reopen', async () => {
            useUsdcNetworkStore().state.consensus = 'syncing';
            const client = await getPolygonClient();
            client.provider.once('block', consensusEstablishedHandler);
        });
        provider = new ethers.providers.WebSocketProvider(
            socket,
            ethers.providers.getNetwork(config.usdc.networkId),
        );
    } else {
        throw new Error('Invalid RPC endpoint URL');
    }

    await provider.ready;

    // Wait for a block event to make sure we are really connected
    await new Promise<void>((resolve) => {
        provider.once('block', (height: number) => {
            consensusEstablishedHandler(height);
            resolve();
        });
    });

    const usdc = new ethers.Contract(config.usdc.usdcContract, USDC_CONTRACT_ABI, provider);
    const usdcTransfer = new ethers.Contract(config.usdc.transferContract, USDC_TRANSFER_CONTRACT_ABI, provider);

    const nativeUsdc = new ethers.Contract(config.usdc.nativeUsdcContract, NATIVE_USDC_CONTRACT_ABI, provider);
    const nativeUsdcTransfer = new ethers.Contract(
        config.usdc.nativeTransferContract, NATIVE_USDC_TRANSFER_CONTRACT_ABI, provider);

    resolver!({
        provider,
        usdc,
        usdcTransfer,
        nativeUsdc,
        nativeUsdcTransfer,
        ethers,
    });

    return clientPromise;
}

async function getBalance(address: string) {
    const client = await getPolygonClient();
    const balance = await client.usdc.balanceOf(address) as BigNumber;
    return balance.toNumber(); // With Javascript numbers we can represent up to 9,007,199,254 USDC, enough for now
}

async function getNativeBalance(address: string) {
    const client = await getPolygonClient();
    const balance = await client.nativeUsdc.balanceOf(address) as BigNumber;
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
    if (newBalances.size) {
        console.debug('Got new bridged USDC balances for', [...newBalances.keys()], [...newBalances.values()]);
    }
    const { patchAddress } = useUsdcAddressStore();
    for (const [address, balance] of newBalances) {
        patchAddress(address, { balance });
    }
}

async function updateNativeBalances(addresses: string[] = [...balances.keys()]) {
    if (!addresses.length) return;
    const nativeAccounts = await Promise.all(addresses.map((address) => getNativeBalance(address)));
    const newNativeBalances: Balances = new Map(
        nativeAccounts.map((balance, i) => [addresses[i], balance]),
    );
    for (const [address, newBalance] of newNativeBalances) {
        if (nativeBalances.get(address) === newBalance) {
            // Balance did not change since last check.
            // Remove from newBalances Map to not update the store.
            newNativeBalances.delete(address);
        } else {
            // Update balances cache
            nativeBalances.set(address, newBalance);
        }
    }

    if (!newNativeBalances.size) return;
    if (newNativeBalances.size) {
        console.debug(
            'Got new native USDC balances for', [...newNativeBalances.keys()], [...newNativeBalances.values()],
        );
    }
    const { patchAddress } = useUsdcAddressStore();
    for (const [address, nativeBalance] of newNativeBalances) {
        patchAddress(address, { nativeBalance });
    }
}

function forgetBalances(addresses: string[]) {
    for (const address of addresses) {
        balances.delete(address);
        nativeBalances.delete(address);
    }
}

const subscribedAddresses = new Set<string>();
const fetchedAddresses = new Set<string>();
const fetchedNativeAddresses = new Set<string>();

let currentSubscriptionFilter: EventFilter | undefined;
let currentNativeSubscriptionFilter: EventFilter | undefined;
function subscribe(addresses: string[]) {
    getPolygonClient().then((client) => {
        // Only subscribe to incoming logs
        const newFilterIncoming = client.usdc.filters.Transfer(null, [...subscribedAddresses]);
        client.usdc.on(newFilterIncoming, transactionListener);
        if (currentSubscriptionFilter) {
            client.usdc.off(currentSubscriptionFilter, transactionListener);
        }
        currentSubscriptionFilter = newFilterIncoming;

        const newNativeFilterIncoming = client.nativeUsdc.filters.Transfer(null, [...subscribedAddresses]);
        client.nativeUsdc.on(newNativeFilterIncoming, transactionListener);
        if (currentNativeSubscriptionFilter) {
            client.nativeUsdc.off(currentNativeSubscriptionFilter, transactionListener);
        }
        currentNativeSubscriptionFilter = newNativeFilterIncoming;
    });
    updateBalances(addresses);
    updateNativeBalances(addresses);
    return true;
}

// Is only called for incoming transfers
async function transactionListener(from: string, to: string, value: BigNumber, log: TransferEvent) {
    if (!balances.has(from) && !balances.has(to)) return;
    if (value.isZero()) return; // Ignore address poisoning scam transactions

    const { state: usdcTransactions$, addTransactions } = useUsdcTransactionsStore();

    // Ignore transactions that we already know about
    if (usdcTransactions$.transactions[log.transactionHash]) return;

    const { config } = useConfig();

    if (log.address === config.usdc.nativeUsdcContract && log.args.from === config.usdc.swapPoolContract) {
        // Ignore the native USDC events for Uniswap swaps from bridged to native USDC
        return;
    }

    const [block, receipt] = await Promise.all([
        log.getBlock(),
        // Handle HTLC redeem/refund events by watchtower
        from === config.usdc.htlcContract || from === config.usdc.nativeHtlcContract
            ? log.getTransactionReceipt()
            : Promise.resolve(null),
    ]);

    let tx: Transaction;
    if (receipt) {
        tx = await receiptToTransaction(log.address, receipt, undefined, block);
    } else {
        tx = logAndBlockToPlain(log, block);
    }

    addTransactions([tx]);

    const addresses: string[] = [];
    if (balances.has(from)) {
        addresses.push(from);
    }
    if (balances.has(to)) {
        addresses.push(to);
    }

    if (log.address === config.usdc.nativeUsdcContract) {
        updateNativeBalances(addresses);
    } else {
        updateBalances(addresses);
    }
}

export async function launchPolygon() {
    if (isLaunched) return;
    isLaunched = true;

    const { state: network$ } = useUsdcNetworkStore();
    const transactionsStore = useUsdcTransactionsStore();
    const { config } = useConfig();

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
                fetchedNativeAddresses.delete(removedAddress);
            }
            // Let the network forget the balances of the removed addresses,
            // so that they are reported as new again at re-login.
            forgetBalances([...removedAddresses]);
        }

        if (!newAddresses.length) return;

        console.debug('Subscribing USDC addresses', newAddresses);
        subscribe(newAddresses);
    });

    // Fetch transactions for active address
    const txFetchTrigger = ref(0);
    watch([addressStore.addressInfo, txFetchTrigger, () => config.usdc], async ([addressInfo, trigger]) => {
        const address = (addressInfo as UsdcAddressInfo | null)?.address;
        if (!address || fetchedAddresses.has(address)) return;
        fetchedAddresses.add(address);

        console.debug('Scheduling USDC transaction fetch for', address);

        const knownTxs = Object.values(transactionsStore.state.transactions)
            .filter((tx) => (!tx.token || tx.token === config.usdc.usdcContract)
                && (tx.sender === address || tx.recipient === address));
        const lastConfirmedHeight = knownTxs
            .filter((tx) => Boolean(tx.blockHeight))
            .reduce((maxHeight, tx) => Math.max(tx.blockHeight!, maxHeight), 0);
        const earliestHeightToCheck = Math.max(config.usdc.earliestHistoryScanHeight, lastConfirmedHeight - 1000);

        network$.fetchingTxHistory++;

        if ((trigger as number) > 0) updateBalances([address]);

        const client = await getPolygonClient();
        const poolAddress = await getPoolAddress(client.usdcTransfer, config.usdc.usdcContract);

        console.debug('Fetching USDC transaction history for', address, knownTxs);

        // EventFilters only allow to query with an AND condition between arguments (topics). So while
        // we could specify an array of parameters to match for each topic (which are OR'd), we cannot
        // OR two AND pairs. That requires two separate requests.
        const filterIncoming = client.usdc.filters.Transfer(null, address);
        const filterOutgoing = client.usdc.filters.Transfer(address);

        const STEP_BLOCKS = config.usdc.rpcMaxBlockRange;

        const MAX_ALLOWANCE = client.ethers
            .BigNumber.from('0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff');

        // The minimum allowance that should remain so we can be certain the max allowance was ever given.
        // If the current allowance is below this number, we ignore allowance counting for the history sync.
        const MIN_ALLOWANCE = client.ethers
            .BigNumber.from('0x1000000000000000000000000000000000000000000000000000000000000000');

        Promise.all([
            client.usdc.balanceOf(address) as Promise<BigNumber>,
            client.usdc.nonces(address).then((nonce: BigNumber) => nonce.toNumber()) as Promise<number>,
            client.usdc.allowance(address, config.usdc.transferContract)
                .then((allowance: BigNumber) => {
                    if (allowance.lt(MIN_ALLOWANCE)) return client.ethers.BigNumber.from(0);
                    return MAX_ALLOWANCE.sub(allowance);
                }) as Promise<BigNumber>,
            client.usdc.allowance(address, config.usdc.htlcContract)
                .then((allowance: BigNumber) => {
                    if (allowance.lt(MIN_ALLOWANCE)) return client.ethers.BigNumber.from(0);
                    return MAX_ALLOWANCE.sub(allowance);
                }) as Promise<BigNumber>,
        ]).then(async ([balance, usdcNonce, transferAllowanceUsed, htlcAllowanceUsed]) => {
            let blockHeight = await getPolygonBlockNumber();

            // To filter known txs
            const knownHashes = knownTxs.map(
                (tx) => tx.transactionHash,
            );

            const htlcEventsByTransactionHash = new Map<string, Promise<HtlcEvent | undefined>>();
            const uniswapEventsByTransactionHash = new Map<string, Promise<UniswapEvent | undefined>>();

            /* eslint-disable max-len */
            while (blockHeight > earliestHeightToCheck && (
                balance.gt(0)
                || usdcNonce > 0
                || transferAllowanceUsed.gt(0)
                || htlcAllowanceUsed.gt(0)
            )) {
                const startHeight = Math.max(blockHeight - STEP_BLOCKS, earliestHeightToCheck);
                const endHeight = blockHeight;
                blockHeight = startHeight;

                console.debug('USDC Sync start', {
                    balance: balance.toNumber() / 1e6,
                    usdcNonce,
                    transferAllowance: transferAllowanceUsed.toNumber() / 1e6,
                    htlcAllowance: htlcAllowanceUsed.toNumber() / 1e6,
                });

                console.debug(`Querying logs from ${startHeight} to ${endHeight} = ${endHeight - startHeight}`);

                let [logsIn, logsOut/* , metaTxs */] = await Promise.all([ // eslint-disable-line no-await-in-loop
                    client.usdc.queryFilter(filterIncoming, startHeight, endHeight),
                    client.usdc.queryFilter(filterOutgoing, startHeight, endHeight),
                ]);

                // Ignore address poisoning transactions
                logsIn = logsIn.filter((log) => !!log.args && !(log.args.value as BigNumber).isZero());
                logsOut = logsOut.filter((log) => !!log.args && !(log.args.value as BigNumber).isZero());

                console.debug(`Got ${logsIn.length} incoming logs, ${logsOut.length} outgoing logs` /* , and ${metaTxs.length} meta tx logs` */);

                // TODO: When switching to use max-approval, only reduce nonce once the allowances are 0
                const outgoingTxs = new Set(logsOut.map((ev) => ev.transactionHash));
                console.debug(`Found ${outgoingTxs.size} outgoing txs`);
                usdcNonce -= outgoingTxs.size;

                const txsUsingHtlcAllowance = new Set(logsOut
                    .filter((ev) => ev.args?.to === config.usdc.htlcContract) // Only HTLC fundings are relevant
                    .map((ev) => ev.transactionHash));

                const allTransferLogs = logsIn.concat(logsOut);

                // eslint-disable-next-line no-loop-func
                const newLogs = allTransferLogs.filter((log) => {
                    if (!log.args) return false;

                    // TODO: When switching to use max-approval, remove usdcNonce <= 0 check, so allowances get reduced first
                    if (log.args.from === address && usdcNonce <= 0) {
                        balance = balance.add(log.args.value);

                        if (txsUsingHtlcAllowance.has(log.transactionHash)) {
                            htlcAllowanceUsed = htlcAllowanceUsed.sub(log.args.value);
                        } else {
                            transferAllowanceUsed = transferAllowanceUsed.sub(log.args.value);
                        }
                    }
                    if (log.args.to === address) {
                        balance = balance.sub(log.args.value);
                    }

                    if (knownHashes.includes(log.transactionHash)) return false;

                    // Transfers to the Uniswap pool are the fees paid to OpenGSN
                    if (
                        log.args.to === poolAddress
                        || (
                            // Before v3, transfers to the transferContract were the fees paid to OpenGSN
                            config.environment !== ENV_MAIN
                            && (
                                log.args.to === '0x443EAAd5EeAacCdC3887477c188CF2875B3dcf7c' // v2 USDC transfer contract
                                || log.args.to === '0x703EC732971cB23183582a6966bA70E164d89ab1' // v1 USDC transfer contract
                            )
                        )
                    ) {
                        // Find the main transfer log
                        const mainTransferLog = allTransferLogs.find((otherLog) =>
                            otherLog.transactionHash === log.transactionHash
                            && otherLog.logIndex !== log.logIndex);

                        if (mainTransferLog && mainTransferLog.args) {
                            // Write this log's `value` as the main transfer log's `fee`
                            mainTransferLog.args = addFeeToArgs(mainTransferLog.args, log.args.value);
                        } else if (!mainTransferLog) {
                            // If no main transfer log was found, it means this transaction failed
                            // and only the fee was paid.
                            (log as TransferEvent).failed = true;
                            return true;
                        }

                        // Then ignore this log
                        return false;
                    }

                    if (
                        // Before v3, transfers to the HTLC contract were the fees paid to OpenGSN
                        config.environment !== ENV_MAIN
                        && log.args.to === '0x573aA448cC6e28AF0EeC7E93037B5A592a83d936' // v1 USDC HTLC contract
                    ) {
                        // Determine if this transfer is the fee, by looking for another transfer in this
                        // transaction with a higher `logIndex`, which means that one is the main transfer and this
                        // one is the fee.
                        const mainTransferLog = allTransferLogs.find((otherLog) =>
                            otherLog.transactionHash === log.transactionHash
                            && otherLog.logIndex > log.logIndex);

                        if (mainTransferLog && mainTransferLog.args) {
                            // Write this log's `value` as the main transfer log's `fee`
                            mainTransferLog.args = addFeeToArgs(mainTransferLog.args, log.args.value);
                        }

                        // Then ignore this log
                        return false;
                    }

                    if (log.args.to === config.usdc.htlcContract) {
                        // Get Open event log
                        const htlcEventPromise = log.getTransactionReceipt().then(async (receipt) => {
                            const htlcContract = await getHtlcContract();

                            for (const innerLog of receipt.logs) {
                                if (innerLog.address !== config.usdc.htlcContract) continue;
                                try {
                                    const { args, name } = htlcContract.interface.parseLog(innerLog);
                                    if (name === 'Open') {
                                        return <HtlcEvent> {
                                            name,
                                            id: args.id,
                                            token: args.token,
                                            amount: args.amount.toNumber(),
                                            recipient: args.recipient,
                                            hash: args.hash,
                                            timeout: args.timeout.toNumber(),
                                        };
                                    }
                                } catch (error) { /* ignore */ }
                            }
                            return undefined;
                        });

                        htlcEventsByTransactionHash.set(log.transactionHash, htlcEventPromise);
                    }

                    if (log.args.from === config.usdc.htlcContract) {
                        // Get Redeem or Refund event log
                        const htlcEventPromise = log.getTransactionReceipt().then(async (receipt) => {
                            const htlcContract = await getHtlcContract();

                            for (const innerLog of receipt.logs) {
                                if (innerLog.address !== config.usdc.htlcContract) continue;
                                try {
                                    const { args, name } = htlcContract.interface.parseLog(innerLog);
                                    if (name === 'Redeem') {
                                        return <HtlcEvent> {
                                            name,
                                            id: args.id,
                                            secret: args.secret,
                                        };
                                    }
                                    if (name === 'Refund') {
                                        return <HtlcEvent> {
                                            name,
                                            id: args.id,
                                        };
                                    }
                                } catch (error) { /* ignore */ }
                            }
                            return undefined;
                        });

                        htlcEventsByTransactionHash.set(log.transactionHash, htlcEventPromise);
                    }

                    if (log.args.to === config.usdc.swapPoolContract) {
                        // Get native USDC transfer log from pool to user
                        const uniswapEventPromise = log.getTransactionReceipt().then(async (receipt) => {
                            for (const innerLog of receipt.logs) {
                                if (innerLog.address !== config.usdc.nativeUsdcContract) continue;
                                try {
                                    const { args, name } = client.nativeUsdc.interface.parseLog(innerLog);
                                    if (name === 'Transfer') {
                                        const event: UniswapEvent = {
                                            name: 'Swap',
                                            amountIn: log.args!.value.toNumber(),
                                            amountOut: args.value.toNumber(),
                                        };
                                        return event;
                                    }
                                } catch (error) { /* ignore */ }
                            }
                            return undefined;
                        });

                        uniswapEventsByTransactionHash.set(log.transactionHash, uniswapEventPromise);
                    }

                    return true;
                }) as TransferEvent[];

                const logsAndBlocks = newLogs.map((log) => ({
                    log,
                    block: log.getBlock(),
                    event: htlcEventsByTransactionHash.get(log.transactionHash)
                        || uniswapEventsByTransactionHash.get(log.transactionHash),
                }));

                // TODO: Allow individual fetches to fail, but still add the other transactions?
                await Promise.all(logsAndBlocks.map( // eslint-disable-line no-await-in-loop
                    async ({ log, block, event }) => logAndBlockToPlain(
                        log,
                        await block,
                        await event,
                    ),
                )).then((transactions) => {
                    transactionsStore.addTransactions(transactions);
                });
            } // End while loop
            /* eslint-enable max-len */

            console.debug('USDC Sync end', {
                balance: balance.toNumber() / 1e6,
                usdcNonce,
                transferAllowance: transferAllowanceUsed.toNumber() / 1e6,
                htlcAllowance: htlcAllowanceUsed.toNumber() / 1e6,
            });
        })
            .catch((error) => {
                console.error(error);
                fetchedAddresses.delete(address);
            })
            .then(() => network$.fetchingTxHistory--);
    });

    const nativeTxFetchTrigger = ref(0);
    watch([addressStore.addressInfo, nativeTxFetchTrigger, () => config.usdc], async ([addressInfo, trigger]) => {
        const address = (addressInfo as UsdcAddressInfo | null)?.address;
        if (!address || fetchedNativeAddresses.has(address)) return;
        fetchedNativeAddresses.add(address);

        console.debug('Scheduling native USDC transaction fetch for', address);

        const knownTxs = Object.values(transactionsStore.state.transactions)
            .filter((tx) => tx.token === config.usdc.nativeUsdcContract
                && (tx.sender === address || tx.recipient === address));
        const lastConfirmedHeight = knownTxs
            .filter((tx) => Boolean(tx.blockHeight))
            .reduce((maxHeight, tx) => Math.max(tx.blockHeight!, maxHeight), 0);
        const earliestHeightToCheck = Math.max(config.usdc.earliestNativeHistoryScanHeight, lastConfirmedHeight - 1000);

        network$.fetchingTxHistory++;

        if ((trigger as number) > 0) updateNativeBalances([address]);

        const client = await getPolygonClient();
        const poolAddress = await getPoolAddress(client.nativeUsdcTransfer, config.usdc.nativeUsdcContract);

        console.debug('Fetching native USDC transaction history for', address, knownTxs);

        // EventFilters only allow to query with an AND condition between arguments (topics). So while
        // we could specify an array of parameters to match for each topic (which are OR'd), we cannot
        // OR two AND pairs. That requires two separate requests.
        const filterIncoming = client.nativeUsdc.filters.Transfer(null, address);
        const filterOutgoing = client.nativeUsdc.filters.Transfer(address);
        // const filterMetaTx = client.usdc.filters.MetaTransactionExecuted();

        const STEP_BLOCKS = config.usdc.rpcMaxBlockRange;

        const MAX_ALLOWANCE = client.ethers
            .BigNumber.from('0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff');

        // The minimum allowance that should remain so we can be certain the max allowance was ever given.
        // If the current allowance is below this number, we ignore allowance counting for the history sync.
        const MIN_ALLOWANCE = client.ethers
            .BigNumber.from('0x1000000000000000000000000000000000000000000000000000000000000000');

        Promise.all([
            client.nativeUsdc.balanceOf(address) as Promise<BigNumber>,
            client.nativeUsdc.nonces(address).then((nonce: BigNumber) => nonce.toNumber()) as Promise<number>,
            client.nativeUsdc.allowance(address, config.usdc.nativeTransferContract)
                .then((allowance: BigNumber) => {
                    if (allowance.lt(MIN_ALLOWANCE)) return client.ethers.BigNumber.from(0);
                    return MAX_ALLOWANCE.sub(allowance);
                }) as Promise<BigNumber>,
            client.nativeUsdc.allowance(address, config.usdc.nativeHtlcContract)
                .then((allowance: BigNumber) => {
                    if (allowance.lt(MIN_ALLOWANCE)) return client.ethers.BigNumber.from(0);
                    return MAX_ALLOWANCE.sub(allowance);
                }) as Promise<BigNumber>,
        ]).then(async ([nativeBalance, nativeUsdcNonce, transferAllowanceUsed, htlcAllowanceUsed]) => {
            let blockHeight = await getPolygonBlockNumber();

            // To filter known txs
            const knownHashes = knownTxs.map(
                (tx) => tx.transactionHash,
            );

            const nativeHtlcEventsByTransactionHash = new Map<string, Promise<HtlcEvent | undefined>>();

            /* eslint-disable max-len */
            while (blockHeight > earliestHeightToCheck && (
                nativeBalance.gt(0)
                || nativeUsdcNonce > 0
                || transferAllowanceUsed.gt(0)
                || htlcAllowanceUsed.gt(0)
            )) {
                const startHeight = Math.max(blockHeight - STEP_BLOCKS, earliestHeightToCheck);
                const endHeight = blockHeight;
                blockHeight = startHeight;

                console.debug('Native USDC Sync start', {
                    balance: nativeBalance.toNumber() / 1e6,
                    usdcNonce: nativeUsdcNonce,
                    transferAllowance: transferAllowanceUsed.toNumber() / 1e6,
                    htlcAllowance: htlcAllowanceUsed.toNumber() / 1e6,
                });

                console.debug(`Querying native logs from ${startHeight} to ${endHeight} = ${endHeight - startHeight}`);

                let [logsIn, logsOut/* , metaTxs */] = await Promise.all([ // eslint-disable-line no-await-in-loop
                    client.nativeUsdc.queryFilter(filterIncoming, startHeight, endHeight),
                    client.nativeUsdc.queryFilter(filterOutgoing, startHeight, endHeight),
                ]);

                // Ignore address poisoning transactions
                logsIn = logsIn.filter((log) => !!log.args && !(log.args.value as BigNumber).isZero());
                logsOut = logsOut.filter((log) => !!log.args && !(log.args.value as BigNumber).isZero());

                console.debug(`Got ${logsIn.length} incoming native logs, ${logsOut.length} outgoing native logs` /* , and ${metaTxs.length} meta tx logs` */);

                // TODO: When switching to use max-approval, only reduce nonce once the allowances are 0
                const outgoingTxs = new Set(logsOut.map((ev) => ev.transactionHash));
                console.debug(`Found ${outgoingTxs.size} outgoing native txs`);
                nativeUsdcNonce -= outgoingTxs.size;

                const txsUsingHtlcAllowance = new Set(logsOut
                    .filter((ev) => ev.args?.to === config.usdc.nativeHtlcContract) // Only HTLC fundings are relevant
                    .map((ev) => ev.transactionHash));

                const allTransferLogs = logsIn.concat(logsOut);

                // eslint-disable-next-line no-loop-func
                const newLogs = allTransferLogs.filter((log) => {
                    if (!log.args) return false;

                    // TODO: When switching to use max-approval, remove usdcNonce <= 0 check, so allowances get reduced first
                    if (log.args.from === address && nativeUsdcNonce <= 0) {
                        nativeBalance = nativeBalance.add(log.args.value);

                        if (txsUsingHtlcAllowance.has(log.transactionHash)) {
                            htlcAllowanceUsed = htlcAllowanceUsed.sub(log.args.value);
                        } else {
                            transferAllowanceUsed = transferAllowanceUsed.sub(log.args.value);
                        }
                    }
                    if (log.args.to === address) {
                        nativeBalance = nativeBalance.sub(log.args.value);
                    }

                    if (knownHashes.includes(log.transactionHash)) return false;

                    // Transfers to the Uniswap pool are the fees paid to OpenGSN
                    if (log.args.to === poolAddress) {
                        // Find the main transfer log
                        const mainTransferLog = allTransferLogs.find((otherLog) =>
                            otherLog.transactionHash === log.transactionHash
                            && otherLog.logIndex !== log.logIndex);

                        if (mainTransferLog && mainTransferLog.args) {
                            // Write this log's `value` as the main transfer log's `fee`
                            mainTransferLog.args = addFeeToArgs(mainTransferLog.args, log.args.value);
                        } else if (!mainTransferLog) {
                            // If no main transfer log was found, it means this transaction failed
                            // and only the fee was paid.
                            (log as TransferEvent).failed = true;
                            return true;
                        }

                        // Then ignore this log
                        return false;
                    }

                    if (log.args.to === config.usdc.nativeHtlcContract) {
                        // Get Open event log
                        const htlcEventPromise = log.getTransactionReceipt().then(async (receipt) => {
                            const nativeHtlcContract = await getNativeHtlcContract();

                            for (const innerLog of receipt.logs) {
                                if (innerLog.address === config.usdc.nativeHtlcContract) {
                                    try {
                                        const { args, name } = nativeHtlcContract.interface.parseLog(innerLog);
                                        if (name === 'Open') {
                                            return <HtlcEvent> {
                                                name,
                                                id: args.id,
                                                token: args.token,
                                                amount: args.amount.toNumber(),
                                                recipient: args.recipient,
                                                hash: args.hash,
                                                timeout: args.timeout.toNumber(),
                                            };
                                        }
                                    } catch (error) { /* ignore */ }
                                }
                            }
                            return undefined;
                        });

                        nativeHtlcEventsByTransactionHash.set(log.transactionHash, htlcEventPromise);
                    }

                    if (log.args.from === config.usdc.nativeHtlcContract) {
                        // Get Redeem or Refund event log
                        const htlcEventPromise = log.getTransactionReceipt().then(async (receipt) => {
                            const nativeHtlcContract = await getNativeHtlcContract();

                            for (const innerLog of receipt.logs) {
                                if (innerLog.address === config.usdc.nativeHtlcContract) {
                                    try {
                                        const { args, name } = nativeHtlcContract.interface.parseLog(innerLog);
                                        if (name === 'Redeem') {
                                            return <HtlcEvent> {
                                                name,
                                                id: args.id,
                                                secret: args.secret,
                                            };
                                        }
                                        if (name === 'Refund') {
                                            return <HtlcEvent> {
                                                name,
                                                id: args.id,
                                            };
                                        }
                                    } catch (error) { /* ignore */ }
                                }
                            }
                            return undefined;
                        });

                        nativeHtlcEventsByTransactionHash.set(log.transactionHash, htlcEventPromise);
                    }

                    if (log.args.from === config.usdc.swapPoolContract) {
                        // Uniswap swaps from bridged to native USDC are handled by the bridged USDC listener
                        // to be able to include the transaction fee into it.
                        return false;
                    }

                    return true;
                }) as TransferEvent[];

                const logsAndBlocks = newLogs.map((log) => ({
                    log,
                    block: log.getBlock(),
                    event: nativeHtlcEventsByTransactionHash.get(log.transactionHash),
                }));

                // TODO: Allow individual fetches to fail, but still add the other transactions?
                await Promise.all(logsAndBlocks.map( // eslint-disable-line no-await-in-loop
                    async ({ log, block, event }) => logAndBlockToPlain(
                        log,
                        await block,
                        await event,
                    ),
                )).then((transactions) => {
                    transactionsStore.addTransactions(transactions);
                });
            } // End while loop
            /* eslint-enable max-len */

            console.debug('Native USDC Sync end', {
                nativeBalance: nativeBalance.toNumber() / 1e6,
                nativeUsdcNonce,
                transferAllowance: transferAllowanceUsed.toNumber() / 1e6,
                htlcAllowance: htlcAllowanceUsed.toNumber() / 1e6,
            });
        })
            .catch((error) => {
                console.error(error);
                fetchedNativeAddresses.delete(address);
            })
            .then(() => network$.fetchingTxHistory--);
    });
}

function logAndBlockToPlain(
    log: TransferEvent | TransferLog,
    block?: Block,
    event?: HtlcEvent | UniswapEvent,
): Transaction {
    return {
        token: log.address,
        transactionHash: log.transactionHash,
        logIndex: log.logIndex,
        sender: log.args.from,
        recipient: log.args.to,
        value: log.args.value.toNumber(), // With Javascript numbers we can safely represent up to 9,007,199,254 USDC
        fee: log.args.fee?.toNumber(),
        event,
        state: log.failed
            ? TransactionState.FAILED
            : (block ? TransactionState.MINED : TransactionState.PENDING),
        blockHeight: block?.number,
        timestamp: block?.timestamp,
    };
}

type ContractMethods =
    'transfer'
    | 'transferWithPermit'
    | 'open'
    | 'openWithPermit'
    | 'redeemWithSecretInData'
    | 'refund'
    // | 'swap'
    | 'swapWithApproval';

export async function calculateFee(
    token: string, // Contract address
    method: ContractMethods,
    forceRelay?: RelayServerInfo,
    contract?: Contract,
) {
    const client = await getPolygonClient();
    const { config } = useConfig();
    if (!contract) {
        if (token === config.usdc.usdcContract) contract = client.usdcTransfer;
        else contract = client.nativeUsdcTransfer;
    }

    // The byte size of `data` of the wrapper relay transaction, plus 4 bytes for the `relayCall` method identifier
    const dataSize = {
        transfer: 1092,
        transferWithPermit: 1220,
        open: 1220,
        openWithPermit: 1348, // TODO: Recheck this value
        redeemWithSecretInData: 1092,
        refund: 1092,
        // swap: 0,
        swapWithApproval: 1252,
    }[method];

    if (!dataSize) throw new Error(`No dataSize set yet for ${method} method!`);

    // Update minGasPrice if relay was forcedRelay, as it is most likely outdated.
    // Also checks for `ready` status to avoid retrying with a non-ready relay
    let relay = await (forceRelay
        ? getRelayAddr(forceRelay.url).then((addr) => {
            if (!addr || !addr.ready) return undefined;
            return <RelayServerInfo> {
                ...forceRelay,
                minGasPrice: client.ethers.BigNumber.from(addr.minGasPrice),
            };
        })
        : Promise.resolve(undefined)
    );

    const [
        networkGasPrice,
        gasLimit,
        [acceptanceBudget],
        dataGasCost,
        usdcPrice,
    ] = await Promise.all([
        client.provider.getGasPrice(),
        contract.getRequiredRelayGas(contract.interface.getSighash(method)) as Promise<BigNumber>,
        relay
            ? Promise.resolve([client.ethers.BigNumber.from(0)])
            : contract.getGasAndDataLimits() as Promise<[BigNumber, BigNumber, BigNumber, BigNumber]>,
        relay
            ? Promise.resolve(client.ethers.BigNumber.from(0))
            : getRelayHub(client).calldataGasCost(dataSize) as Promise<BigNumber>,
        getUsdcPrice(token, client),
    ]);

    function calculateChainTokenFee(baseRelayFee: BigNumber, pctRelayFee: BigNumber, minGasPrice: BigNumber) {
        let gasPrice = networkGasPrice.gte(minGasPrice) ? networkGasPrice : minGasPrice;

        // For swap redeem txs, add 50% to cover network fee changes until the end of the swap.
        // Otherwise, in mainnet, add 10%; in testnet add 25% as it is more volatile.
        const gasPriceBufferPercentage = method === 'redeemWithSecretInData'
            ? 150
            : useConfig().config.environment === ENV_MAIN ? 110 : 125;
        gasPrice = gasPrice.mul(gasPriceBufferPercentage).div(100);

        // (gasPrice * gasLimit) * (1 + pctRelayFee) + baseRelayFee
        const chainTokenFee = gasPrice.mul(gasLimit).mul(pctRelayFee.add(100)).div(100).add(baseRelayFee);

        return { gasPrice, chainTokenFee };
    }

    if (!relay) {
        const requiredMaxAcceptanceBudget = acceptanceBudget.add(dataGasCost);
        relay = await getBestRelay(client, requiredMaxAcceptanceBudget, calculateChainTokenFee);
    }

    const { baseRelayFee, pctRelayFee, minGasPrice } = relay;

    const { gasPrice, chainTokenFee } = calculateChainTokenFee(baseRelayFee, pctRelayFee, minGasPrice);

    // main 10%, test 25% as it is more volatile
    const uniswapBufferPercentage = useConfig().config.environment === ENV_MAIN ? 110 : 125;
    const fee = chainTokenFee.div(usdcPrice).mul(uniswapBufferPercentage).div(100);

    return {
        chainTokenFee,
        fee,
        gasPrice,
        gasLimit,
        relay,
        usdcPrice,
    };
}

export async function createTransactionRequest(
    recipient: string,
    amount: number,
    forceRelay?: RelayServerInfo,
) {
    const addressInfo = useUsdcAddressStore().addressInfo.value;
    if (!addressInfo) throw new Error('No active USDC address');
    const fromAddress = addressInfo.address;

    const { config } = useConfig();

    const client = await getPolygonClient();

    const tokenAddress = config.usdc.nativeUsdcContract;
    const tokenContract = client.nativeUsdc;
    const transferAddress = config.usdc.nativeTransferContract;
    const transferContract = client.nativeUsdcTransfer;

    const [
        usdcNonce,
        // usdcAllowance,
        forwarderNonce,
    ] = await Promise.all([
        tokenContract.nonces(fromAddress) as Promise<BigNumber>,
        // tokenContract.allowance(fromAddress, transferAddress) as Promise<BigNumber>,
        transferContract.getNonce(fromAddress) as Promise<BigNumber>,
    ]);

    const method: 'transfer' | 'transferWithPermit' = 'transferWithPermit';
    // This sets the fee buffer to 10 USDC, which should be enough.
    // method = usdcAllowance.gte(amount + 10e6) ? 'transfer' : method;

    const { fee, gasPrice, gasLimit, relay } = await calculateFee(tokenAddress, method, forceRelay);

    // Ensure we send only what's possible with the updated fee
    const accountBalance = addressInfo.nativeBalance;
    amount = Math.min(amount, (accountBalance || 0) - fee.toNumber());

    // // To be safe, we still check that amount + fee fits into the current allowance
    // if (method === 'transfer' && usdcAllowance.lt(fee.add(amount))) {
    //     throw new Error('Unexpectedly high fee, not enough allowance on the USDC contract');
    // }

    const data = transferContract.interface.encodeFunctionData(method, [
        /* address token */ tokenAddress,
        /* uint256 amount */ amount,
        /* address target */ recipient,
        /* uint256 fee */ fee,
        ...(method === 'transferWithPermit' ? [
            // // Approve the maximum possible amount so afterwards we can use the `transfer` method for lower fees
            // /* uint256 value */ client.ethers
            //     .BigNumber.from('0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'),
            /* uint256 value */ fee.add(amount),

            // Dummy values, replaced by real signature bytes in Keyguard
            /* bytes32 sigR */ '0x0000000000000000000000000000000000000000000000000000000000000000',
            /* bytes32 sigS */ '0x0000000000000000000000000000000000000000000000000000000000000000',
            /* uint8 sigV */ 0,
        ] : []),
    ]);

    const relayRequest: RelayRequest = {
        request: {
            from: fromAddress,
            to: transferAddress,
            data,
            value: '0',
            nonce: forwarderNonce.toString(),
            gas: gasLimit.toString(),
            validUntil: (await getPolygonBlockNumber() + 2 * 60 * POLYGON_BLOCKS_PER_MINUTE) // 2 hours
                .toString(10),
        },
        relayData: {
            gasPrice: gasPrice.toString(),
            pctRelayFee: relay.pctRelayFee.toString(),
            baseRelayFee: relay.baseRelayFee.toString(),
            relayWorker: relay.relayWorkerAddress,
            paymaster: transferAddress,
            paymasterData: '0x',
            clientId: Math.floor(Math.random() * 1e6).toString(10),
            forwarder: transferAddress,
        },
    };

    return {
        relayRequest,
        relay: {
            url: relay.url,
        },
        ...(method === 'transferWithPermit' ? {
            permit: {
                tokenNonce: usdcNonce.toNumber(),
            },
        } : null),
    };
}

export async function sendTransaction(
    relayRequest: RelayRequest,
    signature: string,
    relayUrl: string,
    approvalData = '0x',
) {
    const { config } = useConfig();
    const client = await getPolygonClient();

    const [{ HttpClient, HttpWrapper }, relayNonce] = await Promise.all([
        import('@opengsn/common'),
        client.provider.getTransactionCount(relayRequest.relayData.relayWorker),
    ]);
    const httpClient = new HttpClient(new HttpWrapper(), console);

    const relayNonceMaxGap = config.environment === ENV_MAIN ? 3 : 5;

    const relayTx = await httpClient.relayTransaction(relayUrl, {
        relayRequest,
        metadata: {
            approvalData,
            relayHubAddress: config.usdc.relayHubContract,
            relayMaxNonce: relayNonce + relayNonceMaxGap,
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

    const token = relayRequest.request.to === config.usdc.nativeTransferContract
        || relayRequest.request.to === config.usdc.nativeHtlcContract
        ? config.usdc.nativeUsdcContract
        : config.usdc.usdcContract;

    // If `approvalData` is present, this is a redeem transaction
    const isHtlcRedeemTx = approvalData.length > 2;
    const isHtlcRefundTx = relayRequest.request.data.startsWith(
        relayRequest.request.to === config.usdc.nativeHtlcContract
            ? (await getNativeHtlcContract()).interface.getSighash('refund')
            : (await getHtlcContract()).interface.getSighash('refund'),
    );

    const isIncomingTx = isHtlcRedeemTx || isHtlcRefundTx;

    const tx = await receiptToTransaction(
        token,
        await txResponse.wait(1),
        // Do not filter by sender for incoming txs
        isIncomingTx ? undefined : relayRequest.request.from,
    );

    if (!isIncomingTx) {
        // Trigger manual balance update for outgoing transactions
        if (token === config.usdc.nativeUsdcContract) {
            updateNativeBalances([relayRequest.request.from]);
        } else {
            updateBalances([relayRequest.request.from]);
        }
    }

    return tx;
}

export async function receiptToTransaction(
    token: string,
    receipt: TransactionReceipt,
    filterByFromAddress?: string,
    block?: providers.Block,
) {
    const { config } = useConfig();
    const client = await getPolygonClient();

    const [tokenContract, transferContract] = token === config.usdc.nativeUsdcContract
        ? [client.nativeUsdc, client.nativeUsdcTransfer]
        : [client.usdc, client.usdcTransfer];

    const htlcContractAddress = token === config.usdc.nativeUsdcContract
        ? config.usdc.nativeHtlcContract
        : config.usdc.htlcContract;

    const [htlcContract, poolAddress] = await Promise.all([
        token === config.usdc.nativeUsdcContract ? getNativeHtlcContract() : getHtlcContract(),
        getPoolAddress(transferContract, token),
    ]);

    const logs = receipt.logs.map((log) => {
        if (log.address === token) {
            try {
                const { args, name } = tokenContract.interface.parseLog(log);
                return {
                    ...log,
                    args,
                    name,
                };
            } catch (error) {
                return null;
            }
        }

        if (log.address === htlcContractAddress) {
            try {
                const { args, name } = htlcContract.interface.parseLog(log);
                return {
                    ...log,
                    args,
                    name,
                };
            } catch (error) {
                return null;
            }
        }

        return null;
    });

    let transferLog: TransferLog | undefined;
    let feeLog: TransferLog | undefined;
    let htlcEvent: HtlcEvent | undefined;
    let uniswapEvent: UniswapEvent | undefined;

    logs.forEach((log) => {
        if (!log) return;

        if (log.name === 'Transfer') {
            if (filterByFromAddress && log.args.from !== filterByFromAddress) return;

            // Transfers to the Uniswap pool are the fees paid to OpenGSN
            if (
                log.args.to === poolAddress
                || (
                    // Before v3, transfers to the transferContract were the fees paid to OpenGSN
                    config.environment !== ENV_MAIN
                    && (
                        log.args.to === '0x443EAAd5EeAacCdC3887477c188CF2875B3dcf7c' // v2 USDC transfer contract
                        || log.args.to === '0x703EC732971cB23183582a6966bA70E164d89ab1' // v1 USDC transfer contract
                    )
                )
                || (
                    // Before v3, the first transfer to the HTLC contract was the fee paid to OpenGSN
                    config.environment !== ENV_MAIN
                    && (
                        log.args.to === '0x573aA448cC6e28AF0EeC7E93037B5A592a83d936' // v1 USDC HTLC contract
                        && !feeLog
                        // When Fastspot is funding the HTLC, there's only one Transfer event, which is the main
                        // `transferLog`, so don't handle any fee.
                        && logs.filter((l) => l?.name === 'Transfer').length > 1
                    )
                )
            ) {
                feeLog = log as TransferLog;
                return;
            }

            // Transfers to the bridged/native USDC Uniswap pool need to be extended with the UniswapEvent
            if (token === config.usdc.usdcContract && log.args.to === config.usdc.swapPoolContract) {
                for (const innerLog of receipt.logs) {
                    if (innerLog.address !== config.usdc.nativeUsdcContract) continue;
                    try {
                        const { args, name } = client.nativeUsdc.interface.parseLog(innerLog);
                        if (name === 'Transfer' && args.from === config.usdc.swapPoolContract) {
                            uniswapEvent = {
                                name: 'Swap',
                                amountIn: log.args.value.toNumber(),
                                amountOut: args.value.toNumber(),
                            };
                        }
                    } catch (error) { /* ignore */ }
                }
            }

            transferLog = log as TransferLog;
            return;
        }

        if (log.name === 'Open') {
            htlcEvent = {
                name: log.name,
                id: log.args.id,
                token: log.args.token,
                amount: log.args.amount.toNumber(),
                recipient: log.args.recipient,
                hash: log.args.hash,
                timeout: log.args.timeout.toNumber(),
            };
        }

        if (log.name === 'Redeem') {
            htlcEvent = {
                name: log.name,
                id: log.args.id,
                secret: log.args.secret,
            };
        }

        if (log.name === 'Refund') {
            htlcEvent = {
                name: log.name,
                id: log.args.id,
            };
        }
    });

    if (!transferLog) {
        if (feeLog) {
            transferLog = feeLog;
            transferLog.failed = true;
            feeLog = undefined;
        } else {
            throw new Error('Could not find transfer log');
        }
    }

    if (feeLog) {
        transferLog.args = addFeeToArgs(transferLog.args, feeLog.args.value) as TransferResult;
    }

    return logAndBlockToPlain(
        transferLog,
        block || await client.provider.getBlock(transferLog.blockHash),
        htlcEvent || uniswapEvent,
    );
}

export async function getPolygonBlockNumber() {
    const client = await getPolygonClient();
    const blockNumber = await client.provider.getBlockNumber();
    useUsdcNetworkStore().state.outdatedHeight = blockNumber;
    return blockNumber;
}

let htlcContract: Contract | undefined;
/** @deprecated */
export async function getHtlcContract() {
    if (htlcContract) return htlcContract;

    const { ethers, provider } = await getPolygonClient();
    const { config } = useConfig();
    htlcContract = new ethers.Contract(
        config.usdc.htlcContract,
        USDC_HTLC_CONTRACT_ABI,
        provider,
    );
    return htlcContract;
}

let nativeHtlcContract: Contract | undefined;
export async function getNativeHtlcContract() {
    if (nativeHtlcContract) return nativeHtlcContract;

    const { ethers, provider } = await getPolygonClient();
    const { config } = useConfig();
    nativeHtlcContract = new ethers.Contract(
        config.usdc.nativeHtlcContract,
        NATIVE_USDC_HTLC_CONTRACT_ABI,
        provider,
    );
    return nativeHtlcContract;
}

let swapContract: Contract | undefined;
export async function getSwapContract() {
    if (swapContract) return swapContract;

    const { ethers, provider } = await getPolygonClient();
    const { config } = useConfig();
    swapContract = new ethers.Contract(
        config.usdc.swapContract,
        SWAP_CONTRACT_ABI,
        provider,
    );
    return swapContract;
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
    failed?: boolean;
}

interface TransferEvent extends Event {
    args: TransferResult;
    failed?: boolean;
}
