include(FetchContent)
FetchContent_Declare(eigen
    URL https://gitlab.com/libeigen/eigen/-/archive/3.4.0/eigen-3.4.0.tar.gz
    URL_HASH SHA256=8586084f71f9bde545ee7fa6d00288b264a2b7ac3607b974e54d13e7162c1c72
    DOWNLOAD_EXTRACT_TIMESTAMP TRUE
    SOURCE_SUBDIR unused
)
FetchContent_MakeAvailable(eigen)

set(model_file "${CMAKE_CURRENT_BINARY_DIR}/yunet-landmarks.onnx")
file(DOWNLOAD
    https://media.githubusercontent.com/media/opencv/opencv_zoo/47534e27c9851bb1128ccc0102f1145e27f23f98/models/face_detection_yunet/face_detection_yunet_2026may.onnx
    "${model_file}"
    EXPECTED_HASH SHA256=ebafce4e3c118d6554634be5c27ab333b4c047a9a8c3faf1d7cf93101c22f0f0
    TLS_VERIFY ON
)
set(license_file "${CMAKE_CURRENT_BINARY_DIR}/yunet-LICENSE")
file(DOWNLOAD
    https://raw.githubusercontent.com/opencv/opencv_zoo/47534e27c9851bb1128ccc0102f1145e27f23f98/models/face_detection_yunet/LICENSE
    "${license_file}" TLS_VERIFY ON STATUS license_status
)
list(GET license_status 0 license_result)
if(NOT license_result EQUAL 0)
    message(FATAL_ERROR "Could not download YuNet license")
endif()
configure_file("${eigen_SOURCE_DIR}/COPYING.MPL2" "${CMAKE_CURRENT_BINARY_DIR}/eigen-LICENSE" COPYONLY)
install(FILES "${model_file}" "${license_file}" DESTINATION /usr/share/com.ticklab.biopass/models)
install(FILES "${CMAKE_CURRENT_BINARY_DIR}/eigen-LICENSE" DESTINATION /usr/share/doc/biopass)

add_library(biopass_alignment STATIC face_alignment.cc)
set_target_properties(biopass_alignment PROPERTIES POSITION_INDEPENDENT_CODE ON)
target_include_directories(biopass_alignment PUBLIC ${CMAKE_CURRENT_SOURCE_DIR})
target_include_directories(biopass_alignment SYSTEM PRIVATE ${eigen_SOURCE_DIR})
target_link_libraries(biopass_alignment PUBLIC biopass_onnx biopass_stb)
