//! Async helper protocol with bounded responses and explicit process cleanup.
use std::io;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, BufReader};
use tokio::process::{Child, Command};
use tokio::time::timeout;

pub(crate) fn configure_helper(command: &mut Command) {
    command.kill_on_drop(true);
    let parent = std::process::id() as libc::pid_t;
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

pub(crate) async fn terminate_helper(child: &mut Child) {
    let _ = child.start_kill();
    let _ = timeout(Duration::from_secs(2), child.wait()).await;
}

pub(crate) async fn read_header<R: AsyncRead + Unpin>(
    reader: &mut BufReader<R>,
) -> io::Result<String> {
    let mut bytes = Vec::new();
    let length = reader.take(1024).read_until(b'\n', &mut bytes).await?;
    if length == 0 || bytes.last() != Some(&b'\n') {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "Incomplete or oversized helper response",
        ));
    }
    let line = String::from_utf8(bytes)
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "Invalid helper response"))?;
    Ok(line.trim_end_matches(['\r', '\n']).to_owned())
}

pub(crate) async fn output(
    mut command: Command,
    limit: Duration,
) -> Result<std::process::Output, String> {
    configure_helper(&mut command);
    command
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    let mut child = command
        .spawn()
        .map_err(|e| format!("Failed to start helper: {e}"))?;
    let stdout = child.stdout.take().ok_or("Missing helper stdout")?;
    let stderr = child.stderr.take().ok_or("Missing helper stderr")?;
    let result = timeout(limit, async {
        let (status, stdout, stderr) =
            tokio::try_join!(child.wait(), bounded_output(stdout), bounded_output(stderr))?;
        Ok::<_, io::Error>(std::process::Output {
            status,
            stdout,
            stderr,
        })
    })
    .await;
    match result {
        Ok(Ok(output)) => Ok(output),
        failure => {
            terminate_helper(&mut child).await;
            match failure {
                Err(_) => Err("Helper did not respond in time".into()),
                Ok(Err(error)) => Err(format!("Failed to read helper response: {error}")),
                _ => unreachable!(),
            }
        }
    }
}

async fn bounded_output(reader: impl AsyncRead + Unpin) -> io::Result<Vec<u8>> {
    const MAX: u64 = 2 * 1024 * 1024;
    let mut bytes = Vec::new();
    reader.take(MAX + 1).read_to_end(&mut bytes).await?;
    if bytes.len() as u64 > MAX {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "Oversized helper output",
        ));
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Stdio;
    #[tokio::test]
    async fn rejects_oversized_and_incomplete_headers() {
        for bytes in [vec![b'x'; 1025], b"READY".to_vec(), vec![255, b'\n']] {
            assert!(read_header(&mut BufReader::new(bytes.as_slice()))
                .await
                .is_err());
        }
        assert_eq!(
            read_header(&mut BufReader::new(b"READY\nOK\n".as_slice()))
                .await
                .unwrap(),
            "READY"
        );
    }
    #[tokio::test]
    async fn silent_helper_times_out_and_is_reaped() {
        let mut command = Command::new("/bin/sh");
        command
            .arg("-c")
            .arg("exec sleep 10")
            .stdout(Stdio::piped());
        configure_helper(&mut command);
        let mut child = command.spawn().unwrap();
        let mut reader = BufReader::new(child.stdout.take().unwrap());
        assert!(timeout(Duration::from_millis(50), read_header(&mut reader))
            .await
            .is_err());
        terminate_helper(&mut child).await;
        assert!(child.try_wait().unwrap().is_some());
    }
    #[tokio::test]
    async fn killing_helper_unblocks_response_reader() {
        let mut command = Command::new("/bin/sh");
        command
            .arg("-c")
            .arg("exec sleep 10")
            .stdout(Stdio::piped());
        configure_helper(&mut command);
        let mut child = command.spawn().unwrap();
        let mut reader = BufReader::new(child.stdout.take().unwrap());
        let reading = tokio::spawn(async move { read_header(&mut reader).await });
        terminate_helper(&mut child).await;
        assert!(timeout(Duration::from_secs(1), reading)
            .await
            .unwrap()
            .unwrap()
            .is_err());
    }
}
