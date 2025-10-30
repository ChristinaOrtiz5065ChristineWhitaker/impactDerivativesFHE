pragma solidity ^0.8.24;

import { FHE, euint32, ebool } from "@fhevm/solidity/lib/FHE.sol";
import { SepoliaConfig } from "@fhevm/solidity/config/ZamaConfig.sol";

contract ImpactDerivativesFHE is SepoliaConfig {
    using FHE for euint32;
    using FHE for ebool;

    error NotOwner();
    error NotProvider();
    error Paused();
    error CooldownActive();
    error InvalidBatchState();
    error ReplayAttempt();
    error StateMismatch();
    error InvalidProof();
    error AlreadyInitialized();
    error NotInitialized();
    error InvalidParameter();

    address public owner;
    mapping(address => bool) public isProvider;
    bool public paused;
    uint256 public cooldownSeconds;
    mapping(address => uint256) public lastSubmissionTime;
    mapping(address => uint256) public lastDecryptionRequestTime;

    struct Batch {
        bool isOpen;
        uint256 impactValueSum; // Placeholder for aggregated data
        uint256 count; // Placeholder for count of items in batch
    }
    mapping(uint256 => Batch) public batches;
    uint256 public currentBatchId;

    struct DecryptionContext {
        uint256 batchId;
        bytes32 stateHash;
        bool processed;
    }
    mapping(uint256 => DecryptionContext) public decryptionContexts;

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event ProviderAdded(address indexed provider);
    event ProviderRemoved(address indexed provider);
    event PausedSet(bool paused);
    event CooldownSecondsSet(uint256 oldCooldown, uint256 newCooldown);
    event BatchOpened(uint256 indexed batchId);
    event BatchClosed(uint256 indexed batchId);
    event DataSubmitted(address indexed provider, uint256 indexed batchId, bytes32 encryptedData);
    event DecryptionRequested(uint256 indexed requestId, uint256 indexed batchId);
    event DecryptionCompleted(uint256 indexed requestId, uint256 indexed batchId, uint256 decryptedValue);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyProvider() {
        if (!isProvider[msg.sender]) revert NotProvider();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert Paused();
        _;
    }

    constructor() {
        owner = msg.sender;
        isProvider[owner] = true;
        cooldownSeconds = 60; // Default cooldown
        currentBatchId = 1; // Start with batch ID 1
        _openBatch(currentBatchId);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    function addProvider(address provider) external onlyOwner {
        if (!isProvider[provider]) {
            isProvider[provider] = true;
            emit ProviderAdded(provider);
        }
    }

    function removeProvider(address provider) external onlyOwner {
        if (isProvider[provider]) {
            isProvider[provider] = false;
            emit ProviderRemoved(provider);
        }
    }

    function setPaused(bool _paused) external onlyOwner {
        paused = _paused;
        emit PausedSet(_paused);
    }

    function setCooldownSeconds(uint256 _cooldownSeconds) external onlyOwner {
        if (_cooldownSeconds == 0) revert InvalidParameter();
        emit CooldownSecondsSet(cooldownSeconds, _cooldownSeconds);
        cooldownSeconds = _cooldownSeconds;
    }

    function openNewBatch() external onlyOwner whenNotPaused {
        _closeBatch(currentBatchId);
        currentBatchId++;
        _openBatch(currentBatchId);
    }

    function _openBatch(uint256 batchId) private {
        if (batches[batchId].isOpen) revert InvalidBatchState();
        batches[batchId].isOpen = true;
        batches[batchId].impactValueSum = 0;
        batches[batchId].count = 0;
        emit BatchOpened(batchId);
    }

    function _closeBatch(uint256 batchId) private {
        if (!batches[batchId].isOpen) revert InvalidBatchState();
        batches[batchId].isOpen = false;
        emit BatchClosed(batchId);
    }

    function submitEncryptedImpactData(bytes32 encryptedImpactValue) external onlyProvider whenNotPaused {
        if (block.timestamp < lastSubmissionTime[msg.sender] + cooldownSeconds) {
            revert CooldownActive();
        }
        lastSubmissionTime[msg.sender] = block.timestamp;

        if (!batches[currentBatchId].isOpen) revert InvalidBatchState();

        // Store encrypted data. For this example, we just store the hash of the ciphertext.
        // In a real DEX, this would be part of a more complex order matching or aggregation logic.
        // The actual euint32 would be used in FHE operations.
        batches[currentBatchId].count++;
        emit DataSubmitted(msg.sender, currentBatchId, encryptedImpactValue);

        // Example: If we were to use the euint32 directly, it would be initialized here.
        // euint32 memory impactValue = FHE.asEuint32(encryptedImpactValue);
        // require(FHE.isInitialized(impactValue), "Not initialized");
    }

    function requestBatchDecryption() external onlyOwner whenNotPaused {
        if (block.timestamp < lastDecryptionRequestTime[msg.sender] + cooldownSeconds) {
            revert CooldownActive();
        }
        lastDecryptionRequestTime[msg.sender] = block.timestamp;

        if (batches[currentBatchId].isOpen) revert InvalidBatchState(); // Batch must be closed

        // For this example, we'll "decrypt" a simple aggregated value.
        // In a real DEX, this would be the result of complex FHE computations on orders.
        // We simulate having one euint32 to decrypt.
        euint32 memory aggregatedValue = FHE.asEuint32(keccak256(abi.encodePacked(batches[currentBatchId].impactValueSum))); // Placeholder
        _initIfNeeded(aggregatedValue);

        bytes32[] memory cts = new bytes32[](1);
        cts[0] = FHE.toBytes32(aggregatedValue);

        bytes32 stateHash = _hashCiphertexts(cts);
        uint256 requestId = FHE.requestDecryption(cts, this.myCallback.selector);

        decryptionContexts[requestId] = DecryptionContext({
            batchId: currentBatchId,
            stateHash: stateHash,
            processed: false
        });

        emit DecryptionRequested(requestId, currentBatchId);
    }

    function myCallback(uint256 requestId, bytes memory cleartexts, bytes memory proof) public {
        // @dev Replay protection: ensure this callback hasn't been processed for this requestId
        if (decryptionContexts[requestId].processed) revert ReplayAttempt();

        // @dev State verification: ensure the contract state relevant to the ciphertexts
        // hasn't changed since the decryption was requested. This is crucial for consistency.
        // Rebuild the cts array in the exact same order as in requestBatchDecryption.
        euint32 memory aggregatedValue = FHE.asEuint32(keccak256(abi.encodePacked(batches[decryptionContexts[requestId].batchId].impactValueSum))); // Placeholder
        _initIfNeeded(aggregatedValue);
        bytes32[] memory currentCts = new bytes32[](1);
        currentCts[0] = FHE.toBytes32(aggregatedValue);
        bytes32 currentStateHash = _hashCiphertexts(currentCts);

        if (currentStateHash != decryptionContexts[requestId].stateHash) {
            revert StateMismatch();
        }

        // @dev Proof verification: ensure the decryption proof is valid for the given requestId and cleartexts
        if (!FHE.checkSignatures(requestId, cleartexts, proof)) {
            revert InvalidProof();
        }

        // Decode cleartexts in the same order they were provided to requestDecryption
        // For this example, we expect one uint256 value
        uint256 decryptedValue = abi.decode(cleartexts, (uint256));

        decryptionContexts[requestId].processed = true;
        emit DecryptionCompleted(requestId, decryptionContexts[requestId].batchId, decryptedValue);
    }

    function _hashCiphertexts(bytes32[] memory cts) internal pure returns (bytes32) {
        return keccak256(abi.encode(cts, address(this)));
    }

    function _initIfNeeded(euint32 s) internal {
        if (FHE.isInitialized(s)) revert AlreadyInitialized();
        // In a real scenario, you might initialize with a specific value or zero.
        // For this example, we assume it's already initialized or doesn't need explicit init here.
        // If it needs init, you'd do something like:
        // s = FHE.asEuint32(FHE.encrypt(0, FHE.PUBLIC_KEY)); // Example, not actual FHE.encrypt
    }

    function _requireInitialized(euint32 s) internal view {
        if (!FHE.isInitialized(s)) revert NotInitialized();
    }
}