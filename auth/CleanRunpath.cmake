# Removes empty entries from a linked binary's RUNPATH (run as a POST_BUILD
# step, see biopass_clean_runpath() in CMakeLists.txt). The dynamic loader
# treats an empty entry as the current directory; for the PAM helper that is
# the directory of whoever runs sudo, while the helper runs as root.
#
# Usage: cmake -DFILE=<binary> -P CleanRunpath.cmake

file(READ_ELF "${FILE}" RUNPATH runpath)
if(NOT runpath)
  return()
endif()

string(REPLACE ":" ";" entries "${runpath}")
set(cleaned "")
foreach(entry IN LISTS entries)
  if(NOT entry STREQUAL "")
    list(APPEND cleaned "${entry}")
  endif()
endforeach()
list(JOIN cleaned ":" cleaned)

if(NOT cleaned STREQUAL runpath)
  file(RPATH_SET FILE "${FILE}" NEW_RPATH "${cleaned}")
endif()
