// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @dev Hedera Schedule Service system contract (HIP-755, HIP-1215), at 0x16b.
interface IHederaScheduleService {
    function scheduleCall(address to, uint256 expirySecond, uint256 gasLimit, uint64 value, bytes memory callData) external returns (int64 responseCode, address scheduleAddress);
    function deleteSchedule(address scheduleAddress) external returns (int64 responseCode);
    function hasScheduleCapacity(uint256 expirySecond, uint256 gasLimit) external view returns (bool hasCapacity);
}

/// @dev Hedera PRNG system contract (HIP-351), at 0x169.
interface IPrngSystemContract {
    function getPseudorandomSeed() external returns (bytes32);
}

/// @title KineticBondVault
/// @notice Holds provider bonds for KINETIC. A slash is a signed verdict that names the job,
///         the chunk and the result hash, and it needs signatures from `threshold` of the
///         registered verifiers: no single key can slash. A proposed slash waits out a dispute
///         window. The provider can dispute it by posting a challenge bond, and then a larger
///         quorum (`disputeThreshold`) decides; if they don't within `resolveTimeout`, the slash
///         is cancelled. An executed slash refunds the buyer from the bond, marks the provider
///         slashed for good and burns what is left of its bond once no other slash is pending.
///         On Hedera the vault finalizes a slash itself: proposing one can pay for a call to
///         executeSlash that the Schedule Service (HIP-1215) runs when the dispute window closes.
///         That is best-effort; executeSlash stays open to anyone, and settles a slash only once.
/// @dev On Hedera, msg.value and balances inside the EVM are in tinybars (1 HBAR = 1e8).
///      JSON-RPC clients send value in weibars (1 tinybar = 1e10 weibar); the relay converts.
contract KineticBondVault {
    struct Bond {
        uint256 amount;
        uint64 unlockAt;
        bool slashed;
        /// Slashes proposed or disputed against this provider. While any is open the bond can't leave.
        uint32 pending;
    }

    enum Status {
        None,
        Proposed,
        Disputed,
        Executed,
        Overturned,
        Cancelled
    }

    /// @notice What the verifiers sign. `chunk` and `resultHash` name the result that tipped the
    ///         provider over its failure limit; `evidence` hashes the full list of failed checks.
    struct Verdict {
        address provider;
        address payable buyer;
        bytes32 jobId;
        uint32 chunk;
        bytes32 resultHash;
        uint256 refund;
        bytes32 evidence;
    }

    struct Slash {
        address provider;
        address payable buyer;
        bytes32 jobId;
        uint32 chunk;
        bytes32 resultHash;
        bytes32 evidence;
        uint256 refund;
        uint256 challenge;
        uint64 proposedAt;
        uint64 disputedAt;
        Status status;
    }

    bytes32 public constant VERDICT_TYPEHASH =
        keccak256("KineticSlashVerdict(address provider,address buyer,bytes32 jobId,uint32 chunk,bytes32 resultHash,uint256 refund,bytes32 evidence)");
    bytes32 public constant RESOLUTION_TYPEHASH = keccak256("KineticDisputeResolution(bytes32 slashId,bool upheld)");
    uint256 private constant HALF_N = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0;

    address[] private verifierList;
    mapping(address => bool) public isVerifier;
    /// @notice Verifier signatures needed to propose a slash.
    uint8 public immutable threshold;
    /// @notice Verifier signatures needed to decide a disputed slash, either way.
    uint8 public immutable disputeThreshold;
    /// @notice Seconds a provider waits between requesting and taking out its bond.
    uint64 public immutable withdrawDelay;
    /// @notice Seconds after a proposal during which the provider may dispute it.
    uint64 public immutable disputeWindow;
    /// @notice Seconds the verifiers have to decide a dispute before it is cancelled.
    uint64 public immutable resolveTimeout;
    /// @notice Smallest challenge bond a dispute must post.
    uint256 public immutable minChallenge;

    mapping(address => Bond) public bonds;
    /// @notice keccak256(abi.encode(provider, jobId)) => slash, so one job slashes a provider at most once.
    mapping(bytes32 => Slash) public slashes;
    /// @notice Total bond burned: held here for good, owned by no one.
    uint256 public burned;

    /// @notice HBAR held for someone (bonds, open challenges) or burned. What the vault holds
    ///         above it is the schedule-fee float, the only HBAR its scheduled calls may spend.
    uint256 public committed;
    /// @notice Fee budgets of scheduled calls that have not run yet. New ones are scheduled only
    ///         while the float covers all of them.
    uint256 public reservedFees;
    /// @notice The vault's pending scheduled executeSlash for a slash, and the fee budget it set aside.
    mapping(bytes32 => address) public scheduleOf;
    mapping(bytes32 => uint256) public scheduleBudget;

    struct Draw {
        bytes32 seed;
        uint64 at;
    }
    /// @notice Hedera PRNG seeds a verifier drew, one per tag, and when (consensus seconds).
    mapping(bytes32 => Draw) public seeds;

    address private constant SCHEDULE_SERVICE = address(0x16b);
    address private constant PRNG = address(0x169);
    int64 private constant HEDERA_SUCCESS = 22;
    /// @notice Gas for the vault's scheduled executeSlash. Its fee, at most this times the gas
    ///         price, is paid from the float, so a proposal pays at least that much to schedule one.
    uint256 public constant SCHEDULE_GAS_LIMIT = 300_000;
    /// @dev Later seconds to try when the one the window closes at is full (+1, +2, +4, ... plus jitter).
    uint256 private constant SCHEDULE_PROBES = 5;
    /// @notice Seconds after a window closes that the scheduled call is set for. On Hedera,
    ///         block.timestamp is the start of a ~2 s block, so a call scheduled for the closing
    ///         second can run in a block that still reads as early, and would then do nothing.
    uint256 public constant SCHEDULE_DELAY = 10;

    event Bonded(address indexed provider, uint256 amount, uint256 total);
    event WithdrawRequested(address indexed provider, uint64 unlockAt);
    event Withdrawn(address indexed provider, uint256 amount);
    event SlashProposed(bytes32 indexed id, address indexed provider, address indexed buyer, bytes32 jobId, uint32 chunk, bytes32 resultHash, uint256 refund);
    event SlashDisputed(bytes32 indexed id, uint256 challenge);
    event SlashExecuted(bytes32 indexed id, address indexed provider, uint256 refund, uint256 burnt, uint256 challenge);
    event SlashReleased(bytes32 indexed id, address indexed provider, Status status, uint256 challenge);
    event SlashScheduled(bytes32 indexed id, address schedule, uint64 at, uint256 budget);
    /// @dev responseCode -1: not attempted (no fee float to cover it, no capacity, or no Schedule Service).
    event ScheduleFailed(bytes32 indexed id, int64 responseCode);
    event ScheduleCancelled(bytes32 indexed id, address schedule, bool deleted);
    event SeedDrawn(bytes32 indexed tag, bytes32 seed);

    error BadQuorum();
    error NothingBonded();
    error NotRequested();
    error Locked(uint64 unlockAt);
    error Frozen();
    error ProviderSlashed();
    error AlreadySlashed();
    error WrongStatus();
    error NotProvider();
    error WindowClosed();
    error ChallengeTooSmall();
    error NotYet(uint64 at);
    error BadSignature();
    error SignersNotSorted();
    error NotVerifier(address signer);
    error NoQuorum(uint256 have, uint256 need);
    error TransferFailed();
    error AlreadyDrawn();
    error NoRandomness();

    constructor(
        address[] memory verifiers_,
        uint8 threshold_,
        uint8 disputeThreshold_,
        uint64 withdrawDelay_,
        uint64 disputeWindow_,
        uint64 resolveTimeout_,
        uint256 minChallenge_
    ) {
        if (threshold_ == 0 || threshold_ > verifiers_.length || disputeThreshold_ < threshold_ || disputeThreshold_ > verifiers_.length) {
            revert BadQuorum();
        }
        for (uint256 i = 0; i < verifiers_.length; i++) {
            address v = verifiers_[i];
            if (v == address(0) || isVerifier[v]) revert BadQuorum();
            isVerifier[v] = true;
            verifierList.push(v);
        }
        threshold = threshold_;
        disputeThreshold = disputeThreshold_;
        withdrawDelay = withdrawDelay_;
        disputeWindow = disputeWindow_;
        resolveTimeout = resolveTimeout_;
        minChallenge = minChallenge_;
    }

    function verifiers() external view returns (address[] memory) {
        return verifierList;
    }

    // ── Bonds ──

    /// @notice Adds msg.value to the caller's bond. Topping up cancels a pending withdrawal.
    function bond() external payable {
        Bond storage b = bonds[msg.sender];
        if (b.slashed) revert ProviderSlashed();
        b.amount += msg.value;
        b.unlockAt = 0;
        committed += msg.value;
        emit Bonded(msg.sender, msg.value, b.amount);
    }

    function requestWithdraw() external {
        Bond storage b = bonds[msg.sender];
        if (b.amount == 0) revert NothingBonded();
        b.unlockAt = uint64(block.timestamp) + withdrawDelay;
        emit WithdrawRequested(msg.sender, b.unlockAt);
    }

    function withdraw() external {
        Bond storage b = bonds[msg.sender];
        if (b.unlockAt == 0) revert NotRequested();
        if (block.timestamp < b.unlockAt) revert Locked(b.unlockAt);
        if (b.pending > 0) revert Frozen();
        uint256 amount = b.amount;
        b.amount = 0;
        b.unlockAt = 0;
        committed -= amount;
        (bool ok, ) = payable(msg.sender).call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit Withdrawn(msg.sender, amount);
    }

    function bondOf(address provider) external view returns (uint256 amount, uint64 unlockAt, bool slashed, uint32 pending) {
        Bond storage b = bonds[provider];
        return (b.amount, b.unlockAt, b.slashed, b.pending);
    }

    // ── Slashing ──

    function slashId(address provider, bytes32 jobId) public pure returns (bytes32) {
        return keccak256(abi.encode(provider, jobId));
    }

    /// @notice The digest each verifier signs (EIP-191 personal_sign over these 32 bytes).
    function verdictDigest(Verdict calldata v) public view returns (bytes32) {
        return keccak256(abi.encode(VERDICT_TYPEHASH, block.chainid, address(this), v.provider, v.buyer, v.jobId, v.chunk, v.resultHash, v.refund, v.evidence));
    }

    function resolutionDigest(bytes32 id, bool upheld) public view returns (bytes32) {
        return keccak256(abi.encode(RESOLUTION_TYPEHASH, block.chainid, address(this), id, upheld));
    }

    /// @notice Opens a slash. Anyone may submit it; what counts are the verifier signatures,
    ///         sorted by signer address so none is counted twice. msg.value, if any, pays for the
    ///         vault to execute the slash itself when the dispute window closes (HIP-1215); it goes
    ///         back to the sender if that can't be scheduled, and the slash is executed as before.
    function proposeSlash(Verdict calldata v, bytes[] calldata signatures) external payable returns (bytes32 id) {
        _requireQuorum(verdictDigest(v), signatures, threshold);
        id = slashId(v.provider, v.jobId);
        Slash storage s = slashes[id];
        if (s.status != Status.None) revert AlreadySlashed();
        s.provider = v.provider;
        s.buyer = v.buyer;
        s.jobId = v.jobId;
        s.chunk = v.chunk;
        s.resultHash = v.resultHash;
        s.evidence = v.evidence;
        s.refund = v.refund;
        s.proposedAt = uint64(block.timestamp);
        s.status = Status.Proposed;
        bonds[v.provider].pending += 1;
        emit SlashProposed(id, v.provider, v.buyer, v.jobId, v.chunk, v.resultHash, v.refund);
        if (msg.value > 0 && !_schedule(id, uint256(s.proposedAt) + disputeWindow + SCHEDULE_DELAY, msg.value)) {
            // Best-effort: the fee goes back, and the verifiers' settle loop executes the slash.
            // If it can't be returned it stays in the float, for later schedules.
            (bool returned, ) = payable(msg.sender).call{value: msg.value}("");
            returned;
        }
    }

    /// @notice The provider contests a proposed slash inside the dispute window, posting a
    ///         challenge bond. It goes to the buyer if the slash is upheld and back to the
    ///         provider otherwise.
    function dispute(bytes32 id) external payable {
        Slash storage s = slashes[id];
        if (s.status != Status.Proposed) revert WrongStatus();
        if (msg.sender != s.provider) revert NotProvider();
        if (block.timestamp >= s.proposedAt + disputeWindow) revert WindowClosed();
        if (msg.value < minChallenge) revert ChallengeTooSmall();
        s.status = Status.Disputed;
        s.disputedAt = uint64(block.timestamp);
        s.challenge = msg.value;
        committed += msg.value;
        emit SlashDisputed(id, msg.value);
        // The scheduled execution moves to the end of the resolve timeout, when an undecided
        // dispute is cancelled. If the old one can't be deleted it will run as a no-op.
        uint256 budget = scheduleBudget[id];
        if (budget > 0 && _cancelSchedule(id)) _schedule(id, uint256(s.disputedAt) + resolveTimeout + SCHEDULE_DELAY, budget);
    }

    /// @notice Decides a disputed slash with `disputeThreshold` verifier signatures.
    function resolveDispute(bytes32 id, bool upheld, bytes[] calldata signatures) external {
        Slash storage s = slashes[id];
        if (s.status != Status.Disputed) revert WrongStatus();
        _requireQuorum(resolutionDigest(id, upheld), signatures, disputeThreshold);
        if (upheld) _execute(id, s);
        else _release(id, s, Status.Overturned);
    }

    /// @notice Executes an undisputed slash once its window has passed, or cancels a disputed
    ///         one the verifiers did not decide in time. Anyone may call it, the vault's own
    ///         scheduled call included; a slash already settled is left as it is.
    function executeSlash(bytes32 id) external {
        Slash storage s = slashes[id];
        // The vault's scheduled call (HIP-1215) is running: its fee is spent, and it never reverts
        // for being early, so a slash disputed meanwhile just waits for its resolution.
        bool scheduled = msg.sender == address(this);
        if (scheduled) _unreserve(id);
        if (s.status == Status.Proposed) {
            uint64 at = s.proposedAt + disputeWindow;
            if (block.timestamp < at) {
                if (scheduled) return;
                revert NotYet(at);
            }
            _execute(id, s);
        } else if (s.status == Status.Disputed) {
            uint64 at = s.disputedAt + resolveTimeout;
            if (block.timestamp < at) {
                if (scheduled) return;
                revert NotYet(at);
            }
            _release(id, s, Status.Cancelled);
        } else if (s.status == Status.None) {
            revert WrongStatus();
        }
        // Executed, overturned or cancelled already: nothing left to do.
    }

    function _execute(bytes32 id, Slash storage s) private {
        Bond storage b = bonds[s.provider];
        uint256 paid = s.refund < b.amount ? s.refund : b.amount;
        b.amount -= paid;
        b.pending -= 1;
        b.slashed = true;
        b.unlockAt = 0;
        uint256 burnt = _burnIfSettled(b);
        uint256 challenge = s.challenge;
        s.challenge = 0;
        s.status = Status.Executed;
        committed -= paid + challenge;
        _cancelSchedule(id);
        (bool ok, ) = s.buyer.call{value: paid + challenge}("");
        if (!ok) revert TransferFailed();
        emit SlashExecuted(id, s.provider, paid, burnt, challenge);
    }

    function _release(bytes32 id, Slash storage s, Status status) private {
        Bond storage b = bonds[s.provider];
        b.pending -= 1;
        // Slashed in another job: what's left burns once nothing else can claim it.
        _burnIfSettled(b);
        uint256 challenge = s.challenge;
        s.challenge = 0;
        s.status = status;
        committed -= challenge;
        _cancelSchedule(id);
        if (challenge > 0) {
            (bool ok, ) = payable(s.provider).call{value: challenge}("");
            if (!ok) revert TransferFailed();
        }
        emit SlashReleased(id, s.provider, status, challenge);
    }

    // ── Scheduled finalization (HIP-1215) ──

    /// @dev Schedules executeSlash(id) at `at` (or the next second with capacity), with `budget`
    ///      set aside from the float for its fee. Never reverts: false when it isn't scheduled.
    function _schedule(bytes32 id, uint256 at, uint256 budget) private returns (bool) {
        int64 rc = -1;
        // Only the float pays fees: it must cover this budget and every other one still pending.
        if (at > block.timestamp && address(this).balance >= committed + reservedFees + budget) {
            uint256 second = _freeSecond(id, at);
            if (second != 0) {
                (bool ok, bytes memory ret) = SCHEDULE_SERVICE.call(
                    abi.encodeCall(IHederaScheduleService.scheduleCall, (address(this), second, SCHEDULE_GAS_LIMIT, uint64(0), abi.encodeCall(this.executeSlash, (id))))
                );
                if (ok && ret.length >= 64) {
                    (int256 code, uint256 schedule) = abi.decode(ret, (int256, uint256));
                    rc = int64(code);
                    if (rc == HEDERA_SUCCESS && schedule != 0) {
                        scheduleOf[id] = address(uint160(schedule));
                        scheduleBudget[id] = budget;
                        reservedFees += budget;
                        emit SlashScheduled(id, address(uint160(schedule)), uint64(second), budget);
                        return true;
                    }
                }
            }
        }
        emit ScheduleFailed(id, rc);
        return false;
    }

    /// @dev The first second from `at` with capacity for the call (HIP-1215's back-off with
    ///      jitter), or 0 when there is none or no Schedule Service to ask.
    function _freeSecond(bytes32 id, uint256 at) private returns (uint256) {
        for (uint256 i = 0; i <= SCHEDULE_PROBES; i++) {
            uint256 second = at;
            if (i > 0) {
                uint256 delay = 1 << (i - 1);
                second = at + delay + (uint256(keccak256(abi.encode(id, i))) % delay);
            }
            (bool ok, bytes memory ret) = SCHEDULE_SERVICE.call(abi.encodeCall(IHederaScheduleService.hasScheduleCapacity, (second, SCHEDULE_GAS_LIMIT)));
            if (!ok || ret.length < 32) return 0;
            if (abi.decode(ret, (uint256)) != 0) return second;
        }
        return 0;
    }

    /// @dev Deletes the slash's pending scheduled call, if any; its budget is freed once it can no longer run.
    function _cancelSchedule(bytes32 id) private returns (bool deleted) {
        address schedule = scheduleOf[id];
        if (schedule == address(0)) return false;
        (bool ok, bytes memory ret) = SCHEDULE_SERVICE.call(abi.encodeCall(IHederaScheduleService.deleteSchedule, (schedule)));
        deleted = ok && ret.length >= 32 && abi.decode(ret, (int256)) == HEDERA_SUCCESS;
        if (deleted) _unreserve(id);
        emit ScheduleCancelled(id, schedule, deleted);
    }

    function _unreserve(bytes32 id) private {
        reservedFees -= scheduleBudget[id];
        delete scheduleBudget[id];
        delete scheduleOf[id];
    }

    /// @notice HBAR above what is held for someone, burned, or set aside for pending scheduled calls.
    function scheduleFloat() external view returns (uint256) {
        uint256 held = committed + reservedFees;
        return address(this).balance > held ? address(this).balance - held : 0;
    }

    // ── Verifiable randomness (HIP-351) ──

    /// @notice A verifier draws one Hedera PRNG seed per tag, recorded with its consensus time,
    ///         so anyone can check when it was drawn and that it was the only draw.
    function drawSeed(bytes32 tag) external returns (bytes32 seed) {
        if (!isVerifier[msg.sender]) revert NotVerifier(msg.sender);
        if (seeds[tag].at != 0) revert AlreadyDrawn();
        (bool ok, bytes memory ret) = PRNG.call(abi.encodeCall(IPrngSystemContract.getPseudorandomSeed, ()));
        if (!ok || ret.length < 32) revert NoRandomness();
        seed = abi.decode(ret, (bytes32));
        if (seed == bytes32(0)) revert NoRandomness();
        seeds[tag] = Draw(seed, uint64(block.timestamp));
        emit SeedDrawn(tag, seed);
    }

    /// @dev A slashed provider's remaining bond burns when no slash against it is still open.
    function _burnIfSettled(Bond storage b) private returns (uint256 burnt) {
        if (!b.slashed || b.pending != 0 || b.amount == 0) return 0;
        burnt = b.amount;
        burned += burnt;
        b.amount = 0;
    }

    function _requireQuorum(bytes32 digest, bytes[] calldata signatures, uint8 need) private view {
        bytes32 hash = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", digest));
        address last;
        for (uint256 i = 0; i < signatures.length; i++) {
            address signer = _recover(hash, signatures[i]);
            if (signer <= last) revert SignersNotSorted();
            if (!isVerifier[signer]) revert NotVerifier(signer);
            last = signer;
        }
        if (signatures.length < need) revert NoQuorum(signatures.length, need);
    }

    function _recover(bytes32 hash, bytes calldata sig) private pure returns (address signer) {
        if (sig.length != 65) revert BadSignature();
        bytes32 r = bytes32(sig[0:32]);
        bytes32 s = bytes32(sig[32:64]);
        uint8 v = uint8(sig[64]);
        if (v < 27) v += 27;
        if (uint256(s) > HALF_N || (v != 27 && v != 28)) revert BadSignature();
        signer = ecrecover(hash, v, r, s);
        if (signer == address(0)) revert BadSignature();
    }
}
