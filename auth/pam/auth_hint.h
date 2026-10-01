#pragma once
#include <string_view>

namespace biopass {

class AuthHint {
 public:
  explicit AuthHint(bool enabled) : enabled_(enabled) {}
  const char* update(std::string_view status) {
    if (!enabled_ || shown_)
      return nullptr;
    const char* message = nullptr;
    if (status == "FACE")
      message = "Look at the camera";
    else if (status == "FINGERPRINT")
      message = "Touch the fingerprint reader";
    if (message)
      shown_ = true;
    return message;
  }

 private:
  bool enabled_, shown_ = false;
};

}  // namespace biopass
