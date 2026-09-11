// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {EligibilityAnchor} from "../src/EligibilityAnchor.sol";

contract EligibilityAnchorTest {
    EligibilityAnchor private anchor;

    address private constant ISSUER_B = address(0xBEEF);
    address private constant ISSUER_C = address(0xF00D);
    address private constant OTHER = address(0xCAFE);

    bytes32 private constant BANK_B = keccak256("bank-b");
    bytes32 private constant BANK_C = keccak256("bank-c");

    bytes32 private constant ROOT_1 = keccak256("eligible-root-1");
    bytes32 private constant ROOT_2 = keccak256("eligible-root-2");
    bytes32 private constant POLICY = keccak256("recipient-eligibility-v1");
    bytes32 private constant CIRCUIT = keccak256("eligible-account-v1");
    bytes32 private constant VK = keccak256("verifying-key-v1");

    function setUp() public {
        anchor = new EligibilityAnchor();
        anchor.setIssuer(BANK_B, ISSUER_B);
        anchor.setIssuer(BANK_C, ISSUER_C);
    }

    function anchorAs(address issuer, bytes32 bankId, bytes32 root, uint64 epoch, uint64 validFor) private {
        vm.prank(issuer);
        anchor.anchorRoot(bankId, root, POLICY, CIRCUIT, VK, epoch, uint64(block.timestamp + validFor));
    }

    function testIssuerCanAnchorRoot() public {
        anchorAs(ISSUER_B, BANK_B, ROOT_1, 1, 1 days);

        EligibilityAnchor.EligibilityAnchorData memory latest = anchor.latestAnchor(BANK_B);
        assert(latest.eligibilityRoot == ROOT_1);
        assert(latest.policyHash == POLICY);
        assert(latest.circuitId == CIRCUIT);
        assert(latest.verifyingKeyHash == VK);
        assert(latest.rootEpoch == 1);
        assert(latest.anchoredAt == uint64(block.timestamp));
        assert(anchor.latestEpoch(BANK_B) == 1);
    }

    function testUnregisteredBankCannotAnchor() public {
        vm.expectRevert(EligibilityAnchor.NotIssuer.selector);
        vm.prank(OTHER);
        anchor.anchorRoot(keccak256("bank-x"), ROOT_1, POLICY, CIRCUIT, VK, 1, uint64(block.timestamp + 1 days));
    }

    function testIssuerOfAnotherBankCannotAnchor() public {
        vm.expectRevert(EligibilityAnchor.NotIssuer.selector);
        vm.prank(ISSUER_C);
        anchor.anchorRoot(BANK_B, ROOT_1, POLICY, CIRCUIT, VK, 1, uint64(block.timestamp + 1 days));
    }

    function testFirstEpochMustBeOne() public {
        vm.expectRevert(
            abi.encodeWithSelector(EligibilityAnchor.UnexpectedRootEpoch.selector, uint64(1), uint64(2))
        );
        vm.prank(ISSUER_B);
        anchor.anchorRoot(BANK_B, ROOT_1, POLICY, CIRCUIT, VK, 2, uint64(block.timestamp + 1 days));
    }

    function testEpochMustAdvanceByExactlyOne() public {
        anchorAs(ISSUER_B, BANK_B, ROOT_1, 1, 1 days);

        // repeating the current epoch is rejected
        vm.expectRevert(
            abi.encodeWithSelector(EligibilityAnchor.UnexpectedRootEpoch.selector, uint64(2), uint64(1))
        );
        vm.prank(ISSUER_B);
        anchor.anchorRoot(BANK_B, ROOT_2, POLICY, CIRCUIT, VK, 1, uint64(block.timestamp + 1 days));

        // skipping an epoch is rejected, so the previous epoch is always readable
        vm.expectRevert(
            abi.encodeWithSelector(EligibilityAnchor.UnexpectedRootEpoch.selector, uint64(2), uint64(3))
        );
        vm.prank(ISSUER_B);
        anchor.anchorRoot(BANK_B, ROOT_2, POLICY, CIRCUIT, VK, 3, uint64(block.timestamp + 1 days));
    }

    function testPreviousEpochStaysReadable() public {
        anchorAs(ISSUER_B, BANK_B, ROOT_1, 1, 1 days);
        anchorAs(ISSUER_B, BANK_B, ROOT_2, 2, 2 days);

        EligibilityAnchor.EligibilityAnchorData memory previous = anchor.anchorOf(BANK_B, 1);
        assert(previous.eligibilityRoot == ROOT_1);

        EligibilityAnchor.EligibilityAnchorData memory latest = anchor.latestAnchor(BANK_B);
        assert(latest.eligibilityRoot == ROOT_2);
        assert(latest.rootEpoch == 2);
    }

    function testBanksAreIndependent() public {
        anchorAs(ISSUER_B, BANK_B, ROOT_1, 1, 1 days);
        anchorAs(ISSUER_B, BANK_B, ROOT_2, 2, 1 days);

        // bank C is untouched, so its own first root still has to be epoch 1
        assert(anchor.latestEpoch(BANK_C) == 0);
        anchorAs(ISSUER_C, BANK_C, ROOT_1, 1, 1 days);

        assert(anchor.latestAnchor(BANK_B).rootEpoch == 2);
        assert(anchor.latestAnchor(BANK_C).rootEpoch == 1);
    }

    function testExpiredValidityIsRejected() public {
        vm.expectRevert(EligibilityAnchor.InvalidValidity.selector);
        vm.prank(ISSUER_B);
        anchor.anchorRoot(BANK_B, ROOT_1, POLICY, CIRCUIT, VK, 1, uint64(block.timestamp));
    }

    function testEmptyMetadataIsRejected() public {
        vm.expectRevert(EligibilityAnchor.InvalidRoot.selector);
        vm.prank(ISSUER_B);
        anchor.anchorRoot(BANK_B, bytes32(0), POLICY, CIRCUIT, VK, 1, uint64(block.timestamp + 1 days));

        vm.expectRevert(EligibilityAnchor.InvalidRoot.selector);
        vm.prank(ISSUER_B);
        anchor.anchorRoot(BANK_B, ROOT_1, POLICY, CIRCUIT, bytes32(0), 1, uint64(block.timestamp + 1 days));
    }

    function testMissingAnchorReverts() public {
        vm.expectRevert(EligibilityAnchor.NoAnchor.selector);
        anchor.latestAnchor(BANK_B);

        anchorAs(ISSUER_B, BANK_B, ROOT_1, 1, 1 days);
        vm.expectRevert(EligibilityAnchor.NoAnchor.selector);
        anchor.anchorOf(BANK_B, 2);
    }

    function testExpiredAnchorIsStillReadable() public {
        anchorAs(ISSUER_B, BANK_B, ROOT_1, 1, 1 days);
        vm.warp(block.timestamp + 2 days);

        // expiry is the verifier's call, so the contract keeps serving the record
        EligibilityAnchor.EligibilityAnchorData memory latest = anchor.latestAnchor(BANK_B);
        assert(latest.eligibilityRoot == ROOT_1);
        assert(latest.validUntil < block.timestamp);
    }

    function testOwnerCanRotateIssuer() public {
        anchor.setIssuer(BANK_B, OTHER);

        vm.expectRevert(EligibilityAnchor.NotIssuer.selector);
        vm.prank(ISSUER_B);
        anchor.anchorRoot(BANK_B, ROOT_1, POLICY, CIRCUIT, VK, 1, uint64(block.timestamp + 1 days));

        anchorAs(OTHER, BANK_B, ROOT_1, 1, 1 days);
        assert(anchor.latestAnchor(BANK_B).eligibilityRoot == ROOT_1);
    }

    function testOnlyOwnerCanSetIssuer() public {
        vm.expectRevert(EligibilityAnchor.NotOwner.selector);
        vm.prank(OTHER);
        anchor.setIssuer(BANK_B, OTHER);
    }

    function testZeroBankIdIsRejected() public {
        vm.expectRevert(EligibilityAnchor.InvalidBankId.selector);
        anchor.setIssuer(bytes32(0), ISSUER_B);
    }

    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
}

interface Vm {
    function prank(address) external;
    function expectRevert(bytes4) external;
    function expectRevert(bytes calldata) external;
    function warp(uint256) external;
}
