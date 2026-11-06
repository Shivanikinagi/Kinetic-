import { createBlock } from "@ethereumjs/block";
import { createEVM, type EVM } from "@ethereumjs/evm";
import { createAccount, createAddressFromString } from "@ethereumjs/util";
import { decodeErrorResult, decodeEventLog, decodeFunctionResult, encodeDeployData, encodeFunctionData, toHex, type Abi, type Hex } from "viem";

// Test harness only: an in-process EVM (EthereumJS) to run the compiled contract as real
// bytecode, with a clock the tests control. Chain id is 1 (mainnet defaults).

export interface CallResult {
  ok: boolean;
  /** Revert reason as `ErrorName(arg, …)`, when it reverted with a custom error. */
  error?: string;
  result?: unknown;
  events: { eventName: string; args: Record<string, unknown> }[];
  gasUsed?: bigint;
}

export class TestChain {
  private constructor(
    private readonly evm: EVM,
    readonly abi: Abi,
  ) {}

  /** Seconds since the epoch the next call runs at. */
  now = 1_800_000_000;
  readonly chainId = 1;

  static async create(abi: Abi): Promise<TestChain> {
    return new TestChain(await createEVM(), abi);
  }

  async fund(address: string, wei: bigint): Promise<void> {
    await this.evm.stateManager.putAccount(createAddressFromString(address), createAccount({ balance: wei, nonce: 0n }));
  }

  async balanceOf(address: string): Promise<bigint> {
    return (await this.evm.stateManager.getAccount(createAddressFromString(address)))?.balance ?? 0n;
  }

  /** Sets an account's balance, keeping its code and storage (e.g. a network fee taken from a contract). */
  async setBalance(address: string, wei: bigint): Promise<void> {
    const a = createAddressFromString(address);
    const account = (await this.evm.stateManager.getAccount(a)) ?? createAccount({ balance: 0n, nonce: 0n });
    account.balance = wei;
    await this.evm.stateManager.putAccount(a, account);
  }

  /** Puts runtime code at an address, e.g. a stand-in for a Hedera system contract (0x16b, 0x169). */
  async putCode(address: string, runtime: Hex): Promise<void> {
    const a = createAddressFromString(address);
    if (!(await this.evm.stateManager.getAccount(a))) await this.evm.stateManager.putAccount(a, createAccount({ balance: 0n, nonce: 1n }));
    await this.evm.stateManager.putCode(a, hexBytes(runtime));
  }

  /** A call to another contract, with its own ABI (it must emit no events). */
  async callWith<T>(abi: Abi, from: string, to: string, functionName: string, args: unknown[] = []): Promise<T> {
    const res = await this.evm.runCall({ caller: createAddressFromString(from), to: createAddressFromString(to), data: hexBytes(encodeFunctionData({ abi, functionName, args } as never)), gasLimit: 10_000_000n, block: this.block() });
    if (res.execResult.exceptionError) throw new Error(`${functionName} reverted`);
    return decodeFunctionResult({ abi, functionName, data: toHex(res.execResult.returnValue) } as never) as T;
  }

  private block() {
    return createBlock({ header: { timestamp: BigInt(this.now), number: 1n, gasLimit: 30_000_000n } }, { common: this.evm.common });
  }

  async deploy(from: string, bytecode: Hex, args: unknown[]): Promise<string> {
    const res = await this.evm.runCall({ caller: createAddressFromString(from), data: hexBytes(encodeDeployData({ abi: this.abi, bytecode, args })), gasLimit: 30_000_000n, block: this.block() });
    if (res.execResult.exceptionError || !res.createdAddress) throw new Error(`deploy failed: ${res.execResult.exceptionError?.error}`);
    return res.createdAddress.toString();
  }

  async send(from: string, to: string, functionName: string, args: unknown[] = [], value = 0n): Promise<CallResult> {
    const res = await this.evm.runCall({
      caller: createAddressFromString(from),
      origin: createAddressFromString(from),
      to: createAddressFromString(to),
      data: hexBytes(encodeFunctionData({ abi: this.abi, functionName, args } as never)),
      value,
      gasLimit: 10_000_000n,
      block: this.block(),
    });
    const ret = toHex(res.execResult.returnValue);
    if (res.execResult.exceptionError) {
      let error = res.execResult.exceptionError.error as string;
      try {
        const e = decodeErrorResult({ abi: this.abi, data: ret });
        error = `${e.errorName}(${(e.args ?? []).map(String).join(",")})`;
      } catch {
        // Not a custom error.
      }
      return { ok: false, error, events: [] };
    }
    const events = (res.execResult.logs ?? []).map(([, topics, data]) => {
      const e = decodeEventLog({ abi: this.abi, topics: topics.map((t) => toHex(t)) as [Hex, ...Hex[]], data: toHex(data) });
      return { eventName: e.eventName as unknown as string, args: e.args as unknown as Record<string, unknown> };
    });
    let result: unknown;
    try {
      result = decodeFunctionResult({ abi: this.abi, functionName, data: ret } as never);
    } catch {
      result = undefined;
    }
    return { ok: true, result, events, gasUsed: res.execResult.executionGasUsed };
  }

  /** A read-only call, returning the decoded result. */
  async read<T>(to: string, functionName: string, args: unknown[] = []): Promise<T> {
    const r = await this.send("0x00000000000000000000000000000000000000ff", to, functionName, args);
    if (!r.ok) throw new Error(`${functionName} reverted: ${r.error}`);
    return r.result as T;
  }
}

const hexBytes = (hex: Hex) => Uint8Array.from(Buffer.from(hex.slice(2), "hex"));
