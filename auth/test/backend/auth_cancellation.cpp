#include <chrono>
#include <stdexcept>

#include "auth_manager.h"

struct Method : biopass::IAuthMethod {
  bool winner;
  std::atomic<bool>& retry_started;
  std::atomic<bool>& cleaned;
  Method(bool success, std::atomic<bool>& started, std::atomic<bool>& ended)
      : winner(success), retry_started(started), cleaned(ended) {}
  std::string name() const override { return winner ? "Winner" : "Retry"; }
  bool isAvailable() const override { return true; }
  uint32_t getRetries() const override { return 2; }
  uint32_t getRetryDelayMs() const override { return 10000; }
  void endAuthenticationSession() override { cleaned.store(true); }
  biopass::AuthResult authenticate(const std::string&, const biopass::AuthConfig&,
                                   std::atomic<bool>*) override {
    if (!winner) {
      retry_started.store(true);
      return biopass::AuthResult::Retry;
    }
    while (!retry_started.load()) std::this_thread::yield();
    std::this_thread::sleep_for(std::chrono::milliseconds(80));
    return biopass::AuthResult::Success;
  }
};
int main() {
  std::atomic<bool> retry_started{false}, first_cleaned{false}, second_cleaned{false};
  biopass::AuthManager manager;
  manager.addMethod(std::make_unique<Method>(false, retry_started, first_cleaned));
  manager.addMethod(std::make_unique<Method>(true, retry_started, second_cleaned));
  const auto start = std::chrono::steady_clock::now();
  if (manager.authenticate("test") != PAM_SUCCESS ||
      std::chrono::steady_clock::now() - start > std::chrono::seconds(2) || !first_cleaned ||
      !second_cleaned)
    throw std::runtime_error("Winning method did not cancel retry delay and clean sessions");
}
