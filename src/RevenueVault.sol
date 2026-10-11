// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

interface IRegistryView {
    function pool() external view returns (address);
}

interface ILoanPool {
    function onRepayment(bytes32 deviceId, uint256 principalPart, uint256 feePart) external;
}

/// @notice One vault per device. Customers pay the vault, never the operator directly.
///         `settle()` splits every payment: lender first while a loan is open, operator gets the rest.
///         The operator has no withdraw function, so repayment cannot be skipped.
contract RevenueVault {
    using SafeERC20 for IERC20;

    enum Status {
        None,
        Active,
        Defaulted
    }

    struct Loan {
        Status status;
        uint64 start;
        uint64 period; // seconds between installments
        uint32 periods;
        uint64 grace; // seconds of slack before a missed installment counts
        uint16 repayBps; // share of each payment sent to the lender while Active
        uint128 totalOwed0; // principal + fee at origination
        uint128 principalOutstanding;
        uint128 feeOutstanding;
        uint128 installment;
        uint128 totalPaid;
        uint64 defaultedAt;
    }

    IERC20 public token;
    IRegistryView public registry;
    bytes32 public deviceId;
    address public owner;

    uint256 public cumRevenue;
    uint64 public firstRevenueAt;
    uint64 public lockNonce;
    Loan public loan;

    bool private _initialized;
    uint256 private _lock = 1;

    event Settled(uint256 amount, uint256 toLender, uint256 toOwner);
    event LoanOpened(uint256 principal, uint256 fee, uint32 periods, uint64 period);
    event LoanRepaid();
    event LoanDefaulted(uint64 at);
    /// @dev A gateway/device agent watches these. `locked == true` means the unit should stop working.
    event LockStateChanged(bytes32 indexed deviceId, bool locked, uint64 nonce);
    event LoanWrittenOff(uint256 principalLost);

    error AlreadyInitialized();
    error NotPool();
    error LoanExists();
    error NothingToSettle();
    error NotBehind();
    error Reentrancy();

    modifier nonReentrant() {
        if (_lock != 1) revert Reentrancy();
        _lock = 2;
        _;
        _lock = 1;
    }

    modifier onlyPool() {
        if (msg.sender != registry.pool()) revert NotPool();
        _;
    }

    constructor() {
        _initialized = true; // the implementation itself is never used
    }

    function initialize(address owner_, bytes32 deviceId_, address token_, address registry_) external {
        if (_initialized) revert AlreadyInitialized();
        _initialized = true;
        _lock = 1;
        owner = owner_;
        deviceId = deviceId_;
        token = IERC20(token_);
        registry = IRegistryView(registry_);
    }

    // ---------------------------------------------------------------- views

    function loanStatus() external view returns (Status) {
        return loan.status;
    }

    function owed() public view returns (uint256) {
        return uint256(loan.principalOutstanding) + loan.feeOutstanding;
    }

    function requiredPaid(uint256 at) public view returns (uint256) {
        Loan memory l = loan;
        if (l.status == Status.None || at <= l.start) return 0;
        uint256 n = (at - l.start) / l.period;
        if (n > l.periods) n = l.periods;
        uint256 req = n * l.installment;
        return req > l.totalOwed0 ? l.totalOwed0 : req;
    }

    function isBehind() public view returns (bool) {
        Loan memory l = loan;
        if (l.status != Status.Active || block.timestamp <= l.start + l.grace) return false;
        return l.totalPaid < requiredPaid(block.timestamp - l.grace);
    }

    // ---------------------------------------------------------------- pool hooks

    function openLoan(uint256 principal, uint256 fee, uint32 periods, uint64 period, uint64 grace, uint16 repayBps)
        external
        onlyPool
    {
        if (loan.status != Status.None) revert LoanExists();
        uint256 total = principal + fee;
        loan = Loan({
            status: Status.Active,
            start: uint64(block.timestamp),
            period: period,
            periods: periods,
            grace: grace,
            repayBps: repayBps,
            totalOwed0: uint128(total),
            principalOutstanding: uint128(principal),
            feeOutstanding: uint128(fee),
            installment: uint128((total + periods - 1) / periods),
            totalPaid: 0,
            defaultedAt: 0
        });
        emit LoanOpened(principal, fee, periods, period);
    }

    /// @return principalLost the principal that will never be repaid.
    function closeLoanAsLoss() external onlyPool returns (uint256 principalLost) {
        principalLost = loan.principalOutstanding;
        delete loan;
        emit LoanWrittenOff(principalLost);
        // the unit stays locked until the operator deals with the lender off-chain (roadmap)
    }

    // ---------------------------------------------------------------- public actions

    /// @notice Anyone can trigger this. A missed installment (beyond grace) flips the vault to Defaulted:
    ///         100% of revenue now goes to the lender and a lock request is emitted.
    function markDefault() external {
        if (!isBehind()) revert NotBehind();
        loan.status = Status.Defaulted;
        loan.defaultedAt = uint64(block.timestamp);
        lockNonce++;
        emit LoanDefaulted(uint64(block.timestamp));
        emit LockStateChanged(deviceId, true, lockNonce);
    }

    /// @notice Split whatever the vault holds. Callable by anyone.
    function settle() external nonReentrant {
        uint256 bal = token.balanceOf(address(this));
        if (bal == 0) revert NothingToSettle();
        if (firstRevenueAt == 0) firstRevenueAt = uint64(block.timestamp);
        cumRevenue += bal;

        Loan storage l = loan;
        uint256 toLender;
        if (l.status != Status.None) {
            uint256 share = l.status == Status.Active ? (bal * l.repayBps) / 10_000 : bal;
            uint256 remaining = owed();
            toLender = share > remaining ? remaining : share;
        }

        if (toLender > 0) {
            uint256 principalPart = toLender > l.principalOutstanding ? l.principalOutstanding : toLender;
            uint256 feePart = toLender - principalPart;
            l.principalOutstanding -= uint128(principalPart);
            l.feeOutstanding -= uint128(feePart);
            l.totalPaid += uint128(toLender);

            address pool = registry.pool();
            token.safeTransfer(pool, toLender);
            ILoanPool(pool).onRepayment(deviceId, principalPart, feePart);
        }

        uint256 toOwner = bal - toLender;
        if (toOwner > 0) token.safeTransfer(owner, toOwner);
        emit Settled(bal, toLender, toOwner);

        if (l.status != Status.None) _afterPayment(l);
    }

    function _afterPayment(Loan storage l) private {
        if (owed() == 0) {
            bool wasLocked = l.status == Status.Defaulted;
            delete loan;
            emit LoanRepaid();
            if (wasLocked) {
                lockNonce++;
                emit LockStateChanged(deviceId, false, lockNonce);
            }
        } else if (l.status == Status.Defaulted && l.totalPaid >= requiredPaid(block.timestamp)) {
            // arrears cleared: cure the default and unlock
            l.status = Status.Active;
            l.defaultedAt = 0;
            lockNonce++;
            emit LockStateChanged(deviceId, false, lockNonce);
        }
    }
}
