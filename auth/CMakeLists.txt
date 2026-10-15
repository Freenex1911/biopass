cmake_minimum_required(VERSION 3.22)
# Resolve version from the environment (CI) or -DPROJECT_VERSION (Makefile),
# before project() clears the variable, otherwise fall back to a default.
if(DEFINED ENV{PROJECT_VERSION})
    set(BIOPASS_VERSION $ENV{PROJECT_VERSION})
elseif(PROJECT_VERSION)
    set(BIOPASS_VERSION ${PROJECT_VERSION})
else()
    set(BIOPASS_VERSION 0.1.0)
endif()

project(biopass)
set(PROJECT_VERSION ${BIOPASS_VERSION})
message(STATUS "Project version: ${PROJECT_VERSION}")

# Require C++17
set(CMAKE_CXX_STANDARD          17)
set(CMAKE_CXX_STANDARD_REQUIRED YES)

# No CMake install RUNPATH: whenever it is longer than the build RUNPATH, CMake
# pads the build RUNPATH with ':' placeholders, i.e. empty entries, which the
# loader treats as the current directory -- here the caller's directory of a
# root PAM helper. /usr/lib/biopass is added as a linker flag below instead,
# and biopass_clean_runpath() removes any empty entry CMake still emits.
set(CMAKE_INSTALL_RPATH_USE_LINK_PATH FALSE)
set(CMAKE_BUILD_WITH_INSTALL_RPATH FALSE)
set(CMAKE_SKIP_BUILD_RPATH FALSE)
# The packages ship the build-tree binaries as-is. Keep their RUNPATH relative
# ($ORIGIN) instead of pointing at the absolute, user-writable build directory
# (loaded as root by PAM).
set(CMAKE_BUILD_RPATH_USE_ORIGIN TRUE)
# Installed copies find their private libraries in /usr/lib/biopass, so the
# package needs no global ld.so.conf entry (which would shadow the
# distribution's libcamera). Passed as a link item rather than through
# CMAKE_BUILD_RPATH so it follows the $ORIGIN entries and build-tree binaries
# keep using the build tree.
link_libraries("-Wl,-rpath,/usr/lib/biopass")
# Strips empty RUNPATH entries from the binaries the packages ship; called in
# the directory that defines each target.
set(BIOPASS_CLEAN_RUNPATH_SCRIPT "${CMAKE_CURRENT_SOURCE_DIR}/CleanRunpath.cmake")
function(biopass_clean_runpath)
  foreach(target IN LISTS ARGN)
    add_custom_command(TARGET ${target} POST_BUILD
      COMMAND ${CMAKE_COMMAND} -DFILE=$<TARGET_FILE:${target}> -P ${BIOPASS_CLEAN_RUNPATH_SCRIPT}
      VERBATIM)
  endforeach()
endfunction()
# Dependencies Configuration
include(Dependencies.cmake)

# Export Face Includes dynamically from Source
set(FaceDetection_INCLUDE_DIRS ${CMAKE_CURRENT_SOURCE_DIR}/face/detection)
set(FaceRecognition_INCLUDE_DIRS ${CMAKE_CURRENT_SOURCE_DIR}/face/recognition)
set(FaceAntiSpoof_INCLUDE_DIRS ${CMAKE_CURRENT_SOURCE_DIR}/face/antispoofing)

# Application Directories
add_subdirectory(core)
add_subdirectory(face)
add_subdirectory(fingerprint)
add_subdirectory(pam)

# Testing Directories
option(BUILD_TESTS "Build test configurations" OFF)
if(BUILD_TESTS)
    enable_testing()
    add_subdirectory(test/backend)
    add_subdirectory(test/camera_selection)
    add_subdirectory(test/camera)
    add_subdirectory(test/face_engine)
endif()

install(
    TARGETS biopass_det biopass_reg biopass_as
    COMPONENT applications
    RUNTIME DESTINATION "/usr/bin"
    LIBRARY DESTINATION "/usr/lib/biopass"
)
install(
    TARGETS biopass_pam
    LIBRARY DESTINATION "/lib/security"
)

# Install ONNX Runtime libraries
install(
    DIRECTORY ${ONNXRUNTIME_LIB_DIR}/
    DESTINATION "/usr/lib/biopass"
    FILES_MATCHING PATTERN "*.so*"
)
