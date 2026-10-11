// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {RevenueVault} from "./RevenueVault.sol";

/// @notice Registers revenue-generating devices. Every device gets its own revenue vault
///         (deterministic address, so customers can be told where to pay before anything is deployed)
///         and a signing key whose readings prove the device is alive.
contract DeviceRegistry is EIP712 {
    struct Device {
        address owner;
        address signer;
        address vault;
        uint64 lastReadingAt;
        uint64 lastNonce;
        uint128 cumulativeUnits;
    }

    bytes32 private constant READING_TYPEHASH =
        keccak256("Reading(bytes32 deviceId,uint256 units,uint64 timestamp,uint64 nonce)");

    address public immutable vaultImplementation;
    address public immutable asset;
    address public immutable admin;
    address public pool; // set once, by admin

    mapping(bytes32 => Device) private _devices;

    event DeviceRegistered(bytes32 indexed deviceId, address indexed owner, address signer, address vault);
    event ReadingReported(bytes32 indexed deviceId, uint256 units, uint64 timestamp, uint64 nonce);
    event PoolSet(address pool);

    error AlreadyRegistered();
    error UnknownDevice();
    error BadSignature();
    error BadNonce();
    error BadTimestamp();
    error NotAdmin();
    error PoolAlreadySet();

    constructor(address asset_, address admin_) EIP712("DeviceRegistry", "1") {
        asset = asset_;
        admin = admin_;
        vaultImplementation = address(new RevenueVault());
    }

    function setPool(address pool_) external {
        if (msg.sender != admin) revert NotAdmin();
        if (pool != address(0)) revert PoolAlreadySet();
        pool = pool_;
        emit PoolSet(pool_);
    }

    function registerDevice(bytes32 deviceId, address signer) external returns (address vault) {
        if (_devices[deviceId].owner != address(0)) revert AlreadyRegistered();
        vault = Clones.cloneDeterministic(vaultImplementation, deviceId);
        RevenueVault(vault).initialize(msg.sender, deviceId, asset, address(this));
        _devices[deviceId] = Device({
            owner: msg.sender,
            signer: signer,
            vault: vault,
            lastReadingAt: 0,
            lastNonce: 0,
            cumulativeUnits: 0
        });
        emit DeviceRegistered(deviceId, msg.sender, signer, vault);
    }

    /// @notice Where customers should pay for this device, valid before and after registration.
    function predictVault(bytes32 deviceId) external view returns (address) {
        return Clones.predictDeterministicAddress(vaultImplementation, deviceId, address(this));
    }

    function getDevice(bytes32 deviceId) external view returns (Device memory d) {
        d = _devices[deviceId];
        if (d.owner == address(0)) revert UnknownDevice();
    }

    /// @notice Anyone may relay a reading; only the device's own key can produce a valid signature.
    function reportReading(bytes32 deviceId, uint256 units, uint64 timestamp, uint64 nonce, bytes calldata signature)
        external
    {
        Device storage d = _devices[deviceId];
        if (d.owner == address(0)) revert UnknownDevice();
        if (nonce <= d.lastNonce) revert BadNonce();
        if (timestamp > block.timestamp || timestamp <= d.lastReadingAt) revert BadTimestamp();

        bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(READING_TYPEHASH, deviceId, units, timestamp, nonce)));
        if (ECDSA.recover(digest, signature) != d.signer) revert BadSignature();

        d.lastNonce = nonce;
        d.lastReadingAt = timestamp;
        d.cumulativeUnits += uint128(units);
        emit ReadingReported(deviceId, units, timestamp, nonce);
    }

    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }
}
