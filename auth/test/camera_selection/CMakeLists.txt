add_executable(camera_selection_test main.cpp)
target_include_directories(camera_selection_test PRIVATE ${CMAKE_SOURCE_DIR}/core)
add_test(NAME camera_selection COMMAND camera_selection_test)
