#include <security/pam_appl.h>
#include <security/pam_ext.h>
#include <security/pam_modules.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>

#include <charconv>
#include <cstring>

#include "auth_hint.h"
#include "helper_process.h"

// Called by PAM when a user needs to be authenticated
PAM_EXTERN int pam_sm_authenticate(pam_handle_t* pamh, int flags, int argc, const char** argv) {
  int retval;

  const char* service = nullptr;
  retval = pam_get_item(pamh, PAM_SERVICE, (const void**)&service);
  if (retval != PAM_SUCCESS) {
    service = nullptr;
  }

  const char* pUsername;
  retval = pam_get_user(pamh, &pUsername, NULL);
  if (retval != PAM_SUCCESS) {
    return retval;
  }

  unsigned timeout_ms = 30000;
  for (int i = 0; i < argc; ++i) {
    constexpr const char* prefix = "timeout_ms=";
    if (strncmp(argv[i], prefix, strlen(prefix)) == 0) {
      const char* first = argv[i] + strlen(prefix);
      unsigned value = 0;
      const auto parsed = std::from_chars(first, first + strlen(first), value);
      if (parsed.ec != std::errc{} || *parsed.ptr != '\0' || value < 100 || value > 300000)
        return PAM_AUTH_ERR;
      timeout_ms = value;
    }
  }
  std::vector<std::string> arguments{"auth", "--username", pUsername};
  const bool gnome = !(flags & PAM_SILENT) && service && strcmp(service, "gdm-password") == 0;
  if (service && service[0]) {
    arguments.push_back("--service");
    arguments.push_back(service);
  }
  biopass::AuthHint hint(gnome);
  const int exit_code =
      biopass::runAuthHelper("/usr/bin/biopass-helper", arguments,
                             std::chrono::milliseconds(timeout_ms), [&](const std::string& status) {
                               // One optional hint when the first authentication method starts.
                               // Success messages are deliberately omitted: GNOME queues them and
                               // delays unlock.
                               const char* message = hint.update(status);
                               if (!message)
                                 return true;
                               return pam_info(pamh, "%s", message) == PAM_SUCCESS;
                             });
  if (exit_code == 0)
    return PAM_SUCCESS;
  if (exit_code == 2)
    return PAM_IGNORE;
  return PAM_AUTH_ERR;
}

// The functions below are required by PAM, but not needed in this module
PAM_EXTERN int pam_sm_open_session(pam_handle_t* pamh, int flags, int argc, const char** argv) {
  (void)pamh;
  (void)flags;
  (void)argc;
  (void)argv;
  return PAM_IGNORE;
}

PAM_EXTERN int pam_sm_acct_mgmt(pam_handle_t* pamh, int flags, int argc, const char** argv) {
  (void)pamh;
  (void)flags;
  (void)argc;
  (void)argv;
  return PAM_IGNORE;
}

PAM_EXTERN int pam_sm_close_session(pam_handle_t* pamh, int flags, int argc, const char** argv) {
  (void)pamh;
  (void)flags;
  (void)argc;
  (void)argv;
  return PAM_IGNORE;
}

PAM_EXTERN int pam_sm_chauthtok(pam_handle_t* pamh, int flags, int argc, const char** argv) {
  (void)pamh;
  (void)flags;
  (void)argc;
  (void)argv;
  return PAM_IGNORE;
}

PAM_EXTERN int pam_sm_setcred(pam_handle_t* pamh, int flags, int argc, const char** argv) {
  (void)pamh;
  (void)flags;
  (void)argc;
  (void)argv;
  return PAM_IGNORE;
}
