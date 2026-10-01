#pragma once

#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <sys/prctl.h>
#include <sys/wait.h>
#include <unistd.h>

#include <cerrno>
#include <chrono>
#include <functional>
#include <string>
#include <vector>

namespace biopass {

// No helper output reaches the PAM caller's stdio. Status is a private, bounded
// line channel; the caller decides whether to turn it into PAM conversations.
inline int runAuthHelper(const std::string& executable, const std::vector<std::string>& arguments,
                         std::chrono::milliseconds timeout,
                         const std::function<bool(const std::string&)>& on_status = {}) {
  int channel[2];
  if (pipe2(channel, O_CLOEXEC | O_NONBLOCK) != 0)
    return -1;
  for (int& fd : channel) {
    if (fd <= 2) {
      const int moved = fcntl(fd, F_DUPFD_CLOEXEC, 3);
      if (moved < 0) {
        close(channel[0]);
        close(channel[1]);
        return -1;
      }
      close(fd);
      fd = moved;
    }
  }
  std::vector<std::string> values{executable};
  values.insert(values.end(), arguments.begin(), arguments.end());
  values.push_back("--status-fd");
  values.push_back(std::to_string(channel[1]));
  std::vector<char*> argv;
  for (auto& value : values) argv.push_back(value.data());
  argv.push_back(nullptr);
  const pid_t parent_pid = getpid();
  const pid_t pid = fork();
  if (pid == 0) {
    if (prctl(PR_SET_PDEATHSIG, SIGKILL) != 0 || getppid() != parent_pid)
      _exit(1);
    if (setpgid(0, 0) != 0)
      _exit(1);
    close(channel[0]);
    if (fcntl(channel[1], F_SETFD, 0) < 0)
      _exit(1);
    const int null_fd = open("/dev/null", O_RDWR);
    if (null_fd < 0)
      _exit(1);
    for (int fd = 0; fd <= 2; ++fd)
      if (dup2(null_fd, fd) < 0)
        _exit(1);
    if (null_fd > 2)
      close(null_fd);
    execv(executable.c_str(), argv.data());
    _exit(1);
  }
  close(channel[1]);
  if (pid < 0) {
    close(channel[0]);
    return -1;
  }
  // Also establish the process group from the parent to close the fork race.
  setpgid(pid, pid);
  const auto deadline = std::chrono::steady_clock::now() + timeout;
  std::string pending;
  int result = -1;
  bool finished = false;
  bool channel_open = true;
  while (std::chrono::steady_clock::now() < deadline) {
    int status = 0;
    const pid_t waited = waitpid(pid, &status, WNOHANG);
    if (waited == pid) {
      finished = true;
      if (WIFEXITED(status))
        result = WEXITSTATUS(status);
      break;
    }
    if (waited < 0 && errno != EINTR)
      break;
    if (on_status && !on_status(""))
      break;
    pollfd fd{channel_open ? channel[0] : -1, POLLIN, 0};
    const int polled = poll(&fd, 1, 20);
    if (polled < 0 && errno != EINTR)
      break;
    if (polled > 0 && (fd.revents & (POLLIN | POLLHUP))) {
      char buffer[256];
      const ssize_t size = read(channel[0], buffer, sizeof(buffer));
      if (size > 0) {
        pending.append(buffer, size);
        if (pending.size() > 1024)
          break;
        size_t newline;
        while ((newline = pending.find('\n')) != std::string::npos) {
          const auto line = pending.substr(0, newline);
          pending.erase(0, newline + 1);
          if (on_status && !on_status(line))
            goto done;
        }
      } else if (size == 0)
        channel_open = false;
      else if (errno != EAGAIN && errno != EINTR)
        break;
    }
  }
done:
  close(channel[0]);
  if (!finished) {
    kill(-pid, SIGTERM);
    kill(pid, SIGTERM);
    const auto grace = std::chrono::steady_clock::now() + std::chrono::milliseconds(200);
    while (std::chrono::steady_clock::now() < grace) {
      int status;
      const auto waited = waitpid(pid, &status, WNOHANG);
      if (waited == pid || (waited < 0 && errno == ECHILD)) {
        finished = true;
        break;
      }
      poll(nullptr, 0, 10);
    }
    // Kill any descendants even if the main helper already terminated.
    kill(-pid, SIGKILL);
    if (!finished) {
      kill(pid, SIGKILL);
      int status;
      while (waitpid(pid, &status, 0) < 0 && errno == EINTR) {
      }
    }
  }
  return result;
}

}  // namespace biopass
