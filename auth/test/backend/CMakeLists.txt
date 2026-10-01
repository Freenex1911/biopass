add_executable(helper_process_test helper_process.cpp)
target_include_directories(helper_process_test PRIVATE ${CMAKE_SOURCE_DIR}/pam)
add_test(NAME helper_process COMMAND helper_process_test)

add_executable(config_contract_test config_contract.cpp)
target_link_libraries(config_contract_test PRIVATE biopass_core)
foreach(case legacy color-only fixed-ir)
    add_test(NAME config_contract_${case} COMMAND config_contract_test ${CMAKE_SOURCE_DIR}/../tests/config-contract/${case}.json)
endforeach()

add_executable(embedding_cache_test embedding_cache.cpp)
target_link_libraries(embedding_cache_test PRIVATE biopass_face)
set(BIOPASS_TEST_MODEL_DIR "${CMAKE_SOURCE_DIR}/face/models" CACHE PATH "Directory containing real ONNX models for inference tests")
target_compile_definitions(embedding_cache_test PRIVATE MODEL_DIR="${BIOPASS_TEST_MODEL_DIR}")
add_test(NAME embedding_cache COMMAND embedding_cache_test)

add_executable(auth_cancellation_test auth_cancellation.cpp)
target_link_libraries(auth_cancellation_test PRIVATE biopass_core)
add_test(NAME auth_cancellation COMMAND auth_cancellation_test)
