#pragma once
#include <chrono>
#include <string_view>

namespace biopass {

class AuthHint {
 public:
  explicit AuthHint(bool enabled) : enabled_(enabled) {}
  const char* update(std::string_view status, std::chrono::milliseconds elapsed) {
    if (!enabled_ || shown_)
      return nullptr;
    face_ |= status == "FACE";
    fingerprint_ |= status == "FINGERPRINT";
    if (elapsed < std::chrono::seconds(2) || (!face_ && !fingerprint_))
      return nullptr;
    shown_ = true;
    if (face_ && fingerprint_)
      return "Look at the camera or touch the fingerprint reader";
    return face_ ? "Look at the camera" : "Touch the fingerprint reader";
  }

 private:
  bool enabled_, shown_ = false, face_ = false, fingerprint_ = false;
};

}  // namespace biopass
