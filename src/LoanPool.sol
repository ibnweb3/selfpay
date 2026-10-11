// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {DeviceRegistry} from "./DeviceRegistry.sol";
import {RevenueVault} from "./RevenueVault.sol";

/// @notice Lenders deposit a stablecoin and receive pool shares (ERC-4626). Operators borrow against the
///         revenue their device's vault has actually collected - not against the hardware's resale value,
///         so no price oracle is needed. Repayment arrives automatically from the vault.
contract LoanPool is ERC4626, Ownable {
    using SafeERC20 for IERC20;

    struct Params {
        uint16 advanceBps; // max (principal+fee) as % of expected revenue over the loan term
        uint16 repayBps; // share of every payment the vault sends to the lender while Active
        uint16 feeBps; // flat fee on principal
        uint32 periods; // installments
        uint64 period; // seconds per installment
        uint64 grace; // seconds of slack before a missed installment counts
        uint64 minHistory; // seconds of observed revenue required before borrowing
        uint64 maxReadingAge; // device must have reported within this window
        uint64 writeOffDelay; // seconds in default before LPs take the loss
    }

    DeviceRegistry public immutable registry;
    Params public params;
    uint256 public totalPrincipalOutstanding;
    mapping(bytes32 => bool) public blocked; // devices that defaulted into write-off

    event Borrowed(bytes32 indexed deviceId, address indexed owner, uint256 principal, uint256 fee);
    event Repayment(bytes32 indexed deviceId, uint256 principalPart, uint256 feePart);
    event WrittenOff(bytes32 indexed deviceId, uint256 principalLost);
    event ParamsUpdated();

    error NotDeviceOwner();
    error DeviceBlocked();
    error ActiveLoan();
    error StaleReading();
    error NotEnoughHistory();
    error ExceedsAdvance(uint256 requested, uint256 max);
    error NotEnoughLiquidity();
    error NotVault();
    error NotDefaulted();
    error TooEarly();
    error BadParams();

    constructor(IERC20 asset_, DeviceRegistry registry_, address owner_, Params memory p)
        ERC20("Device Revenue Pool", "dRPL")
        ERC4626(asset_)
        Ownable(owner_)
    {
        registry = registry_;
        _setParams(p);
    }

    function setParams(Params calldata p) external onlyOwner {
        _setParams(p);
    }

    function _setParams(Params memory p) private {
        if (p.advanceBps == 0 || p.advanceBps > 10_000) revert BadParams();
        if (p.repayBps == 0 || p.repayBps > 10_000) revert BadParams();
        if (p.periods == 0 || p.period == 0) revert BadParams();
        params = p;
        emit ParamsUpdated();
    }

    // ---------------------------------------------------------------- ERC-4626 accounting

    function decimals() public view override(ERC4626) returns (uint8) {
        return super.decimals();
    }

    /// @dev cash + principal currently out on loan. Fees count as income only when actually repaid.
    function totalAssets() public view override returns (uint256) {
        return IERC20(asset()).balanceOf(address(this)) + totalPrincipalOutstanding;
    }

    function _cash() private view returns (uint256) {
        return IERC20(asset()).balanceOf(address(this));
    }

    function maxWithdraw(address account) public view override returns (uint256) {
        uint256 byShares = super.maxWithdraw(account);
        uint256 cash = _cash();
        return byShares < cash ? byShares : cash;
    }

    function maxRedeem(address account) public view override returns (uint256) {
        uint256 byShares = super.maxRedeem(account);
        uint256 byCash = convertToShares(_cash());
        return byShares < byCash ? byShares : byCash;
    }

    // ---------------------------------------------------------------- borrowing

    /// @notice Largest principal a device could borrow right now, 0 if it does not qualify.
    function maxPrincipal(bytes32 deviceId) public view returns (uint256) {
        DeviceRegistry.Device memory d = registry.getDevice(deviceId);
        RevenueVault v = RevenueVault(d.vault);
        Params memory p = params;
        uint256 first = v.firstRevenueAt();
        if (first == 0 || block.timestamp - first < p.minHistory || block.timestamp - first == 0) return 0;
        uint256 history = block.timestamp - first;
        uint256 expectedTermRevenue = (v.cumRevenue() * uint256(p.periods) * p.period) / history;
        uint256 maxOwed = (expectedTermRevenue * p.advanceBps) / 10_000;
        return (maxOwed * 10_000) / (10_000 + p.feeBps);
    }

    function borrow(bytes32 deviceId, uint256 principal) external {
        DeviceRegistry.Device memory d = registry.getDevice(deviceId);
        if (msg.sender != d.owner) revert NotDeviceOwner();
        if (blocked[deviceId]) revert DeviceBlocked();

        RevenueVault v = RevenueVault(d.vault);
        if (v.loanStatus() != RevenueVault.Status.None) revert ActiveLoan();

        Params memory p = params;
        if (d.lastReadingAt == 0 || block.timestamp - d.lastReadingAt > p.maxReadingAge) revert StaleReading();
        uint256 first = v.firstRevenueAt();
        if (first == 0 || block.timestamp - first < p.minHistory) revert NotEnoughHistory();

        uint256 max = maxPrincipal(deviceId);
        if (principal == 0 || principal > max) revert ExceedsAdvance(principal, max);
        if (principal > _cash()) revert NotEnoughLiquidity();

        uint256 fee = (principal * p.feeBps) / 10_000;
        totalPrincipalOutstanding += principal;
        v.openLoan(principal, fee, p.periods, p.period, p.grace, p.repayBps);
        IERC20(asset()).safeTransfer(d.owner, principal);
        emit Borrowed(deviceId, d.owner, principal, fee);
    }

    /// @dev Called by a device's vault after it has already transferred the tokens here.
    function onRepayment(bytes32 deviceId, uint256 principalPart, uint256 feePart) external {
        DeviceRegistry.Device memory d = registry.getDevice(deviceId);
        if (msg.sender != d.vault) revert NotVault();
        totalPrincipalOutstanding -= principalPart;
        emit Repayment(deviceId, principalPart, feePart);
    }

    /// @notice After a device has stayed in default long enough, lenders take the loss and the device is blocked.
    function writeOff(bytes32 deviceId) external {
        DeviceRegistry.Device memory d = registry.getDevice(deviceId);
        RevenueVault v = RevenueVault(d.vault);
        (RevenueVault.Status status,,,,,,,,,,, uint64 defaultedAt) = v.loan();
        if (status != RevenueVault.Status.Defaulted) revert NotDefaulted();
        if (block.timestamp < defaultedAt + params.writeOffDelay) revert TooEarly();

        uint256 lost = v.closeLoanAsLoss();
        totalPrincipalOutstanding -= lost;
        blocked[deviceId] = true;
        emit WrittenOff(deviceId, lost);
    }
}
