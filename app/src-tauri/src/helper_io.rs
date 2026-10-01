//! Bounded helper protocol reads and guaranteed child cleanup.
use std::io::{self, BufRead, BufReader, Read};
use std::os::fd::AsRawFd;
use std::os::unix::process::CommandExt;
use std::process::{Child, ChildStdout, Command};
use std::time::{Duration, Instant};

pub(crate) fn configure_helper(command: &mut Command) {
    let parent = std::process::id() as libc::pid_t;
    // Only async-signal-safe syscalls run between fork and exec.
    unsafe {
        command.pre_exec(move || {
            if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL) != 0 {
                return Err(io::Error::last_os_error());
            }
            if libc::getppid() != parent {
                return Err(io::Error::from_raw_os_error(libc::ESRCH));
            }
            Ok(())
        });
    }
}

pub(crate) struct ManagedChild(pub Child);
impl Drop for ManagedChild {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

pub(crate) struct DeadlineReader {
    stdout: ChildStdout,
    deadline: Instant,
}
impl DeadlineReader {
    pub fn new(stdout: ChildStdout, timeout: Duration) -> Self {
        Self {
            stdout,
            deadline: Instant::now() + timeout,
        }
    }
    pub fn reset_deadline(&mut self, timeout: Duration) {
        self.deadline = Instant::now() + timeout;
    }
}
impl Read for DeadlineReader {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        if buffer.is_empty() {
            return Ok(0);
        }
        loop {
            let remaining = self.deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "Helper response timed out",
                ));
            }
            let mut fd = libc::pollfd {
                fd: self.stdout.as_raw_fd(),
                events: libc::POLLIN,
                revents: 0,
            };
            // poll does not consume bytes; the stdout has a single serialized reader.
            let ready = unsafe {
                libc::poll(
                    &mut fd,
                    1,
                    remaining.as_millis().clamp(1, i32::MAX as u128) as i32,
                )
            };
            if ready > 0 {
                return self.stdout.read(buffer);
            }
            if ready < 0 {
                let error = io::Error::last_os_error();
                if error.kind() != io::ErrorKind::Interrupted {
                    return Err(error);
                }
            }
        }
    }
}

pub(crate) fn read_header(reader: &mut BufReader<DeadlineReader>) -> io::Result<String> {
    let mut line = String::new();
    let length = reader.take(1024).read_line(&mut line)?;
    if length == 0 || !line.ends_with('\n') {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "Incomplete or oversized helper response",
        ));
    }
    Ok(line.trim_end_matches(['\r', '\n']).to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::{Command, Stdio};
    #[test]
    fn silent_helper_times_out_and_is_reaped() {
        let mut child = ManagedChild(
            Command::new("/bin/sh")
                .args(["-c", "exec sleep 30"])
                .stdout(Stdio::piped())
                .spawn()
                .unwrap(),
        );
        let mut reader = BufReader::new(DeadlineReader::new(
            child.0.stdout.take().unwrap(),
            Duration::from_millis(60),
        ));
        let started = Instant::now();
        assert_eq!(
            read_header(&mut reader).unwrap_err().kind(),
            io::ErrorKind::TimedOut
        );
        let pid = child.0.id() as i32;
        drop(child);
        assert!(started.elapsed() < Duration::from_secs(2));
        let mut status = 0;
        assert_eq!(
            unsafe { libc::waitpid(pid, &mut status, libc::WNOHANG) },
            -1
        );
    }
    #[test]
    fn rejects_oversized_and_incomplete_headers() {
        for command in ["printf READY", "printf '%01025d' 0"] {
            let mut child = ManagedChild(
                Command::new("/bin/sh")
                    .args(["-c", command])
                    .stdout(Stdio::piped())
                    .spawn()
                    .unwrap(),
            );
            let mut reader = BufReader::new(DeadlineReader::new(
                child.0.stdout.take().unwrap(),
                Duration::from_secs(1),
            ));
            assert!(read_header(&mut reader).is_err());
        }
    }
    #[test]
    fn kill_unblocks_a_reader_holding_the_io_lock() {
        let mut child = ManagedChild(
            Command::new("/bin/sh")
                .args(["-c", "exec sleep 30"])
                .stdout(Stdio::piped())
                .spawn()
                .unwrap(),
        );
        let stdout = child.0.stdout.take().unwrap();
        let (send, receive) = std::sync::mpsc::channel();
        let thread = std::thread::spawn(move || {
            let mut reader = BufReader::new(DeadlineReader::new(stdout, Duration::from_secs(30)));
            send.send(()).unwrap();
            read_header(&mut reader)
        });
        receive.recv().unwrap();
        let started = Instant::now();
        drop(child);
        assert!(thread.join().unwrap().is_err());
        assert!(started.elapsed() < Duration::from_secs(2));
    }
}
