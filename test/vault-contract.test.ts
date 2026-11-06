import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import solc from "solc";
import { encodeFunctionData, getAddress, zeroAddress, type Abi, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { evidenceBytes32, quorumSignatures, resolutionDigest, signDigest, slashIdOf, verdictArgs, verdictDigest, type SlashVerdict } from "../src/core/verdict.js";
import { compileVault } from "../src/integrations/vault-deploy.js";
import { TestChain } from "./support/evm.js";

// contracts/KineticBondVault.sol run as compiled bytecode in an in-process EVM: quorum
// signatures, the signed verdict, the dispute window and burning.

const WINDOW = 3600;
const TIMEOUT = 7200;
// The vault schedules itself this long after a window closes (SCHEDULE_DELAY): Hedera's block.timestamp lags consensus by up to a block.
const DELAY = 10;
const CHALLENGE = 1_000n;
const verifiers = [0, 1, 2].map(() => privateKeyToAccount(generatePrivateKey()));
const outsider = privateKeyToAccount(generatePrivateKey());
const deployer = "0x00000000000000000000000000000000000000d0";
const provider = "0x00000000000000000000000000000000000000a1";
const buyer = "0x00000000000000000000000000000000000000b1";

let compiled: { abi: Abi; bytecode: Hex };
let chain: TestChain;
let vault: string;
const domain = () => ({ address: vault, chainId: chain.chainId });

beforeAll(() => {
  compiled = compileVault();
});

beforeEach(async () => {
  chain = await TestChain.create(compiled.abi);
  for (const a of [deployer, provider, buyer]) await chain.fund(a, 10n ** 24n);
  // 2 of 3 verifiers to slash, all 3 to decide a dispute.
  vault = await chain.deploy(deployer, compiled.bytecode, [verifiers.map((v) => v.address), 2, 3, 86_400n, BigInt(WINDOW), BigInt(TIMEOUT), CHALLENGE]);
  expect((await chain.send(provider, vault, "bond", [], 100_000n)).ok).toBe(true);
});

const verdict = (over: Partial<SlashVerdict> = {}): SlashVerdict => ({
  provider,
  buyer,
  jobId: "job-1",
  chunk: 7,
  resultHash: "ab".repeat(32),
  refundTinybar: 30_000n,
  evidence: '{"receipts":[3,5,9]}',
  ...over,
});

async function signed(v: SlashVerdict, by = verifiers.slice(0, 2)) {
  const digest = verdictDigest(v, domain());
  const sigs = await Promise.all(by.map((a) => signDigest(a, digest)));
  return quorumSignatures(digest, sigs, by.map((a) => a.address));
}

const propose = async (v: SlashVerdict, sigs: Hex[]) => chain.send(outsider.address, vault, "proposeSlash", [verdictArgs(v), sigs]);
const bond = async () => chain.read<readonly [bigint, bigint, boolean, number]>(vault, "bondOf", [provider]);

describe("KineticBondVault", () => {
  it("signs the same digest the contract computes, bound to this vault and chain", async () => {
    const v = verdict();
    expect(await chain.read(vault, "verdictDigest", [verdictArgs(v)])).toBe(verdictDigest(v, domain()));
    expect(await chain.read(vault, "slashId", [provider, verdictArgs(v).jobId])).toBe(slashIdOf(provider, "job-1"));
    expect(await chain.read(vault, "resolutionDigest", [slashIdOf(provider, "job-1"), true])).toBe(resolutionDigest(slashIdOf(provider, "job-1"), true, domain()));
    expect(verdictDigest(v, { ...domain(), chainId: 296 })).not.toBe(verdictDigest(v, domain()));
  });

  it("needs a quorum of distinct verifiers, in address order", async () => {
    const v = verdict();
    const one = await signed(v, verifiers.slice(0, 1));
    expect((await propose(v, one.signatures)).error).toBe("NoQuorum(1,2)");
    const two = await signed(v);
    expect((await propose(v, [...two.signatures].reverse())).error).toBe("SignersNotSorted()");
    expect((await propose(v, [two.signatures[0], two.signatures[0]])).error).toBe("SignersNotSorted()");
    const stranger = await signDigest(outsider, verdictDigest(v, domain()));
    expect((await propose(v, [two.signatures[0], stranger].sort())).error).toMatch(/^NotVerifier|^SignersNotSorted/);
    expect((await propose(v, two.signatures)).ok).toBe(true);
  });

  it("rejects signatures over a different chunk, result or refund", async () => {
    const { signatures } = await signed(verdict());
    for (const changed of [verdict({ chunk: 8 }), verdict({ resultHash: "cd".repeat(32) }), verdict({ refundTinybar: 99_999n }), verdict({ evidence: "{}" })]) {
      expect((await propose(changed, signatures)).error).toMatch(/^NotVerifier|^SignersNotSorted/);
    }
  });

  it("waits out the dispute window, then refunds the buyer and burns the rest of the bond", async () => {
    const v = verdict();
    const proposed = await propose(v, (await signed(v)).signatures);
    expect(proposed.events[0]).toMatchObject({ eventName: "SlashProposed", args: { chunk: 7, refund: 30_000n } });
    const id = slashIdOf(provider, "job-1");
    expect((await bond())[3]).toBe(1);
    // Frozen: the bond can't leave while the slash is open.
    await chain.send(provider, vault, "requestWithdraw");
    chain.now += 86_401;
    expect((await chain.send(provider, vault, "withdraw")).error).toBe("Frozen()");
    chain.now -= 86_401;

    expect((await chain.send(outsider.address, vault, "executeSlash", [id])).error).toMatch(/^NotYet/);
    chain.now += WINDOW;
    const before = await chain.balanceOf(buyer);
    const executed = await chain.send(outsider.address, vault, "executeSlash", [id]);
    expect(executed.events[0]).toMatchObject({ eventName: "SlashExecuted", args: { refund: 30_000n, burnt: 70_000n } });
    expect((await chain.balanceOf(buyer)) - before).toBe(30_000n);
    expect(await bond()).toEqual([0n, 0n, true, 0]);
    expect(await chain.read(vault, "burned")).toBe(70_000n);
    expect((await propose(v, (await signed(v)).signatures)).error).toBe("AlreadySlashed()");
    expect((await chain.send(provider, vault, "bond", [], 1n)).error).toBe("ProviderSlashed()");
  });

  it("burns only after every open slash against the provider is settled", async () => {
    const a = verdict({ jobId: "job-a", refundTinybar: 20_000n });
    const b = verdict({ jobId: "job-b", refundTinybar: 50_000n });
    await propose(a, (await signed(a)).signatures);
    await propose(b, (await signed(b)).signatures);
    chain.now += WINDOW;
    const first = await chain.send(outsider.address, vault, "executeSlash", [slashIdOf(provider, "job-a")]);
    expect(first.events[0].args).toMatchObject({ refund: 20_000n, burnt: 0n });
    const second = await chain.send(outsider.address, vault, "executeSlash", [slashIdOf(provider, "job-b")]);
    expect(second.events[0].args).toMatchObject({ refund: 50_000n, burnt: 30_000n });
  });

  describe("disputes", () => {
    const id = () => slashIdOf(provider, "job-1");
    beforeEach(async () => {
      const v = verdict();
      await propose(v, (await signed(v)).signatures);
    });

    it("only the provider, inside the window, with a big enough challenge", async () => {
      expect((await chain.send(buyer, vault, "dispute", [id()], CHALLENGE)).error).toBe("NotProvider()");
      expect((await chain.send(provider, vault, "dispute", [id()], CHALLENGE - 1n)).error).toBe("ChallengeTooSmall()");
      chain.now += WINDOW;
      expect((await chain.send(provider, vault, "dispute", [id()], CHALLENGE)).error).toBe("WindowClosed()");
    });

    it("upheld by every verifier: the buyer gets the refund and the challenge", async () => {
      await chain.send(provider, vault, "dispute", [id()], 5_000n);
      chain.now += WINDOW;
      expect((await chain.send(outsider.address, vault, "executeSlash", [id()])).error).toMatch(/^NotYet/);
      const digest = resolutionDigest(id(), true, domain());
      const two = await quorumSignatures(digest, await Promise.all(verifiers.slice(0, 2).map((x) => signDigest(x, digest))), verifiers.map((x) => x.address));
      expect((await chain.send(outsider.address, vault, "resolveDispute", [id(), true, two.signatures])).error).toBe("NoQuorum(2,3)");
      const all = await quorumSignatures(digest, await Promise.all(verifiers.map((x) => signDigest(x, digest))), verifiers.map((x) => x.address));
      const before = await chain.balanceOf(buyer);
      const r = await chain.send(outsider.address, vault, "resolveDispute", [id(), true, all.signatures]);
      expect(r.events[0]).toMatchObject({ eventName: "SlashExecuted", args: { refund: 30_000n, challenge: 5_000n } });
      expect((await chain.balanceOf(buyer)) - before).toBe(35_000n);
    });

    it("overturned: the provider keeps its bond and gets its challenge back", async () => {
      await chain.send(provider, vault, "dispute", [id()], 5_000n);
      const digest = resolutionDigest(id(), false, domain());
      const all = await quorumSignatures(digest, await Promise.all(verifiers.map((x) => signDigest(x, digest))), verifiers.map((x) => x.address));
      // Signatures for "upheld" don't decide "overturned".
      const upheld = resolutionDigest(id(), true, domain());
      const wrong = await quorumSignatures(upheld, await Promise.all(verifiers.map((x) => signDigest(x, upheld))), verifiers.map((x) => x.address));
      expect((await chain.send(outsider.address, vault, "resolveDispute", [id(), false, wrong.signatures])).ok).toBe(false);
      const r = await chain.send(outsider.address, vault, "resolveDispute", [id(), false, all.signatures]);
      expect(r.events[0]).toMatchObject({ eventName: "SlashReleased", args: { status: 4, challenge: 5_000n } });
      expect(await bond()).toEqual([100_000n, 0n, false, 0]);
    });

    it("undecided past the timeout: cancelled in the provider's favour", async () => {
      await chain.send(provider, vault, "dispute", [id()], 5_000n);
      chain.now += TIMEOUT - 1;
      expect((await chain.send(outsider.address, vault, "executeSlash", [id()])).error).toMatch(/^NotYet/);
      chain.now += 1;
      const r = await chain.send(outsider.address, vault, "executeSlash", [id()]);
      expect(r.events[0]).toMatchObject({ eventName: "SlashReleased", args: { status: 5 } });
      expect((await bond())[2]).toBe(false);
    });
  });

  it("refuses a quorum larger than the verifier set, or duplicate verifiers", async () => {
    const v = verifiers.map((x) => x.address);
    await expect(chain.deploy(deployer, compiled.bytecode, [v, 4, 4, 1n, 1n, 1n, 0n])).rejects.toThrow();
    await expect(chain.deploy(deployer, compiled.bytecode, [[v[0], v[0]], 1, 2, 1n, 1n, 1n, 0n])).rejects.toThrow();
    await expect(chain.deploy(deployer, compiled.bytecode, [v, 2, 1, 1n, 1n, 1n, 0n])).rejects.toThrow();
    expect(evidenceBytes32("x")).toMatch(/^0x[0-9a-f]{64}$/);
  });
});

// ── HIP-1215 scheduled finalization and HIP-351 seeds ────────────────────────
// The Schedule Service (0x16b) and PRNG (0x169) exist only on Hedera, so stand-ins are put at
// their addresses. The test fires a scheduled call the way the network does: the vault calling
// its own executeSlash once the expiry second arrives, its fee taken from the vault's balance.

const MOCKS = `
pragma solidity ^0.8.24;
contract MockScheduleService {
    uint256 public mode; // 0 works, 1 no capacity, 2 scheduleCall refused
    bool public refuseDelete;
    uint256 public count;
    uint256 public deletes;
    address public lastTo;
    uint256 public lastExpiry;
    uint256 public lastGas;
    bytes public lastData;
    function setMode(uint256 m, bool refuse) external { mode = m; refuseDelete = refuse; }
    function hasScheduleCapacity(uint256, uint256) external view returns (bool) { return mode != 1; }
    function scheduleCall(address to, uint256 expiry, uint256 gasLimit, uint64, bytes memory data) external returns (int64, address) {
        if (mode == 2) return (int64(306), address(0));
        count++;
        lastTo = to; lastExpiry = expiry; lastGas = gasLimit; lastData = data;
        return (int64(22), address(uint160(0x5c0000 + count)));
    }
    function deleteSchedule(address) external returns (int64) {
        if (refuseDelete) return int64(201);
        deletes++;
        return int64(22);
    }
}
contract MockPrng {
    uint256 n;
    function getPseudorandomSeed() external returns (bytes32) { n++; return keccak256(abi.encode(n, "hedera-prng")); }
}`;

const HSS = "0x000000000000000000000000000000000000016b";
const PRNG = "0x0000000000000000000000000000000000000169";
let mocks: Record<"MockScheduleService" | "MockPrng", { abi: Abi; runtime: Hex }>;

beforeAll(() => {
  const out = JSON.parse(
    solc.compile(JSON.stringify({ language: "Solidity", sources: { "mocks.sol": { content: MOCKS } }, settings: { evmVersion: "paris", outputSelection: { "*": { "*": ["abi", "evm.deployedBytecode.object"] } } } })),
  );
  const pick = (name: string) => ({ abi: out.contracts["mocks.sol"][name].abi as Abi, runtime: `0x${out.contracts["mocks.sol"][name].evm.deployedBytecode.object}` as Hex });
  mocks = { MockScheduleService: pick("MockScheduleService"), MockPrng: pick("MockPrng") };
});

describe("KineticBondVault on Hedera: scheduled finalization", () => {
  const FEE = 50_000n;
  const id = () => slashIdOf(provider, "job-1");
  const hss = <T>(fn: string, args: unknown[] = []) => chain.callWith<T>(mocks.MockScheduleService.abi, deployer, HSS, fn, args);
  const setMode = (mode: bigint, refuseDelete = false) => chain.callWith(mocks.MockScheduleService.abi, deployer, HSS, "setMode", [mode, refuseDelete]);
  const proposeWithFee = async (v = verdict(), fee = FEE) => chain.send(outsider.address, vault, "proposeSlash", [verdictArgs(v), (await signed(v)).signatures], fee);
  /** The network running the vault's schedule: its fee comes off the vault's balance first. */
  const fire = async (fee = 7_000n) => {
    await chain.setBalance(vault, (await chain.balanceOf(vault)) - fee);
    return chain.send(vault, vault, "executeSlash", [id()]);
  };
  const ledger = async () => ({
    balance: await chain.balanceOf(vault),
    committed: await chain.read<bigint>(vault, "committed"),
    reserved: await chain.read<bigint>(vault, "reservedFees"),
    float: await chain.read<bigint>(vault, "scheduleFloat"),
  });

  beforeEach(async () => {
    await chain.fund(outsider.address, 10n ** 24n);
  });

  it("without a Schedule Service, proposes as before and returns the fee", async () => {
    const before = await chain.balanceOf(outsider.address);
    const r = await proposeWithFee();
    expect(r.ok).toBe(true);
    expect(r.events.map((e) => e.eventName)).toEqual(["SlashProposed", "ScheduleFailed"]);
    expect(r.events[1].args).toMatchObject({ responseCode: -1n });
    expect(await chain.balanceOf(outsider.address)).toBe(before);
    expect(await ledger()).toEqual({ balance: 100_000n, committed: 100_000n, reserved: 0n, float: 0n });
  });

  describe("with the Schedule Service", () => {
    beforeEach(async () => {
      await chain.putCode(HSS, mocks.MockScheduleService.runtime);
    });

    it("schedules executeSlash for just after the dispute window closes, and executes itself then", async () => {
      expect(await chain.read<bigint>(vault, "SCHEDULE_DELAY")).toBe(BigInt(DELAY));
      const r = await proposeWithFee();
      const scheduled = r.events.find((e) => e.eventName === "SlashScheduled")!;
      expect(scheduled.args).toMatchObject({ id: id(), at: BigInt(chain.now + WINDOW + DELAY), budget: FEE });
      expect(await hss<string>("lastTo")).toBe(getAddress(vault));
      expect(await hss<bigint>("lastExpiry")).toBe(BigInt(chain.now + WINDOW + DELAY));
      expect(await hss<bigint>("lastGas")).toBe(await chain.read<bigint>(vault, "SCHEDULE_GAS_LIMIT"));
      expect(await hss<Hex>("lastData")).toBe(encodeFunctionData({ abi: compiled.abi, functionName: "executeSlash", args: [id()] }));
      expect(await chain.read(vault, "scheduleOf", [id()])).toBe(scheduled.args.schedule);
      expect(await ledger()).toEqual({ balance: 100_000n + FEE, committed: 100_000n, reserved: FEE, float: 0n });

      chain.now += WINDOW + DELAY;
      const buyerBefore = await chain.balanceOf(buyer);
      const executed = await fire(7_000n);
      expect(executed.events[0]).toMatchObject({ eventName: "SlashExecuted", args: { refund: 30_000n, burnt: 70_000n } });
      expect(executed.gasUsed! * 2n).toBeLessThan(await chain.read<bigint>(vault, "SCHEDULE_GAS_LIMIT"));
      expect((await chain.balanceOf(buyer)) - buyerBefore).toBe(30_000n);
      // The fee came out of the float: the burned bond is all still there.
      expect(await ledger()).toEqual({ balance: 70_000n + FEE - 7_000n, committed: 70_000n, reserved: 0n, float: FEE - 7_000n });
      // The verifiers' settle loop arriving second finds nothing to do, and doesn't revert.
      const again = await chain.send(outsider.address, vault, "executeSlash", [id()]);
      expect(again).toMatchObject({ ok: true, events: [] });
      expect((await chain.send(outsider.address, vault, "executeSlash", [slashIdOf(provider, "job-x")])).error).toBe("WrongStatus()");
    });

    it("a verifier executing first deletes the schedule and frees its budget", async () => {
      await proposeWithFee();
      chain.now += WINDOW;
      const r = await chain.send(outsider.address, vault, "executeSlash", [id()]);
      expect(r.events.map((e) => e.eventName)).toEqual(["ScheduleCancelled", "SlashExecuted"]);
      expect(await hss<bigint>("deletes")).toBe(1n);
      expect(await chain.read(vault, "scheduleOf", [id()])).toBe(zeroAddress);
      expect((await ledger()).reserved).toBe(0n);
    });

    it("a dispute moves the schedule to the resolve timeout, where an undecided slash is cancelled", async () => {
      await proposeWithFee();
      const disputed = await chain.send(provider, vault, "dispute", [id()], 5_000n);
      expect(disputed.events.map((e) => e.eventName)).toEqual(["SlashDisputed", "ScheduleCancelled", "SlashScheduled"]);
      expect(await hss<bigint>("lastExpiry")).toBe(BigInt(chain.now + TIMEOUT + DELAY));
      expect(await ledger()).toMatchObject({ committed: 105_000n, reserved: FEE });
      chain.now += TIMEOUT + DELAY;
      const r = await fire();
      expect(r.events[0]).toMatchObject({ eventName: "SlashReleased", args: { status: 5, challenge: 5_000n } });
      expect(await bond()).toEqual([100_000n, 0n, false, 0]);
      expect(await ledger()).toMatchObject({ committed: 100_000n, reserved: 0n });
    });

    it("a schedule that can't be deleted runs as a no-op on a disputed slash, which is decided as usual", async () => {
      await proposeWithFee();
      await setMode(0n, true);
      const disputed = await chain.send(provider, vault, "dispute", [id()], 5_000n);
      expect(disputed.events.map((e) => e.eventName)).toEqual(["SlashDisputed", "ScheduleCancelled"]);
      chain.now += WINDOW;
      const early = await fire();
      expect(early).toMatchObject({ ok: true, events: [] });
      expect((await ledger()).reserved).toBe(0n);
      const digest = resolutionDigest(id(), false, domain());
      const all = await quorumSignatures(digest, await Promise.all(verifiers.map((x) => signDigest(x, digest))), verifiers.map((x) => x.address));
      const r = await chain.send(outsider.address, vault, "resolveDispute", [id(), false, all.signatures]);
      expect(r.events.at(-1)).toMatchObject({ eventName: "SlashReleased", args: { status: 4 } });
      expect(await bond()).toEqual([100_000n, 0n, false, 0]);
    });

    it("never lets scheduled fees reach the bonds: no float, no schedule", async () => {
      await proposeWithFee();
      // A schedule that cost more than its budget: the float is short by 1.
      await chain.setBalance(vault, (await chain.balanceOf(vault)) - FEE - 1n);
      const r = await proposeWithFee(verdict({ jobId: "job-2" }));
      expect(r.events.map((e) => e.eventName)).toEqual(["SlashProposed", "ScheduleFailed"]);
      expect((await ledger()).reserved).toBe(FEE);
    });

    it("returns the fee when the network has no capacity or refuses the schedule", async () => {
      await setMode(1n);
      const busy = await proposeWithFee();
      expect(busy.events[1]).toMatchObject({ eventName: "ScheduleFailed", args: { responseCode: -1n } });
      await setMode(2n);
      const refused = await proposeWithFee(verdict({ jobId: "job-2" }));
      expect(refused.events[1]).toMatchObject({ eventName: "ScheduleFailed", args: { responseCode: 306n } });
      expect(await ledger()).toEqual({ balance: 100_000n, committed: 100_000n, reserved: 0n, float: 0n });
    });
  });

  describe("seeds", () => {
    const tag = `0x${"5e".repeat(32)}` as Hex;

    it("needs the PRNG system contract", async () => {
      expect((await chain.send(verifiers[0].address, vault, "drawSeed", [tag])).error).toBe("NoRandomness()");
    });

    it("lets a verifier draw one seed per tag, recorded with its time", async () => {
      await chain.putCode(PRNG, mocks.MockPrng.runtime);
      expect((await chain.send(outsider.address, vault, "drawSeed", [tag])).error).toMatch(/^NotVerifier/);
      const r = await chain.send(verifiers[1].address, vault, "drawSeed", [tag]);
      const seed = r.events[0].args.seed as Hex;
      expect(r.events[0]).toMatchObject({ eventName: "SeedDrawn", args: { tag } });
      expect(r.result).toBe(seed);
      expect(await chain.read(vault, "seeds", [tag])).toEqual([seed, BigInt(chain.now)]);
      expect((await chain.send(verifiers[0].address, vault, "drawSeed", [tag])).error).toBe("AlreadyDrawn()");
    });
  });
});
