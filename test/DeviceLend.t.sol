// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test, Vm} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {DeviceRegistry} from "../src/DeviceRegistry.sol";
import {RevenueVault} from "../src/RevenueVault.sol";
import {LoanPool} from "../src/LoanPool.sol";

contract MockUSD is ERC20 {
    constructor() ERC20("Mock USD", "mUSD") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amt) external {
        _mint(to, amt);
    }
}

contract DeviceLendTest is Test {
    MockUSD usd;
    DeviceRegistry registry;
    LoanPool pool;

    address admin = makeAddr("admin");
    address lender = makeAddr("lender");
    address operator = makeAddr("operator");
    address customer = makeAddr("customer");

    uint256 deviceKey = 0xA11CE;
    address deviceSigner;
    bytes32 constant ID = keccak256("solar-unit-001");
    RevenueVault vault;
    uint64 nonce;

    function setUp() public {
        deviceSigner = vm.addr(deviceKey);
        usd = new MockUSD();
        vm.startPrank(admin);
        registry = new DeviceRegistry(address(usd), admin);
        pool = new LoanPool(
            usd,
            registry,
            admin,
            LoanPool.Params({
                advanceBps: 5000,
                repayBps: 5000,
                feeBps: 1000,
                periods: 4,
                period: 7 days,
                grace: 2 days,
                minHistory: 7 days,
                maxReadingAge: 1 days,
                writeOffDelay: 30 days
            })
        );
        registry.setPool(address(pool));
        vm.stopPrank();

        usd.mint(lender, 100_000e6);
        vm.startPrank(lender);
        usd.approve(address(pool), type(uint256).max);
        pool.deposit(100_000e6, lender);
        vm.stopPrank();

        vm.prank(operator);
        vault = RevenueVault(registry.registerDevice(ID, deviceSigner));
    }

    // ------------------------------------------------------------ helpers

    function _reading() internal {
        nonce++;
        uint64 ts = uint64(block.timestamp);
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256("Reading(bytes32 deviceId,uint256 units,uint64 timestamp,uint64 nonce)"), ID, 10e3, ts, nonce
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", registry.domainSeparator(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(deviceKey, digest);
        registry.reportReading(ID, 10e3, ts, nonce, abi.encodePacked(r, s, v));
    }

    function _fund(uint256 amt) internal {
        usd.mint(customer, amt);
        vm.prank(customer);
        usd.transfer(address(vault), amt);
    }

    function _pay(uint256 amt) internal {
        _fund(amt);
        vault.settle();
    }

    /// Finds the last LockStateChanged emitted by the vault in the recorded logs.
    function _lastLockEvent() internal returns (bool found, bool locked, uint64 lockNonce) {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 sig = keccak256("LockStateChanged(bytes32,bool,uint64)");
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter == address(vault) && logs[i].topics[0] == sig) {
                (locked, lockNonce) = abi.decode(logs[i].data, (bool, uint64));
                found = true;
            }
        }
    }

    /// 8 days of 100 USD/day revenue so the device qualifies for a loan.
    function _buildHistory() internal {
        _pay(100e6);
        for (uint256 i = 0; i < 8; i++) {
            skip(1 days);
            _pay(100e6);
        }
        _reading();
    }

    function _borrowMax() internal returns (uint256 principal) {
        principal = pool.maxPrincipal(ID);
        vm.prank(operator);
        pool.borrow(ID, principal);
    }

    // ------------------------------------------------------------ registry

    function test_vaultAddressIsPredictable() public view {
        assertEq(registry.predictVault(ID), address(vault));
    }

    function test_readingRejectsWrongSignerAndReplay() public {
        nonce++;
        uint64 ts = uint64(block.timestamp);
        bytes32 structHash = keccak256(
            abi.encode(keccak256("Reading(bytes32 deviceId,uint256 units,uint64 timestamp,uint64 nonce)"), ID, 1, ts, nonce)
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", registry.domainSeparator(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(0xBAD, digest);
        vm.expectRevert(DeviceRegistry.BadSignature.selector);
        registry.reportReading(ID, 1, ts, nonce, abi.encodePacked(r, s, v));

        nonce--;
        _reading();
        // replaying the same nonce fails
        vm.expectRevert(DeviceRegistry.BadNonce.selector);
        registry.reportReading(ID, 1, ts, 1, hex"");
    }

    // ------------------------------------------------------------ happy path

    function test_noLoan_operatorGetsEverything() public {
        _pay(50e6);
        assertEq(usd.balanceOf(operator), 50e6);
        assertEq(usd.balanceOf(address(vault)), 0);
    }

    function test_borrowRequiresHistoryAndFreshReading() public {
        vm.prank(operator);
        vm.expectRevert(LoanPool.StaleReading.selector);
        pool.borrow(ID, 1e6);

        _reading();
        vm.prank(operator);
        vm.expectRevert(LoanPool.NotEnoughHistory.selector);
        pool.borrow(ID, 1e6);
    }

    function test_borrowCapIsEnforced() public {
        _buildHistory();
        uint256 max = pool.maxPrincipal(ID);
        assertGt(max, 0);
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(LoanPool.ExceedsAdvance.selector, max + 1, max));
        pool.borrow(ID, max + 1);
    }

    function test_onlyOwnerBorrows() public {
        _buildHistory();
        vm.prank(customer);
        vm.expectRevert(LoanPool.NotDeviceOwner.selector);
        pool.borrow(ID, 1e6);
    }

    function test_repaymentFlowsAutomatically() public {
        _buildHistory();
        uint256 principal = _borrowMax();
        uint256 owedTotal = vault.owed();
        assertGt(owedTotal, principal); // fee on top
        uint256 opBefore = usd.balanceOf(operator);

        // 100 USD/day, 50% goes to the lender -> loan clears within a few payments
        for (uint256 i = 0; i < 40 && vault.owed() > 0; i++) {
            skip(1 days);
            _reading();
            _pay(100e6);
        }
        assertEq(vault.owed(), 0);
        assertEq(uint8(vault.loanStatus()), uint8(RevenueVault.Status.None));
        assertEq(pool.totalPrincipalOutstanding(), 0);
        assertGt(usd.balanceOf(operator), opBefore); // operator kept the other half

        // lenders earned the fee
        assertGt(pool.totalAssets(), 100_000e6);
    }

    function test_secondLoanBlockedWhileActive() public {
        _buildHistory();
        _borrowMax();
        vm.prank(operator);
        vm.expectRevert(LoanPool.ActiveLoan.selector);
        pool.borrow(ID, 1e6);
    }

    // ------------------------------------------------------------ default path

    function test_missedPayments_defaultLockAndCure() public {
        _buildHistory();
        _borrowMax();

        // nothing paid: before grace it is not default
        skip(7 days + 1 days);
        assertFalse(vault.isBehind());
        vm.expectRevert(RevenueVault.NotBehind.selector);
        vault.markDefault();

        // after period + grace without paying, anyone can flag it
        skip(2 days);
        assertTrue(vault.isBehind());
        vm.recordLogs();
        vault.markDefault();
        (bool found, bool locked, uint64 n) = _lastLockEvent();
        assertTrue(found && locked);
        assertEq(n, 1);
        assertEq(uint8(vault.loanStatus()), uint8(RevenueVault.Status.Defaulted));

        // while defaulted 100% of revenue goes to the lender
        uint256 opBefore = usd.balanceOf(operator);
        uint256 poolBefore = usd.balanceOf(address(pool));
        _pay(10e6);
        assertEq(usd.balanceOf(operator), opBefore);
        assertEq(usd.balanceOf(address(pool)), poolBefore + 10e6);

        // paying off the arrears cures the default and unlocks
        uint256 arrears = vault.requiredPaid(block.timestamp) - _paid();
        _fund(arrears);
        vm.recordLogs();
        vault.settle();
        (found, locked, n) = _lastLockEvent();
        assertTrue(found && !locked);
        assertEq(n, 2);
        assertEq(uint8(vault.loanStatus()), uint8(RevenueVault.Status.Active));
    }

    function test_writeOff_lpsTakeLoss_deviceBlocked() public {
        _buildHistory();
        uint256 principal = _borrowMax();
        uint256 assetsBefore = pool.totalAssets();

        skip(10 days);
        vault.markDefault();

        vm.expectRevert(LoanPool.TooEarly.selector);
        pool.writeOff(ID);

        skip(30 days);
        pool.writeOff(ID);
        assertEq(pool.totalAssets(), assetsBefore - principal);
        assertTrue(pool.blocked(ID));

        vm.prank(operator);
        vm.expectRevert(LoanPool.DeviceBlocked.selector);
        pool.borrow(ID, 1e6);
    }

    // ------------------------------------------------------------ safety

    function test_onlyPoolOpensLoans() public {
        vm.expectRevert(RevenueVault.NotPool.selector);
        vault.openLoan(1, 0, 1, 1 days, 0, 5000);
    }

    function test_withdrawLimitedByCash() public {
        _buildHistory();
        _borrowMax();
        uint256 cash = usd.balanceOf(address(pool));
        assertEq(pool.maxWithdraw(lender), cash);
    }

    function _paid() internal view returns (uint256 p) {
        (,,,,,,,,,, p,) = vault.loan();
    }
}
