# ==============================================================================
# Dependency Management
# ==============================================================================

# ONNX Runtime
set(ONNXRUNTIME_VERSION "1.30.0")
include(FetchContent)

if(CMAKE_SYSTEM_PROCESSOR MATCHES "aarch64|arm64|ARM64")
    set(ONNXRUNTIME_ARCH "linux-aarch64")
    set(ONNXRUNTIME_SHA256 "e16a27a8ed330bbc698df7330b0cf56e722f354e3bcc92118682c74ef3c3e3da")
else()
    set(ONNXRUNTIME_ARCH "linux-x64")
    set(ONNXRUNTIME_SHA256 "a5ed5a3cac51fbb2e90da632ae43d19212faaa20e76484e62bcb7c23ddb3b3fd")
endif()

FetchContent_Declare(
    onnxruntime
    SOURCE_DIR "${CMAKE_BINARY_DIR}/_deps/onnxruntime-${ONNXRUNTIME_VERSION}"
    URL https://github.com/microsoft/onnxruntime/releases/download/v${ONNXRUNTIME_VERSION}/onnxruntime-${ONNXRUNTIME_ARCH}-${ONNXRUNTIME_VERSION}.tgz
    URL_HASH SHA256=${ONNXRUNTIME_SHA256}
    DOWNLOAD_EXTRACT_TIMESTAMP TRUE
)
FetchContent_MakeAvailable(onnxruntime)

set(ONNXRUNTIME_ROOT "${onnxruntime_SOURCE_DIR}")
set(ONNXRUNTIME_INCLUDE_DIRS "${ONNXRUNTIME_ROOT}/include")
set(ONNXRUNTIME_LIB_DIR "${ONNXRUNTIME_ROOT}/lib")
set(ONNXRUNTIME_LIB "${ONNXRUNTIME_LIB_DIR}/libonnxruntime.so")
# Stable packaging paths avoid duplicating the runtime version in Tauri config.
file(MAKE_DIRECTORY "${CMAKE_BINARY_DIR}/onnxruntime-bundle")
configure_file("${ONNXRUNTIME_LIB_DIR}/libonnxruntime.so.1"
    "${CMAKE_BINARY_DIR}/onnxruntime-bundle/libonnxruntime.so.1" COPYONLY)
configure_file("${ONNXRUNTIME_LIB_DIR}/libonnxruntime_providers_shared.so"
    "${CMAKE_BINARY_DIR}/onnxruntime-bundle/libonnxruntime_providers_shared.so" COPYONLY)

# libturbojpeg (system package via pkg-config; stable soname)
find_package(PkgConfig REQUIRED)
pkg_check_modules(TURBOJPEG REQUIRED IMPORTED_TARGET libturbojpeg)

# libcamera (camera capture) is built from source at a pinned version and
# bundled into the package instead of linked against the system's copy -- see
# BundleLibcamera.cmake for why. Provides the `libcamera_bundled` target.
include(${CMAKE_CURRENT_LIST_DIR}/BundleLibcamera.cmake)

FetchContent_Declare(
    stb
    GIT_REPOSITORY https://github.com/nothings/stb.git
    GIT_TAG        904aa67e1e2d1dec92959df63e700b166d5c1022
)
FetchContent_MakeAvailable(stb)
set(STB_INCLUDE_DIRS "${stb_SOURCE_DIR}")

# yaml-cpp for config parsing
set(YAML_BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)
set(YAML_CPP_BUILD_CONTRIB OFF CACHE BOOL "" FORCE)
set(YAML_CPP_BUILD_TOOLS OFF CACHE BOOL "" FORCE)
set(YAML_CPP_BUILD_TESTS OFF CACHE BOOL "" FORCE)
set(YAML_CPP_INSTALL OFF CACHE BOOL "" FORCE)
FetchContent_Declare(
    yaml-cpp
    GIT_REPOSITORY https://github.com/jbeder/yaml-cpp.git
    GIT_TAG        yaml-cpp-0.9.0
)
FetchContent_MakeAvailable(yaml-cpp)

# CLI11 for command line parsing
find_package(CLI11 REQUIRED)

# spdlog for logging
FetchContent_Declare(
    spdlog
    GIT_REPOSITORY https://github.com/gabime/spdlog.git
    GIT_TAG v1.13.0
)
FetchContent_MakeAvailable(spdlog)

# sqlite3 (amalgamation, vendored) for read-only access to biopass.db (model
# registry) from the PAM helper. Pinned by hash rather than depending on the
# distro's sqlite3, consistent with the yaml-cpp/spdlog/onnxruntime pinning
# above -- this runs inside a security-sensitive PAM module.
set(SQLITE3_VERSION "3460100")
FetchContent_Declare(
    sqlite3_amalgamation
    URL https://www.sqlite.org/2024/sqlite-amalgamation-${SQLITE3_VERSION}.zip
    URL_HASH SHA256=77823cb110929c2bcb0f5d48e4833b5c59a8a6e40cdea3936b99e199dbbe5784
    DOWNLOAD_EXTRACT_TIMESTAMP TRUE
)
FetchContent_MakeAvailable(sqlite3_amalgamation)

add_library(sqlite3 STATIC ${sqlite3_amalgamation_SOURCE_DIR}/sqlite3.c)
target_include_directories(sqlite3 PUBLIC ${sqlite3_amalgamation_SOURCE_DIR})
set_target_properties(sqlite3 PROPERTIES POSITION_INDEPENDENT_CODE ON)
target_compile_definitions(sqlite3 PUBLIC
    SQLITE_OMIT_LOAD_EXTENSION
    SQLITE_THREADSAFE=1
    SQLITE_DQS=0
)
