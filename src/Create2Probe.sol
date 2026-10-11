// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// Minimal probe: does CREATE2 deploy to the predicted address on this chain?
contract Dummy {
    uint256 public immutable tag;
    constructor(uint256 t) { tag = t; }
}

contract Create2Probe {
    function predict(bytes32 salt, uint256 tag) public view returns (address) {
        bytes memory code = abi.encodePacked(type(Dummy).creationCode, abi.encode(tag));
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), salt, keccak256(code))))));
    }

    function deploy(bytes32 salt, uint256 tag) external returns (address d) {
        d = address(new Dummy{salt: salt}(tag));
        require(d == predict(salt, tag), "mismatch");
    }
}
