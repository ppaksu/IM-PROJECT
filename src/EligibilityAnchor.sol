// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title EligibilityAnchor
/// @notice Public commitments to each recipient bank's eligible-account registry.
/// @dev The contract stores Merkle roots and policy metadata only. It never stores
///      account numbers, customer records or KYC material, and it does not verify ZK
///      proofs: the sending bank's verifier API does that off-chain.
///
///      Every recipient bank keeps its own tree, so roots are namespaced by bank and
///      every epoch is kept. Verifiers need the history because a proof may be built
///      against epoch N while epoch N+1 is anchored mid-request; the grace window that
///      allows the previous epoch is policy, so it lives in the verifier, not here.
contract EligibilityAnchor {
    struct EligibilityAnchorData {
        bytes32 eligibilityRoot;
        bytes32 policyHash;
        bytes32 circuitId;
        bytes32 verifyingKeyHash;
        uint64 rootEpoch;
        uint64 validUntil;
        uint64 anchoredAt;
    }

    address public owner;

    mapping(bytes32 => mapping(uint64 => EligibilityAnchorData)) private _anchors;
    mapping(bytes32 => uint64) public latestEpoch;
    mapping(bytes32 => address) public issuerOf;

    error NotOwner();
    error NotIssuer();
    error InvalidAddress();
    error InvalidBankId();
    error InvalidRoot();
    error InvalidValidity();
    error UnexpectedRootEpoch(uint64 expected, uint64 provided);
    error NoAnchor();

    event IssuerUpdated(bytes32 indexed bankId, address indexed previousIssuer, address indexed newIssuer);
    event RootAnchored(
        bytes32 indexed bankId,
        uint64 indexed rootEpoch,
        bytes32 indexed eligibilityRoot,
        bytes32 policyHash,
        bytes32 circuitId,
        bytes32 verifyingKeyHash,
        uint64 validUntil
    );

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor() {
        owner = msg.sender;
    }

    /// @notice Registers or rotates the issuer allowed to anchor roots for one bank.
    /// @dev Demo governance. Production should require a multisig or an HSM-backed key.
    function setIssuer(bytes32 bankId, address newIssuer) external onlyOwner {
        if (bankId == bytes32(0)) revert InvalidBankId();
        if (newIssuer == address(0)) revert InvalidAddress();
        address previousIssuer = issuerOf[bankId];
        issuerOf[bankId] = newIssuer;
        emit IssuerUpdated(bankId, previousIssuer, newIssuer);
    }

    /// @notice Records the next registry root for one bank.
    /// @dev Epochs start at 1 and advance by exactly one, so the previous epoch is always
    ///      readable. Verifiers rely on that when they allow a proof built one epoch back.
    function anchorRoot(
        bytes32 bankId,
        bytes32 eligibilityRoot,
        bytes32 policyHash,
        bytes32 circuitId,
        bytes32 verifyingKeyHash,
        uint64 rootEpoch,
        uint64 validUntil
    ) external {
        if (bankId == bytes32(0)) revert InvalidBankId();
        if (msg.sender != issuerOf[bankId]) revert NotIssuer();
        if (
            eligibilityRoot == bytes32(0) || policyHash == bytes32(0) || circuitId == bytes32(0)
                || verifyingKeyHash == bytes32(0)
        ) revert InvalidRoot();

        uint64 expected = latestEpoch[bankId] + 1;
        if (rootEpoch != expected) revert UnexpectedRootEpoch(expected, rootEpoch);
        if (validUntil <= block.timestamp) revert InvalidValidity();

        _anchors[bankId][rootEpoch] = EligibilityAnchorData({
            eligibilityRoot: eligibilityRoot,
            policyHash: policyHash,
            circuitId: circuitId,
            verifyingKeyHash: verifyingKeyHash,
            rootEpoch: rootEpoch,
            validUntil: validUntil,
            anchoredAt: uint64(block.timestamp)
        });
        latestEpoch[bankId] = rootEpoch;

        emit RootAnchored(
            bankId, rootEpoch, eligibilityRoot, policyHash, circuitId, verifyingKeyHash, validUntil
        );
    }

    /// @notice Returns the most recent Anchor for a bank, expired or not.
    /// @dev Expiry and the grace window are the verifier's decision, so they are not
    ///      enforced here. Callers read validUntil and anchoredAt and apply their policy.
    function latestAnchor(bytes32 bankId) external view returns (EligibilityAnchorData memory) {
        return anchorOf(bankId, latestEpoch[bankId]);
    }

    /// @notice Returns the Anchor a bank recorded for one epoch.
    function anchorOf(bytes32 bankId, uint64 rootEpoch) public view returns (EligibilityAnchorData memory) {
        EligibilityAnchorData memory anchor = _anchors[bankId][rootEpoch];
        if (anchor.rootEpoch == 0) revert NoAnchor();
        return anchor;
    }
}
