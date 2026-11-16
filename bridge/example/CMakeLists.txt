cmake_minimum_required(VERSION 3.13)
project(RoninBridgeExample LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 14)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# DJIR_SDK is expected next to this repository, not vendored inside it.
set(DJIR_SDK_DIR "${CMAKE_CURRENT_SOURCE_DIR}/../../../DJIR_SDK"
    CACHE PATH "Path to a built DJIR_SDK checkout")

if(NOT EXISTS "${DJIR_SDK_DIR}/CMakeLists.txt")
  message(FATAL_ERROR
    "DJIR_SDK not found at ${DJIR_SDK_DIR}.\n"
    "Clone it there, or pass -DDJIR_SDK_DIR=<path>.")
endif()

add_subdirectory("${DJIR_SDK_DIR}" "${CMAKE_CURRENT_BINARY_DIR}/DJIR_SDK")

add_executable(ronin-bridge-example src/main.cpp)
target_link_libraries(ronin-bridge-example PRIVATE DJIR_SDK)
