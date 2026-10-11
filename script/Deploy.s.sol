// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {DeviceRegistry} from "../src/DeviceRegistry.sol";
import {LoanPool} from "../src/LoanPool.sol";

/// Testnet deploy. Short timings on purpose so a demo can show repay + default in minutes.
contract Deploy is Script {
    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address asset = vm.envAddress("ASSET");
        address deployer = vm.addr(pk);

        vm.startBroadcast(pk);
        DeviceRegistry registry = new DeviceRegistry(asset, deployer);
        LoanPool pool = new LoanPool(
            IERC20(asset),
            registry,
            deployer,
            LoanPool.Params({
                advanceBps: 5000,
                repayBps: 7000,
                feeBps: 300,
                periods: 4,
                period: 120, // 2 minutes per "week" for the demo
                grace: 60,
                minHistory: 60,
                maxReadingAge: 1 hours,
                writeOffDelay: 1 hours
            })
        );
        registry.setPool(address(pool));
        vm.stopBroadcast();

        console.log("asset", asset);
        console.log("registry", address(registry));
        console.log("pool", address(pool));
    }
}
