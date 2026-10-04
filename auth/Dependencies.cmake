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
    GIT_TAG v1.17.0
)
FetchContent_MakeAvailable(spdlog)

# sqlite3 (amalgamation, vendored) for read-only access to biopass.db (model
# registry) from the PAM helper. Pinned by hash rather than depending on the
# distro's sqlite3, consistent with the yaml-cpp/spdlog/onnxruntime pinning
# above -- this runs inside a security-sensitive PAM module.
set(SQLITE3_VERSION "3530400")
FetchContent_Declare(
    sqlite3_amalgamation
    URL https://www.sqlite.org/2026/sqlite-amalgamation-${SQLITE3_VERSION}.zip
    URL_HASH SHA256=1e71ddf93849c6a6ecf58b827c0692073d2dd7ee40196158068f7b29f422e87d
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

# Only the image processing modules are needed; inference stays in ONNX Runtime.
set(_biopass_build_tests "${BUILD_TESTS}")
set(BUILD_LIST "core,imgproc" CACHE STRING "" FORCE)
set(BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)
foreach(option BUILD_TESTS BUILD_PERF_TESTS BUILD_EXAMPLES BUILD_opencv_apps
    BUILD_DOCS WITH_IPP WITH_OPENCL WITH_TBB WITH_OPENMP WITH_ITT)
    set(${option} OFF CACHE BOOL "" FORCE)
endforeach()
FetchContent_Declare(opencv
    URL https://github.com/opencv/opencv/archive/refs/tags/5.0.0.tar.gz
    URL_HASH SHA256=b0528f5a1d379d59d4701cb28c36e22214cc51cf64594e5b56f2d3e6c0233095
    DOWNLOAD_EXTRACT_TIMESTAMP TRUE)
FetchContent_MakeAvailable(opencv)
# This option name is shared with BioPass: restore the caller's choice.
set(BUILD_TESTS "${_biopass_build_tests}" CACHE BOOL "Build BioPass tests" FORCE)
# OpenCV sets this legacy global output path; keep BioPass helper paths stable.
unset(EXECUTABLE_OUTPUT_PATH CACHE)
unset(EXECUTABLE_OUTPUT_PATH)
set_target_properties(opencv_core opencv_imgproc PROPERTIES POSITION_INDEPENDENT_CODE ON)
set(UNIT_TEST OFF CACHE BOOL "" FORCE)
set(CMAKE_DISABLE_FIND_PACKAGE_JPEG TRUE)
set(JPEG_FOUND FALSE)
FetchContent_Declare(libyuv
    GIT_REPOSITORY https://chromium.googlesource.com/libyuv/libyuv
    GIT_TAG aa6cedb39c87910b4c28e5c71c2121fc45fd234b)
FetchContent_MakeAvailable(libyuv)
set_target_properties(yuv yuv_common_objects PROPERTIES POSITION_INDEPENDENT_CODE ON)
target_include_directories(yuv SYSTEM INTERFACE ${libyuv_SOURCE_DIR}/include)

configure_file("${opencv_SOURCE_DIR}/LICENSE" "${CMAKE_BINARY_DIR}/opencv-LICENSE" COPYONLY)
configure_file("${libyuv_SOURCE_DIR}/LICENSE" "${CMAKE_BINARY_DIR}/libyuv-LICENSE" COPYONLY)
install(FILES "${CMAKE_BINARY_DIR}/opencv-LICENSE" "${CMAKE_BINARY_DIR}/libyuv-LICENSE"
    DESTINATION /usr/share/doc/biopass)
