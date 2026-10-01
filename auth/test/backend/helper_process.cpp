#include "helper_process.h"

#include <chrono>
#include <iostream>
#include <stdexcept>

#include "auth_hint.h"

void require(bool condition, const char* message) {
  if (!condition)
    throw std::runtime_error(message);
}
int main(int argc, char** argv) {
  if (argc > 1) {
    const std::string mode = argv[1];
    const int status_fd = std::stoi(argv[argc - 1]);
    if (mode == "parent-death") {
      int value = 0;
      return prctl(PR_GET_PDEATHSIG, &value) == 0 && value == SIGKILL ? 0 : 1;
    }
    if (mode == "success")
      return 0;
    if (mode == "ignore")
      return 2;
    if (mode == "failure")
      return 1;
    if (mode == "status") {
      write(status_fd, "FACE\n", 5);
      usleep(50000);
      return 0;
    }
    if (mode == "hang") {
      signal(SIGTERM, SIG_IGN);
      sleep(30);
      return 0;
    }
    if (mode == "cancel") {
      write(status_fd, "FACE\n", 5);
      sleep(30);
      return 0;
    }
    return 9;
  }
  using namespace std::chrono;
  biopass::AuthHint hint(true), fingerprint(true), disabled(false), unknown(true);
  require(!hint.update(""), "empty status became a hint");
  require(!disabled.update("FACE"), "disabled hints were shown");
  require(!unknown.update("untrusted arbitrary text"), "unknown status became a hint");
  require(std::string(hint.update("FACE")) == "Look at the camera",
          "camera hint was not immediate");
  require(std::string(fingerprint.update("FINGERPRINT")) == "Touch the fingerprint reader",
          "fingerprint hint was not immediate");
  require(!hint.update("FACE") && !hint.update("FINGERPRINT"), "hint repeated");
  const std::string self = "/proc/self/exe";
  require(biopass::runAuthHelper(self, {"parent-death"}, seconds(1)) == 0,
          "parent-death cleanup is not armed");
  require(biopass::runAuthHelper(self, {"success"}, seconds(1)) == 0, "success lost");
  require(biopass::runAuthHelper(self, {"ignore"}, seconds(1)) == 2, "PAM_IGNORE lost");
  require(biopass::runAuthHelper(self, {"failure"}, seconds(1)) == 1, "failure lost");
  require(biopass::runAuthHelper("/not/a/helper", {}, seconds(1)) != 0,
          "exec failure became success");
  bool received = false;
  require(biopass::runAuthHelper(self, {"status"}, seconds(1),
                                 [&](const std::string& line) {
                                   received |= line == "FACE";
                                   return true;
                                 }) == 0 &&
              received,
          "status not delivered");
  auto start = steady_clock::now();
  require(biopass::runAuthHelper(self, {"hang"}, milliseconds(80)) != 0, "timeout became success");
  require(steady_clock::now() - start < seconds(2), "SIGTERM-resistant helper was not killed");
  start = steady_clock::now();
  require(biopass::runAuthHelper(self, {"cancel"}, seconds(30),
                                 [](const std::string& line) { return line.empty(); }) != 0,
          "cancel became success");
  require(steady_clock::now() - start < seconds(2), "cancel did not terminate helper");
  int status;
  require(waitpid(-1, &status, WNOHANG) == -1 && errno == ECHILD, "helper zombie leaked");
  std::cout << "Helper exit codes, status channel, timeout, cancellation and reaping passed\n";
}
