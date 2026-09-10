// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title Minimal ERC-20 surface used by Recourse.
/// @notice Deliberately tiny. RecourseEscrow imports nothing it does not need,
///         so the whole contracts/ tree builds from a clean clone with no
///         submodule fetch and no package manager.
interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
    function decimals() external view returns (uint8);
}
